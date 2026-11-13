// The WATCH registry (spec 9.10, step 3), checked through the Db hooks that drive it. The
// expected outcomes were taken from the redis:7.4 reference server with two connections.
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Client } from '../../src/server/client.js';
import { Server } from '../../src/server/server.js';
import { createStringObject } from '../../src/storage/redis-object.js';
import { isWatchedKeyExpired, unwatchAllKeys, watchKey } from '../../src/storage/watch.js';

// A server that never listens, and clients with no real socket: the registry needs neither.
const fakeSocket = {
  remoteAddress: '127.0.0.1',
  remotePort: 1,
  localAddress: '127.0.0.1',
  localPort: 2,
} as unknown as Socket;
let nextId = 1;
const newClient = () =>
  new Client(nextId++, fakeSocket, {
    maxBulkLen: () => 1 << 20,
    authRequired: () => false,
  });
const setup = () => {
  const server = new Server({ log: () => {}, seed: 1 });
  return { server, db: server.dbs[0]!, other: server.dbs[1]!, a: newClient(), b: newClient() };
};

describe('WATCH registry (spec 9.10)', () => {
  it('registers a key once per client, however often it is watched', () => {
    const { db, a } = setup();
    watchKey(a, db, 'k');
    watchKey(a, db, 'k');
    expect(a.watchedKeys).toHaveLength(1);
    expect(db.watched.get('k')?.size).toBe(1);
  });

  it('a change marks every watcher dirty and unwatches them', () => {
    const { db, a, b } = setup();
    watchKey(a, db, 'k');
    watchKey(a, db, 'other');
    watchKey(b, db, 'k');
    db.add('k', createStringObject('v'));
    db.signalModifiedKey('k');
    expect(a.dirtyCas).toBe(true);
    expect(b.dirtyCas).toBe(true);
    // Once dirty there is nothing left to watch for (Redis 7's touchWatchedKey does the same).
    expect(a.watchedKeys).toEqual([]);
    expect(db.watched.size).toBe(0);
  });

  it('a change in another db, or to another key, leaves the watcher clean', () => {
    const { db, other, a } = setup();
    watchKey(a, db, 'k');
    other.add('k', createStringObject('v'));
    other.signalModifiedKey('k');
    db.add('x', createStringObject('v'));
    db.signalModifiedKey('x');
    expect(a.dirtyCas).toBe(false);
  });

  it('unwatchAllKeys forgets the client everywhere and drops empty entries', () => {
    const { db, other, a, b } = setup();
    watchKey(a, db, 'k');
    watchKey(a, other, 'k');
    watchKey(b, db, 'k');
    unwatchAllKeys(a);
    expect(a.watchedKeys).toEqual([]);
    expect(other.watched.size).toBe(0);
    expect([...db.watched.get('k')!.keys()]).toEqual([b]);
  });

  it('expiry of a watched key is a change', () => {
    const { server, db, a } = setup();
    db.add('k', createStringObject('v'));
    db.setExpire('k', 1000);
    server.cmdTime = 500;
    watchKey(a, db, 'k');
    server.cmdTime = 2000;
    expect(isWatchedKeyExpired(a)).toBe(true);
    expect(db.peek('k')).toBeNull(); // the lazy delete touches the watcher too
    expect(a.dirtyCas).toBe(true);
  });

  it('a key already expired at WATCH time only counts if it comes back', () => {
    const { server, db, a, b } = setup();
    for (const c of [a, b]) {
      db.add(`k${c.id}`, createStringObject('v'));
      db.setExpire(`k${c.id}`, 1000);
    }
    server.cmdTime = 2000;
    watchKey(a, db, `k${a.id}`);
    watchKey(b, db, `k${b.id}`);
    expect(isWatchedKeyExpired(a)).toBe(false);
    // Deleting the dead key is no logical change, and clears the flag...
    expect(db.peek(`k${a.id}`)).toBeNull();
    expect(db.peek(`k${b.id}`)).toBeNull();
    expect(a.dirtyCas).toBe(false);
    expect(a.watchedKeys[0]!.expired).toBe(false);
    // ...so bringing the key back afterwards is a change.
    db.add(`k${b.id}`, createStringObject('new'));
    db.signalModifiedKey(`k${b.id}`);
    expect(b.dirtyCas).toBe(true);
    expect(a.dirtyCas).toBe(false);
  });

  it('a flush touches only watched keys that existed', () => {
    const { db, a, b } = setup();
    db.add('k', createStringObject('v'));
    watchKey(a, db, 'k');
    watchKey(b, db, 'missing');
    db.flush();
    expect(a.dirtyCas).toBe(true);
    expect(b.dirtyCas).toBe(false);
  });

  it('a flush of a key already expired at WATCH time is no change', () => {
    const { server, db, a } = setup();
    db.add('k', createStringObject('v'));
    db.setExpire('k', 1000);
    server.cmdTime = 2000;
    watchKey(a, db, 'k');
    db.flush();
    expect(a.dirtyCas).toBe(false);
  });
});
