import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EvictionPolicy } from '../../src/config.js';
import type { PropagationRecord } from '../../src/server/propagate.js';
import { Random } from '../../src/utils/random.js';
import { RespError, TestClient, encodeCommand } from '../helpers/resp-client.js';
import type { RespValue } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

const OOM = new RespError("OOM command not allowed when used memory > 'maxmemory'.");

/** Sends every command at once and reads all the replies. */
async function pipeline(c: TestClient, commands: readonly string[][]): Promise<RespValue[]> {
  c.write(commands.map(encodeCommand).join(''));
  const replies: RespValue[] = [];
  for (let i = 0; i < commands.length; i++) replies.push(await c.read());
  return replies;
}

describe('maxmemory (spec 9.4, rule 14)', () => {
  let t: TestServer;
  let c: TestClient;
  let other: TestClient;
  const records: PropagationRecord[] = [];

  beforeAll(async () => {
    t = await startServer({}, 7);
    t.server.propagator.attach({ append: (r) => records.push(r) });
    c = await TestClient.connect(t.port);
    other = await TestClient.connect(t.port);
  });

  beforeEach(async () => {
    await c.call('CONFIG', 'SET', 'maxmemory', '0');
    await c.call('FLUSHALL');
    records.length = 0;
  });

  afterAll(async () => {
    c.socket.destroy();
    other.socket.destroy();
    await t.close();
  });

  /** Sets maxmemory to what's used now, plus `extra` bytes. */
  const limitToCurrent = async (policy: EvictionPolicy, extra = 0): Promise<void> => {
    await c.call('CONFIG', 'SET', 'maxmemory-policy', policy);
    await c.call('CONFIG', 'SET', 'maxmemory', String(t.server.usedMemory + extra));
  };

  describe('noeviction', () => {
    it('refuses denyoom commands with -OOM and changes nothing; reads and DEL still work', async () => {
      await pipeline(
        c,
        Array.from({ length: 10 }, (_, i) => ['SET', `k${i}`, 'x'.repeat(100)]),
      );
      await limitToCurrent('noeviction');
      await c.call('SET', 'k0', 'x'.repeat(200));
      expect(await c.call('SET', 'new', 'v')).toEqual(OOM);
      expect(await c.call('RPUSH', 'list', 'a')).toEqual(OOM);
      expect(await c.call('EXISTS', 'new', 'list')).toBe(0);
      expect(await c.call('GET', 'k1')).toBe('x'.repeat(100));
      expect(await c.call('DEL', 'k1', 'k2')).toBe(2);
      expect(await c.call('EXPIRE', 'k3', '100')).toBe(1);
      // DEL freed enough: writes work again.
      expect(await c.call('SET', 'new', 'v')).toBe('OK');
      expect(t.server.stats.evictedKeys).toBe(0);
    });

    it('in MULTI, refuses a denyoom command at queue time and aborts EXEC', async () => {
      await c.call('SET', 'k', 'x'.repeat(100));
      await limitToCurrent('noeviction');
      await c.call('APPEND', 'k', 'more');
      expect(await c.call('MULTI')).toBe('OK');
      expect(await c.call('GET', 'k')).toBe('QUEUED');
      expect(await c.call('SET', 'y', '1')).toEqual(OOM);
      expect(await c.call('EXEC')).toEqual(
        new RespError('EXECABORT Transaction discarded because of previous errors.'),
      );
    });

    it('checks an EXEC holding a denyoom command when EXEC runs', async () => {
      await c.call('SET', 'k', 'x'.repeat(100));
      expect(await c.call('MULTI')).toBe('OK');
      expect(await c.call('SET', 'y', '1')).toBe('QUEUED');
      await other.call('CONFIG', 'SET', 'maxmemory', '1');
      expect(await c.call('EXEC')).toEqual(
        new RespError(`EXECABORT Transaction discarded because of: ${OOM.message}`),
      );
      expect(await c.call('EXISTS', 'y')).toBe(0);
      // A transaction of reads runs.
      expect(await c.call('MULTI')).toBe('OK');
      expect(await c.call('GET', 'k')).toBe('QUEUED');
      expect(await c.call('EXEC')).toEqual(['x'.repeat(100)]);
    });
  });

  it('allkeys-lru: writing 200 MB keeps used_memory within 50 MB plus one command', async () => {
    const limit = 50 * 1024 * 1024;
    await c.call('CONFIG', 'SET', 'maxmemory-policy', 'allkeys-lru');
    await c.call('CONFIG', 'SET', 'maxmemory', '50mb');
    const value = 'v'.repeat(10_000);
    // One command's share: its value, its key and every overhead, generously.
    const oneCommand = value.length + 1_000;
    let maxSeen = 0;
    for (let batch = 0; batch < 40; batch++) {
      const replies = await pipeline(
        c,
        Array.from({ length: 500 }, (_, i) => ['SET', `key:${batch}:${i}`, value]),
      );
      expect(replies.every((r) => r === 'OK')).toBe(true);
      maxSeen = Math.max(maxSeen, t.server.usedMemory);
    }
    expect(maxSeen).toBeLessThanOrEqual(limit + oneCommand);
    expect(t.server.usedMemory).toBeLessThanOrEqual(limit + oneCommand);
    expect(t.server.usedMemory).toBeGreaterThan(limit * 0.9);
    const info = String(await c.call('INFO', 'memory'));
    expect(Number(/^used_memory:(\d+)/m.exec(info)![1])).toBeLessThanOrEqual(limit + oneCommand);
    expect(t.server.stats.evictedKeys).toBeGreaterThan(10_000);
    expect(await c.call('DBSIZE')).toBe(20_000 - t.server.stats.evictedKeys);
  }, 60_000);

  it.each(['volatile-lru', 'volatile-lfu', 'volatile-random', 'volatile-ttl'] as const)(
    '%s evicts only keys with a TTL, and gives -OOM once none is left',
    async (policy) => {
      const evictedBefore = t.server.stats.evictedKeys;
      const commands: string[][] = [];
      for (let i = 0; i < 50; i++) commands.push(['SET', `keep${i}`, 'x'.repeat(100)]);
      for (let i = 0; i < 50; i++) commands.push(['SET', `ttl${i}`, 'x'.repeat(100), 'EX', '1000']);
      await pipeline(c, commands);
      await limitToCurrent(policy);
      let oom = false;
      for (let i = 0; i < 200 && !oom; i++) {
        const reply = await c.call('SET', `new${i}`, 'x'.repeat(100));
        if (reply instanceof RespError) {
          expect(reply).toEqual(OOM);
          oom = true;
        } else expect(reply).toBe('OK');
      }
      expect(oom).toBe(true);
      expect(t.server.stats.evictedKeys - evictedBefore).toBe(50);
      expect(await c.call('EXISTS', ...Array.from({ length: 50 }, (_, i) => `keep${i}`))).toBe(50);
      expect(await c.call('EXISTS', ...Array.from({ length: 50 }, (_, i) => `ttl${i}`))).toBe(0);
    },
  );

  it('volatile-ttl evicts the soonest expiry first', async () => {
    const commands: string[][] = [];
    for (let i = 0; i < 40; i++) {
      commands.push(['SET', `t${i}`, 'x'.repeat(100), 'EX', String(1000 + i * 100)]);
    }
    await pipeline(c, commands);
    // Sampling every key makes the pick exact; the default 5 samples only approximate it.
    await c.call('CONFIG', 'SET', 'maxmemory-samples', '64');
    await limitToCurrent('volatile-ttl');
    const evictedBefore = t.server.stats.evictedKeys;
    for (let i = 0; i < 10; i++) await c.call('SET', `n${i}`, 'x'.repeat(200), 'EX', '99999');
    await c.call('CONFIG', 'SET', 'maxmemory-samples', '5');
    const evicted = t.server.stats.evictedKeys - evictedBefore;
    expect(evicted).toBeGreaterThanOrEqual(10);
    const alive = await pipeline(
      c,
      Array.from({ length: 40 }, (_, i) => ['EXISTS', `t${i}`]),
    );
    expect(alive).toEqual(Array.from({ length: 40 }, (_, i) => (i < evicted ? 0 : 1)));
  });

  it('allkeys-random evicts from any db', async () => {
    await c.call('SELECT', '3');
    await pipeline(
      c,
      Array.from({ length: 50 }, (_, i) => ['SET', `d3:${i}`, 'x'.repeat(100)]),
    );
    await c.call('SELECT', '0');
    await limitToCurrent('allkeys-random');
    for (let i = 0; i < 30; i++) expect(await c.call('SET', `d0:${i}`, 'x'.repeat(100))).toBe('OK');
    expect(t.server.dbs[3]!.size).toBeLessThan(50);
    expect(t.server.dbs[0]!.size).toBeLessThan(30);
    expect(t.server.usedMemory).toBeLessThanOrEqual(t.server.config.get('maxmemory') + 1_000);
  });

  it('propagates each eviction as DEL ahead of the command, and fails a WATCH on the key', async () => {
    // No cron, so the only eviction is the one the SET below needs.
    t.server.cron.stop();
    await c.call('SET', 'victim', 'x'.repeat(100));
    await limitToCurrent('allkeys-lru');
    // Under the limit before it ran, so it ran; now over, so the next denyoom command evicts.
    await c.call('APPEND', 'victim', 'x');
    expect(await other.call('WATCH', 'victim')).toBe('OK');
    expect(await other.call('MULTI')).toBe('OK');
    expect(await other.call('PING')).toBe('QUEUED');
    records.length = 0;
    expect(await c.call('SET', 'newcomer', 'y'.repeat(100))).toBe('OK');
    expect(records).toEqual([
      { db: 0, argv: ['DEL', 'victim'] },
      { db: 0, argv: ['SET', 'newcomer', 'y'.repeat(100)] },
    ]);
    expect(await other.call('EXEC')).toBeNull();
    t.server.cron.start();
  });

  it('re-checks a served BLMOVE, as Redis does: -OOM, and the source keeps its item', async () => {
    await c.call('RPUSH', 'tmp', 'v');
    await c.call('RPUSH', 'tmp2', 'w');
    const blmove = await TestClient.connect(t.port);
    const blpop = await TestClient.connect(t.port);
    blmove.send('BLMOVE', 'src', 'dst', 'LEFT', 'RIGHT', '0');
    blpop.send('BLPOP', 'src2', '0');
    await new Promise((r) => setTimeout(r, 50));
    await c.call('CONFIG', 'SET', 'maxmemory-policy', 'noeviction');
    await c.call('CONFIG', 'SET', 'maxmemory', '1');
    // RENAME isn't denyoom, so it runs and wakes both.
    expect(await c.call('RENAME', 'tmp', 'src')).toBe('OK');
    expect(await c.call('RENAME', 'tmp2', 'src2')).toBe('OK');
    expect(await blmove.read()).toEqual(OOM);
    expect(await blpop.read()).toEqual(['src2', 'w']);
    expect(await c.call('LRANGE', 'src', '0', '-1')).toEqual(['v']);
    expect(await c.call('EXISTS', 'dst')).toBe(0);
    blmove.socket.destroy();
    blpop.socket.destroy();
  });

  it('keeps evicting in serverCron after maxmemory is lowered', async () => {
    await pipeline(
      c,
      Array.from({ length: 200 }, (_, i) => ['SET', `k${i}`, 'x'.repeat(1000)]),
    );
    await c.call('CONFIG', 'SET', 'maxmemory-policy', 'allkeys-lru');
    const target = Math.floor(t.server.usedMemory / 2);
    await c.call('CONFIG', 'SET', 'maxmemory', String(target));
    for (let i = 0; i < 50 && t.server.usedMemory > target; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(t.server.usedMemory).toBeLessThanOrEqual(target);
  });

  it('is not applied to the AOF being loaded', async () => {
    await c.call('CONFIG', 'SET', 'appendonly', 'yes');
    for (let i = 0; i < 50 && t.server.aofState !== 'on'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await pipeline(
      c,
      Array.from({ length: 50 }, (_, i) => ['SET', `k${i}`, 'x'.repeat(100)]),
    );
    await c.call('CONFIG', 'SET', 'maxmemory-policy', 'noeviction');
    await c.call('CONFIG', 'SET', 'maxmemory', '1');
    expect(await c.call('DEBUG', 'LOADAOF')).toBe('OK');
    expect(await c.call('DBSIZE')).toBe(50);
    await c.call('CONFIG', 'SET', 'maxmemory', '0');
    await c.call('CONFIG', 'SET', 'appendonly', 'no');
  });
});

describe('hot set: LRU and LFU keep what is read (spec 14, step 19)', () => {
  // A fixed dataset under insert pressure: 10% of the keys get 90% of the reads, a new key is
  // written after every read, and a key read after it was evicted stays missing. Read-through
  // on a miss would put it back, which hides most of the difference: under independent random
  // reads LRU beats random by under 10 points there (docs/walkthroughs/step-19.md).
  const KEYS = 5_000;
  const HOT = 500;
  const ROUNDS = 50;
  const READS_PER_ROUND = 1_000;

  async function hitRate(policy: EvictionPolicy): Promise<number> {
    const t = await startServer({ 'maxmemory-policy': policy }, 11);
    const c = await TestClient.connect(t.port);
    // The LRU clock ticks once a round, driven by the test: a second per round, in effect.
    t.server.cron.stop();
    const value = 'x'.repeat(100);
    for (let i = 0; i < KEYS; i += 1_000) {
      await pipeline(
        c,
        Array.from({ length: 1_000 }, (_, j) => ['SET', `key:${i + j}`, value]),
      );
    }
    await c.call('CONFIG', 'SET', 'maxmemory', String(t.server.usedMemory));
    const rng = new Random(99);
    const hitsBefore = t.server.stats.keyspaceHits;
    const missesBefore = t.server.stats.keyspaceMisses;
    let filler = 0;
    for (let round = 0; round < ROUNDS; round++) {
      t.server.lruClock++;
      const commands: string[][] = [];
      for (let i = 0; i < READS_PER_ROUND; i++) {
        const k = rng.next() < 0.9 ? rng.int(HOT) : HOT + rng.int(KEYS - HOT);
        commands.push(['GET', `key:${k}`]);
        commands.push(['SET', `filler:${filler++}`, value]);
      }
      const replies = await pipeline(c, commands);
      expect(replies.filter((r) => r instanceof RespError)).toEqual([]);
    }
    const hits = t.server.stats.keyspaceHits - hitsBefore;
    const misses = t.server.stats.keyspaceMisses - missesBefore;
    c.socket.destroy();
    await t.close();
    expect(hits + misses).toBe(ROUNDS * READS_PER_ROUND);
    return (100 * hits) / (hits + misses);
  }

  it('allkeys-lru and allkeys-lfu beat allkeys-random by at least 20 points', async () => {
    const random = await hitRate('allkeys-random');
    const lru = await hitRate('allkeys-lru');
    const lfu = await hitRate('allkeys-lfu');
    console.log(
      `hot-set hit rates: random ${random.toFixed(1)}%, lru ${lru.toFixed(1)}%, lfu ${lfu.toFixed(1)}%`,
    );
    expect(lru - random).toBeGreaterThanOrEqual(20);
    expect(lfu - random).toBeGreaterThanOrEqual(20);
  }, 60_000);
});
