import { describe, expect, it } from 'vitest';
import { lruClockNow } from '../../src/server/cron.js';
import { Server } from '../../src/server/server.js';
import { createStringObject } from '../../src/storage/redis-object.js';

// A server that never listens: Db only needs its stats, clocks and dict options.
const newDb = () => {
  const server = new Server({ log: () => {}, seed: 1 });
  return { server, db: server.dbs[0]! };
};

describe('Db (spec 6.1)', () => {
  it('has one Db per configured database, numbered from 0', () => {
    const { server } = newDb();
    expect(server.dbs).toHaveLength(16);
    expect(server.dbs.map((d) => d.id)).toEqual([...Array(16).keys()]);
  });

  it('lookupRead counts hits and misses and touches the LRU clock', () => {
    const { server, db } = newDb();
    db.add('k', createStringObject('v'));
    server.lruClock = 1234;
    expect(db.lookupRead('k')?.value).toBe('v');
    expect(db.lookupRead('nope')).toBeNull();
    expect(server.stats).toMatchObject({ keyspaceHits: 1, keyspaceMisses: 1 });
    expect(db.peek('k')!.lru).toBe(1234);
  });

  it('peek and lookupWrite leave the stats alone', () => {
    const { server, db } = newDb();
    db.add('k', createStringObject('v'));
    server.lruClock = 1;
    expect(db.peek('k')?.value).toBe('v');
    expect(db.peek('k')!.lru).not.toBe(1);
    expect(db.lookupWrite('k')?.value).toBe('v');
    expect(db.lookupWrite('nope')).toBeNull();
    expect(server.stats).toMatchObject({ keyspaceHits: 0, keyspaceMisses: 0 });
  });

  it('add refuses an existing key; setKey replaces', () => {
    const { db } = newDb();
    db.add('k', createStringObject('1'));
    expect(() => db.add('k', createStringObject('2'))).toThrow();
    db.setKey('k', createStringObject('3'));
    expect(db.peek('k')?.value).toBe('3');
    expect(db.size).toBe(1);
  });

  it('setKey drops the TTL unless keepTtl; delete drops it too', () => {
    const { db } = newDb();
    db.add('k', createStringObject('1'));
    db.expires.set('k', Date.now() + 10_000);
    db.setKey('k', createStringObject('2'), { keepTtl: true });
    expect(db.expires.has('k')).toBe(true);
    db.setKey('k', createStringObject('3'));
    expect(db.expires.has('k')).toBe(false);
    db.expires.set('k', Date.now() + 10_000);
    expect(db.delete('k')).toBe(true);
    expect(db.expires.has('k')).toBe(false);
    expect(db.delete('k')).toBe(false);
  });

  it('signalModifiedKey counts changes in server.dirty', () => {
    const { server, db } = newDb();
    db.signalModifiedKey('a');
    db.signalModifiedKey('b');
    expect(server.dirty).toBe(2);
  });

  it('cron finishes a rehash that operations alone left running', () => {
    const { db } = newDb();
    for (let i = 0; i < 1000; i++) db.setKey(`k${i}`, createStringObject('v'));
    while (!db.dict.isRehashing) db.setKey(`more${db.size}`, createStringObject('v'));
    db.cron(1000);
    expect(db.dict.isRehashing).toBe(false);
    db.dict.check();
  });

  it('flush removes every key and TTL and returns how many', () => {
    const { db } = newDb();
    for (let i = 0; i < 50; i++) db.setKey(`k${i}`, createStringObject('v'));
    db.expires.set('k1', Date.now() + 10_000);
    expect(db.flush()).toBe(50);
    expect(db.size).toBe(0);
    expect(db.expires.size).toBe(0);
    expect(db.flush()).toBe(0);
  });

  it('randomKey returns a live key, or null when empty', () => {
    const { db } = newDb();
    expect(db.randomKey()).toBeNull();
    db.add('only', createStringObject('v'));
    expect(db.randomKey()).toBe('only');
  });

  it('rename moves the value and keeps the TTL', () => {
    const { db } = newDb();
    db.add('a', createStringObject('1'));
    db.add('b', createStringObject('old'));
    db.expires.set('a', 12345);
    db.rename('a', 'b');
    expect(db.peek('a')).toBeNull();
    expect(db.peek('b')?.value).toBe('1');
    expect(db.expires.get('b')).toBe(12345);
    expect(db.expires.has('a')).toBe(false);
  });

  it('rename drops the destination TTL when the source has none', () => {
    const { db } = newDb();
    db.add('a', createStringObject('1'));
    db.add('b', createStringObject('2'));
    db.expires.set('b', 999);
    db.rename('a', 'b');
    expect(db.expires.has('b')).toBe(false);
  });

  it('the LRU clock is Unix seconds in 24 bits', () => {
    expect(lruClockNow(0)).toBe(0);
    expect(lruClockNow(1000 * 0x1000000 + 5000)).toBe(5);
  });
});
