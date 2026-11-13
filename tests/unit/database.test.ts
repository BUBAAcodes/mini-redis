import { describe, expect, it } from 'vitest';
import { lruClockNow } from '../../src/server/cron.js';
import { Server } from '../../src/server/server.js';
import type { PropagationRecord } from '../../src/server/propagate.js';
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
    db.expires.set('a', 4_000_000_000_000);
    db.rename('a', 'b');
    expect(db.peek('a')).toBeNull();
    expect(db.peek('b')?.value).toBe('1');
    expect(db.expires.get('b')).toBe(4_000_000_000_000);
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

describe('Db expiry (spec 9.3, step 7)', () => {
  // cmdTime is the clock every lazy check reads (spec 7.5); tests set it by hand.
  const withSink = () => {
    const { server, db } = newDb();
    const records: PropagationRecord[] = [];
    server.propagator.attach({ append: (r) => records.push(r) });
    server.cmdTime = 1_000_000;
    return { server, db, records };
  };

  it('setExpire, getExpire and removeExpire', () => {
    const { db } = withSink();
    db.add('k', createStringObject('v'));
    expect(db.getExpire('k')).toBe(-1);
    db.setExpire('k', 2_000_000);
    expect(db.getExpire('k')).toBe(2_000_000);
    expect(db.removeExpire('k')).toBe(true);
    expect(db.removeExpire('k')).toBe(false);
    expect(db.getExpire('k')).toBe(-1);
    expect(db.getExpire('nope')).toBe(-1);
    expect(() => db.setExpire('nope', 1)).toThrow();
  });

  it('a key is expired only once cmdTime is past its deadline', () => {
    const { server, db } = withSink();
    db.add('k', createStringObject('v'));
    db.setExpire('k', 1_000_500);
    server.cmdTime = 1_000_500;
    expect(db.lookupRead('k')?.value).toBe('v');
    server.cmdTime = 1_000_501;
    expect(db.lookupRead('k')).toBeNull();
  });

  it('every lookup expires lazily: deletes, counts, propagates DEL, leaves dirty alone', () => {
    for (const lookup of ['lookupRead', 'lookupWrite', 'peek'] as const) {
      const { server, db, records } = withSink();
      db.add('k', createStringObject('v'));
      db.setExpire('k', server.cmdTime - 1);
      expect(db[lookup]('k'), lookup).toBeNull();
      expect(db.size).toBe(0);
      expect(db.expires.size).toBe(0);
      expect(server.stats.expiredKeys).toBe(1);
      expect(records).toEqual([{ db: 0, argv: ['DEL', 'k'] }]);
      // A no-op write after a lazy expiry must not propagate its own record too.
      expect(server.dirty).toBe(0);
    }
  });

  it('a lazy expiry is a miss for lookupRead', () => {
    const { server, db } = withSink();
    db.add('k', createStringObject('v'));
    db.setExpire('k', 1);
    expect(db.lookupRead('k')).toBeNull();
    expect(server.stats).toMatchObject({ keyspaceHits: 0, keyspaceMisses: 1 });
  });

  it('randomKey skips (and deletes) expired keys', () => {
    const { server, db } = withSink();
    for (let i = 0; i < 100; i++) {
      db.add(`dead${i}`, createStringObject('v'));
      db.setExpire(`dead${i}`, 1);
    }
    expect(db.randomKey()).toBeNull();
    expect(db.size).toBe(0);
    expect(server.stats.expiredKeys).toBe(100);
    db.add('live', createStringObject('v'));
    db.add('dead', createStringObject('v'));
    db.setExpire('dead', 1);
    for (let i = 0; i < 20; i++) expect(db.randomKey()).toBe('live');
  });

  it('allKeys skips expired keys without deleting them; size still counts them', () => {
    const { db } = withSink();
    db.add('live', createStringObject('v'));
    db.add('dead', createStringObject('v'));
    db.setExpire('dead', 1);
    expect(db.allKeys()).toEqual(['live']);
    expect(db.size).toBe(2);
  });

  it('expireIfNeeded reports whether the key was expired', () => {
    const { db } = withSink();
    db.add('live', createStringObject('v'));
    db.setExpire('live', 9_000_000);
    db.add('dead', createStringObject('v'));
    db.setExpire('dead', 1);
    expect(db.expireIfNeeded('live')).toBe(false);
    expect(db.expireIfNeeded('dead')).toBe(true);
    expect(db.expireIfNeeded('dead')).toBe(false);
    expect(db.expireIfNeeded('nope')).toBe(false);
  });

  it('activeExpireSample deletes only the expired keys it drew', () => {
    const { server, db, records } = withSink();
    for (let i = 0; i < 10; i++) {
      db.add(`k${i}`, createStringObject('v'));
      db.setExpire(`k${i}`, i < 5 ? 10 : 9_000_000);
    }
    db.add('nottl', createStringObject('v'));
    // Independent draws, so 1,000 of them find all 5 expired keys.
    const { sampled, expired } = db.activeExpireSample(1000, 100);
    expect(sampled).toBe(1000);
    expect(expired).toBe(5);
    expect(db.size).toBe(6);
    expect(server.stats.expiredKeys).toBe(5);
    expect(records.map((r) => r.argv[0])).toEqual(Array(5).fill('DEL'));
  });

  it('activeExpireSample stops when no key with a TTL is left', () => {
    const { db } = withSink();
    db.add('k', createStringObject('v'));
    db.setExpire('k', 10);
    expect(db.activeExpireSample(20, 100)).toEqual({ sampled: 1, expired: 1 });
    expect(db.activeExpireSample(20, 100)).toEqual({ sampled: 0, expired: 0 });
  });
});
