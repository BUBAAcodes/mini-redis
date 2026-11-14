import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from '../../src/server/server.js';
import { entryBytes } from '../../src/storage/memory.js';
import { Random } from '../../src/utils/random.js';
import { RespError, TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer;
let c: TestClient;

beforeAll(async () => {
  t = await startServer({}, 19);
  c = await TestClient.connect(t.port);
});

beforeEach(async () => {
  await c.call('FLUSHALL');
  await c.call('CONFIG', 'SET', 'maxmemory-policy', 'noeviction');
});

afterAll(async () => {
  c.socket.destroy();
  await t.close();
});

/** Every db's running total against a recount from scratch, and each key's remembered share. */
function expectAccountingExact(server: Server): void {
  for (const db of server.dbs) {
    let total = 0;
    db.forEachKey((key, obj, expireAt) => {
      const bytes = entryBytes(key, obj, expireAt !== -1);
      expect(obj.memBytes, `key ${key} in db ${db.id}`).toBe(bytes);
      total += bytes;
    });
    expect(db.usedMemory, `db ${db.id}`).toBe(total);
  }
}

const err = (message: string): RespError => new RespError(message);

describe('memory accounting (spec 10.5)', () => {
  it('stays exact through a random mix of every type, TTLs, renames and deletes', async () => {
    const rng = new Random(42);
    const key = (): string => `k${rng.int(40)}`;
    const val = (): string => 'v'.repeat(rng.int(30));
    const commands: Array<() => string[]> = [
      () => ['SET', key(), val()],
      () => ['SET', key(), val(), 'EX', '1000'],
      () => ['SET', key(), val(), 'KEEPTTL'],
      () => ['APPEND', key(), val()],
      () => ['INCRBY', key(), String(rng.int(1000))],
      () => ['SETRANGE', key(), String(rng.int(10)), val()],
      () => ['GETDEL', key()],
      () => ['DEL', key(), key()],
      () => ['EXPIRE', key(), '500'],
      () => ['PERSIST', key()],
      () => ['RENAME', key(), key()],
      () => ['LPUSH', key(), val(), val()],
      () => ['RPUSH', key(), val()],
      () => ['LPOP', key()],
      () => ['LSET', key(), '0', val()],
      () => ['LTRIM', key(), '1', '-2'],
      () => ['LREM', key(), '0', val()],
      () => ['LINSERT', key(), 'BEFORE', val(), val()],
      () => ['LMOVE', key(), key(), 'LEFT', 'RIGHT'],
      () => ['HSET', key(), val(), val(), val(), val()],
      () => ['HDEL', key(), val()],
      () => ['HINCRBY', key(), val(), '3'],
      () => ['SADD', key(), val(), val()],
      () => ['SREM', key(), val()],
      () => ['SPOP', key()],
      () => ['SINTERSTORE', key(), key(), key()],
      () => ['ZADD', key(), String(rng.int(100)), val()],
      () => ['ZINCRBY', key(), '2', val()],
      () => ['ZREM', key(), val()],
      () => ['ZPOPMIN', key()],
      () => ['ZUNIONSTORE', key(), '2', key(), key()],
      () => ['SELECT', String(rng.int(3))],
    ];
    for (let i = 0; i < 4_000; i++) {
      await c.call(...commands[rng.int(commands.length)]!());
      if (i % 500 === 0) expectAccountingExact(t.server);
    }
    await c.call('SELECT', '0');
    expectAccountingExact(t.server);
    expect(t.server.usedMemory).toBeGreaterThan(0);
    await c.call('FLUSHALL');
    expect(t.server.usedMemory).toBe(0);
  });

  it('counts a key removed by lazy or active expiry', async () => {
    await c.call('SET', 'gone', 'x'.repeat(100), 'PX', '1');
    await c.call('SET', 'stays', 'y');
    await new Promise((r) => setTimeout(r, 20));
    expect(await c.call('GET', 'gone')).toBeNull();
    expectAccountingExact(t.server);
    expect(t.server.usedMemory).toBe(t.server.dbs[0]!.usedMemory);
  });

  it('survives DEBUG RELOAD and FLUSHDB unchanged and exact', async () => {
    await c.call('HSET', 'h', 'a', '1', 'b', '2');
    await c.call('RPUSH', 'l', 'x', 'y', 'z');
    await c.call('SET', 's', 'value', 'EX', '100');
    const before = t.server.usedMemory;
    expect(await c.call('DEBUG', 'RELOAD')).toBe('OK');
    expect(t.server.usedMemory).toBe(before);
    expectAccountingExact(t.server);
    await c.call('SELECT', '1');
    await c.call('SET', 'other', 'db');
    await c.call('FLUSHDB');
    await c.call('SELECT', '0');
    expect(t.server.usedMemory).toBe(before);
  });

  it('grows with the data', async () => {
    await c.call('SET', 'small', 'x');
    const small = t.server.usedMemory;
    await c.call('SET', 'big', 'x'.repeat(10_000));
    expect(t.server.usedMemory - small).toBeGreaterThan(10_000);
  });
});

describe('MEMORY USAGE', () => {
  it("replies with the key's estimate, or nil", async () => {
    await c.call('SET', 'k', 'x'.repeat(1000));
    const usage = await c.call('MEMORY', 'USAGE', 'k');
    expect(usage).toBe(t.server.dbs[0]!.usedMemory);
    expect(usage).toBeGreaterThan(1000);
    expect(await c.call('MEMORY', 'USAGE', 'k', 'SAMPLES', '0')).toBe(usage);
    expect(await c.call('MEMORY', 'usage', 'k', 'samples', '10')).toBe(usage);
    expect(await c.call('MEMORY', 'USAGE', 'missing')).toBeNull();
  });

  it('checks its arguments as Redis 7.4 does', async () => {
    await c.call('SET', 'k', 'v');
    const syntax = err('ERR syntax error');
    expect(await c.call('MEMORY', 'USAGE', 'k', 'SAMPLES', '-1')).toEqual(syntax);
    expect(await c.call('MEMORY', 'USAGE', 'k', 'SAMPLES')).toEqual(syntax);
    expect(await c.call('MEMORY', 'USAGE', 'k', 'FOO')).toEqual(syntax);
    expect(await c.call('MEMORY', 'USAGE', 'k', 'SAMPLES', 'x')).toEqual(
      err('ERR value is not an integer or out of range'),
    );
    expect(await c.call('MEMORY', 'USAGE')).toEqual(
      err("ERR wrong number of arguments for 'memory|usage' command"),
    );
    expect(await c.call('MEMORY')).toEqual(
      err("ERR wrong number of arguments for 'memory' command"),
    );
    expect(await c.call('MEMORY', 'FOO')).toEqual(
      err("ERR unknown subcommand 'FOO'. Try MEMORY HELP."),
    );
    const help = await c.call('MEMORY', 'HELP');
    expect(Array.isArray(help) && help[0]).toMatch(/^MEMORY <subcommand>/);
  });
});

describe('OBJECT', () => {
  it('works out the encoding when asked', async () => {
    await c.call('SET', 'int', '-123');
    await c.call('SET', 'notint', '007');
    await c.call('SET', 'embstr', 'x'.repeat(44));
    await c.call('SET', 'raw', 'x'.repeat(45));
    await c.call('RPUSH', 'list', 'a');
    await c.call('HSET', 'hash', 'f', 'v');
    await c.call('SADD', 'set', '1');
    await c.call('ZADD', 'zset', '1', 'a');
    const enc = async (k: string): Promise<unknown> => c.call('OBJECT', 'ENCODING', k);
    expect(await enc('int')).toBe('int');
    expect(await enc('notint')).toBe('embstr');
    expect(await enc('embstr')).toBe('embstr');
    expect(await enc('raw')).toBe('raw');
    expect(await enc('list')).toBe('quicklist');
    expect(await enc('hash')).toBe('hashtable');
    expect(await enc('set')).toBe('hashtable');
    expect(await enc('zset')).toBe('skiplist');
    expect(await c.raw('OBJECT', 'ENCODING', 'missing')).toBe('$-1\r\n');
  });

  it('reports idle time under LRU without touching the key', async () => {
    await c.call('SET', 'k', 'v');
    t.server.dbs[0]!.dict.get('k')!.lru -= 10;
    expect(await c.call('OBJECT', 'IDLETIME', 'k')).toBe(10);
    // OBJECT, TYPE and TTL peek: still idle.
    await c.call('TYPE', 'k');
    expect(await c.call('OBJECT', 'IDLETIME', 'k')).toBe(10);
    await c.call('GET', 'k');
    expect(await c.call('OBJECT', 'IDLETIME', 'k')).toBe(0);
    expect(await c.call('OBJECT', 'FREQ', 'k')).toEqual(
      err(
        'ERR An LFU maxmemory policy is not selected, access frequency not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.',
      ),
    );
  });

  it('reports the LFU counter under an LFU policy: 5 when new, 6 after one read', async () => {
    await c.call('CONFIG', 'SET', 'maxmemory-policy', 'allkeys-lfu');
    await c.call('SET', 'k', 'hello');
    expect(await c.call('OBJECT', 'FREQ', 'k')).toBe(5);
    await c.call('GET', 'k');
    expect(await c.call('OBJECT', 'FREQ', 'k')).toBe(6);
    // Overwriting keeps the counter, as Redis's dbSetValue does under LFU.
    await c.call('SET', 'k', 'again');
    expect(await c.call('OBJECT', 'FREQ', 'k')).toBe(6);
    expect(await c.call('OBJECT', 'IDLETIME', 'k')).toEqual(
      err(
        'ERR An LFU maxmemory policy is selected, idle time not tracked. Please note that when switching between policies at runtime LRU and LFU data will take some time to adjust.',
      ),
    );
    expect(await c.raw('OBJECT', 'FREQ', 'missing')).toBe('$-1\r\n');
  });

  it('replies to REFCOUNT, HELP and bad calls as Redis 7.4 does', async () => {
    await c.call('SET', 'k', 'hello');
    expect(await c.call('OBJECT', 'REFCOUNT', 'k')).toBe(1);
    const help = await c.call('OBJECT', 'HELP');
    expect(Array.isArray(help) && help[0]).toMatch(/^OBJECT <subcommand>/);
    expect(await c.call('OBJECT', 'foo', 'k')).toEqual(
      err("ERR unknown subcommand 'foo'. Try OBJECT HELP."),
    );
    expect(await c.call('OBJECT')).toEqual(
      err("ERR wrong number of arguments for 'object' command"),
    );
    expect(await c.call('OBJECT', 'ENCODING')).toEqual(
      err("ERR wrong number of arguments for 'object|encoding' command"),
    );
    expect(await c.call('OBJECT', 'ENCODING', 'a', 'b')).toEqual(
      err("ERR wrong number of arguments for 'object|encoding' command"),
    );
  });
});

describe('INFO memory', () => {
  it('reports the estimate, RSS, the peak and the limit', async () => {
    await c.call('SET', 'k', 'x'.repeat(5000));
    await c.call('CONFIG', 'SET', 'maxmemory', '50mb');
    const text = String(await c.call('INFO', 'memory'));
    const field = (name: string): string => new RegExp(`^${name}:(.*)\r$`, 'm').exec(text)![1]!;
    expect(text.startsWith('# Memory\r\n')).toBe(true);
    expect(Number(field('used_memory'))).toBe(t.server.usedMemory);
    expect(field('used_memory_human')).toMatch(/^\d+(\.\d\d[KMG])?B?$/);
    expect(Number(field('used_memory_rss'))).toBeGreaterThan(1_000_000);
    expect(Number(field('used_memory_peak'))).toBeGreaterThanOrEqual(t.server.usedMemory);
    expect(field('maxmemory')).toBe(String(50 * 1024 * 1024));
    expect(field('maxmemory_human')).toBe('50.00M');
    expect(field('maxmemory_policy')).toBe('noeviction');
    await c.call('CONFIG', 'SET', 'maxmemory', '0');
  });
});
