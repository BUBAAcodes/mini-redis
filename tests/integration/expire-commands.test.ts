// Step 7: TTLs, lazy and active expiry, absolute-time propagation and DEBUG. Expected replies
// were checked against the redis:7.4 reference server.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PropagationRecord } from '../../src/server/propagate.js';
import { TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer;
let c: TestClient;
const records: PropagationRecord[] = [];

beforeAll(async () => {
  t = await startServer();
  t.server.propagator.attach({ append: (r) => records.push(r) });
  c = await TestClient.connect(t.port);
});

beforeEach(async () => {
  await c.call('DEBUG', 'SET-ACTIVE-EXPIRE', '1');
  await c.call('FLUSHALL');
  records.length = 0;
});

afterAll(async () => {
  c.socket.destroy();
  await t.close();
});

const err = (msg: string) => `-${msg}\r\n`;
const argvs = () => records.map((r) => r.argv);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A key that is already expired but still stored, because active expiry is off. */
async function expiredKey(key: string): Promise<void> {
  await c.call('DEBUG', 'SET-ACTIVE-EXPIRE', '0');
  await c.call('SET', key, 'v', 'PXAT', '1');
  records.length = 0;
}

/** Expects `argv` to be `[cmd, key, <ms>]` with ms within `[lo, hi]`. */
function expectAbsolute(
  argv: readonly string[] | undefined,
  head: string[],
  lo: number,
  hi: number,
) {
  expect(argv?.slice(0, head.length)).toEqual(head);
  const ms = Number(argv![head.length]);
  expect(ms).toBeGreaterThanOrEqual(lo);
  expect(ms).toBeLessThanOrEqual(hi);
}

describe('EXPIRE, PEXPIRE, EXPIREAT, PEXPIREAT', () => {
  it('set a TTL that TTL and PTTL report', async () => {
    await c.call('SET', 'k', 'v');
    expect(await c.call('EXPIRE', 'k', '100')).toBe(1);
    expect(await c.call('TTL', 'k')).toBe(100);
    const pttl = (await c.call('PTTL', 'k')) as number;
    expect(pttl).toBeGreaterThan(99_000);
    expect(pttl).toBeLessThanOrEqual(100_000);
    expect(await c.call('PEXPIRE', 'k', '5000')).toBe(1);
    expect(await c.call('TTL', 'k')).toBe(5);
    const at = Math.floor(Date.now() / 1000) + 200;
    expect(await c.call('EXPIREAT', 'k', String(at))).toBe(1);
    expect(await c.call('TTL', 'k')).toBeGreaterThanOrEqual(199);
    expect(await c.call('PEXPIREAT', 'k', String(Date.now() + 300_000))).toBe(1);
    expect(await c.call('TTL', 'k')).toBeGreaterThanOrEqual(299);
  });

  it('reply 0 for a missing key', async () => {
    for (const cmd of ['EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT']) {
      expect(await c.call(cmd, 'nope', '100')).toBe(0);
    }
    expect(records).toEqual([]);
  });

  it('NX, XX, GT and LT, where GT and LT treat no TTL as infinite', async () => {
    await c.call('SET', 'k', 'v');
    expect(await c.call('EXPIRE', 'k', '100', 'XX')).toBe(0);
    expect(await c.call('EXPIRE', 'k', '100', 'GT')).toBe(0);
    expect(await c.call('EXPIRE', 'k', '100', 'NX')).toBe(1);
    expect(await c.call('EXPIRE', 'k', '100', 'nx')).toBe(0);
    expect(await c.call('EXPIRE', 'k', '50', 'GT')).toBe(0);
    expect(await c.call('EXPIRE', 'k', '200', 'gt')).toBe(1);
    expect(await c.call('EXPIRE', 'k', '300', 'LT')).toBe(0);
    expect(await c.call('EXPIRE', 'k', '50', 'LT', 'XX')).toBe(1);
    expect(await c.call('TTL', 'k')).toBe(50);
    await c.call('PERSIST', 'k');
    expect(await c.call('EXPIRE', 'k', '50', 'LT')).toBe(1);
    expect(await c.call('EXPIRE', 'k', '10', 'NX', 'NX')).toBe(0);
  });

  it('option errors, checked before the number and before the key', async () => {
    const nx = 'ERR NX and XX, GT or LT options at the same time are not compatible';
    const gtlt = 'ERR GT and LT options at the same time are not compatible';
    expect(await c.raw('EXPIRE', 'nope', '10', 'NX', 'XX')).toBe(err(nx));
    expect(await c.raw('EXPIRE', 'nope', '10', 'NX', 'GT')).toBe(err(nx));
    expect(await c.raw('EXPIRE', 'nope', 'abc', 'nx', 'lt')).toBe(err(nx));
    expect(await c.raw('EXPIRE', 'nope', 'abc', 'gt', 'lt')).toBe(err(gtlt));
    expect(await c.raw('EXPIRE', 'nope', 'abc', 'Bogus')).toBe(err('ERR Unsupported option Bogus'));
    expect(await c.raw('EXPIRE', 'nope', 'abc')).toBe(
      err('ERR value is not an integer or out of range'),
    );
    expect(await c.raw('EXPIRE', 'k')).toBe(
      err("ERR wrong number of arguments for 'expire' command"),
    );
  });

  it('overflow is an invalid expire time, even for a missing key', async () => {
    await c.call('SET', 'k', 'v');
    const bad = (cmd: string) => err(`ERR invalid expire time in '${cmd}' command`);
    expect(await c.raw('EXPIRE', 'nope', '9223372036854775807')).toBe(bad('expire'));
    expect(await c.raw('EXPIRE', 'k', '9223372036854775')).toBe(bad('expire'));
    expect(await c.raw('EXPIRE', 'k', '-9223372036854775808')).toBe(bad('expire'));
    expect(await c.raw('PEXPIRE', 'k', '9223372036854775807')).toBe(bad('pexpire'));
    expect(await c.raw('EXPIREAT', 'k', '9223372036854775808')).toBe(
      err('ERR value is not an integer or out of range'),
    );
    expect(await c.call('TTL', 'k')).toBe(-1);
    // The largest deadlines that fit are accepted.
    expect(await c.call('EXPIREAT', 'k', '9223372036854775')).toBe(1);
    expect(await c.call('PEXPIREAT', 'k', '9223372036854775807')).toBe(1);
    expect(await c.call('EXISTS', 'k')).toBe(1);
  });

  it('a deadline in the past deletes the key and propagates DEL', async () => {
    await c.call('MSET', 'a', '1', 'b', '2', 'c', '3', 'd', '4');
    records.length = 0;
    expect(await c.call('EXPIRE', 'a', '-1')).toBe(1);
    expect(await c.call('PEXPIRE', 'b', '0')).toBe(1);
    expect(await c.call('EXPIREAT', 'c', '1')).toBe(1);
    expect(await c.call('PEXPIREAT', 'd', String(Date.now() - 1))).toBe(1);
    expect(await c.call('DBSIZE')).toBe(0);
    expect(argvs()).toEqual([
      ['DEL', 'a'],
      ['DEL', 'b'],
      ['DEL', 'c'],
      ['DEL', 'd'],
    ]);
  });

  it('propagate as PEXPIREAT with an absolute time (spec 9.5)', async () => {
    await c.call('SET', 'k', 'v');
    records.length = 0;
    const before = Date.now();
    await c.call('EXPIRE', 'k', '10');
    await c.call('PEXPIRE', 'k', '20000', 'GT');
    const after = Date.now();
    await c.call('EXPIREAT', 'k', '4000000000');
    await c.call('PEXPIREAT', 'k', '4000000000001');
    expectAbsolute(records[0]?.argv, ['PEXPIREAT', 'k'], before + 10_000, after + 10_000);
    expectAbsolute(records[1]?.argv, ['PEXPIREAT', 'k'], before + 20_000, after + 20_000);
    expect(argvs().slice(2)).toEqual([
      ['PEXPIREAT', 'k', '4000000000000'],
      ['PEXPIREAT', 'k', '4000000000001'],
    ]);
  });

  it('an EXPIRE that a flag skipped propagates nothing', async () => {
    await c.call('SET', 'k', 'v');
    records.length = 0;
    await c.call('EXPIRE', 'k', '10', 'XX');
    expect(records).toEqual([]);
  });
});

describe('TTL, PTTL, PERSIST', () => {
  it('-2 for no key, -1 for no TTL', async () => {
    await c.call('SET', 'k', 'v');
    expect(await c.call('TTL', 'nope')).toBe(-2);
    expect(await c.call('PTTL', 'nope')).toBe(-2);
    expect(await c.call('TTL', 'k')).toBe(-1);
    expect(await c.call('PTTL', 'k')).toBe(-1);
  });

  it('TTL rounds to the nearest second', async () => {
    await c.call('SET', 'k', 'v', 'PX', '1600');
    expect(await c.call('TTL', 'k')).toBe(2);
    await c.call('SET', 'k', 'v', 'PX', '1400');
    expect(await c.call('TTL', 'k')).toBe(1);
  });

  it('TTL and PTTL leave the hit and miss counters alone', async () => {
    await c.call('SET', 'k', 'v', 'EX', '100');
    t.server.resetStats();
    await c.call('TTL', 'k');
    await c.call('PTTL', 'nope');
    expect(t.server.stats).toMatchObject({ keyspaceHits: 0, keyspaceMisses: 0 });
  });

  it('PERSIST removes a TTL once and propagates only when it did', async () => {
    await c.call('SET', 'k', 'v', 'EX', '100');
    records.length = 0;
    expect(await c.call('PERSIST', 'k')).toBe(1);
    expect(await c.call('PERSIST', 'k')).toBe(0);
    expect(await c.call('PERSIST', 'nope')).toBe(0);
    expect(await c.call('TTL', 'k')).toBe(-1);
    expect(argvs()).toEqual([['PERSIST', 'k']]);
  });
});

describe('SET with TTL options', () => {
  it('EX, PX, EXAT and PXAT set the TTL', async () => {
    expect(await c.raw('SET', 'a', 'v', 'EX', '100')).toBe('+OK\r\n');
    expect(await c.call('TTL', 'a')).toBe(100);
    await c.call('SET', 'b', 'v', 'px', '100000');
    expect(await c.call('TTL', 'b')).toBe(100);
    await c.call('SET', 'c', 'v', 'EXAT', String(Math.floor(Date.now() / 1000) + 100));
    expect(await c.call('TTL', 'c')).toBeGreaterThanOrEqual(99);
    await c.call('SET', 'd', 'v', 'PXAT', String(Date.now() + 100_000));
    expect(await c.call('TTL', 'd')).toBeGreaterThanOrEqual(99);
  });

  it('a plain SET drops the TTL; KEEPTTL keeps it; INCR and APPEND keep it', async () => {
    await c.call('SET', 'k', 'v', 'EX', '100');
    await c.call('SET', 'k', 'w', 'KEEPTTL');
    expect(await c.call('TTL', 'k')).toBe(100);
    await c.call('SET', 'k', '1');
    expect(await c.call('TTL', 'k')).toBe(-1);
    await c.call('SET', 'k', '1', 'EX', '100');
    await c.call('INCR', 'k');
    await c.call('APPEND', 'k', '0');
    expect(await c.call('TTL', 'k')).toBe(100);
  });

  it('a repeated TTL option is allowed and the last one wins', async () => {
    await c.call('SET', 'k', 'v', 'EX', '10', 'EX', '20');
    expect(await c.call('TTL', 'k')).toBe(20);
  });

  it('clashing options are a syntax error', async () => {
    for (const opts of [
      ['EX', '10', 'PX', '10'],
      ['EX', '10', 'KEEPTTL'],
      ['KEEPTTL', 'EX', '10'],
      ['PXAT', '10', 'EXAT', '10'],
      ['EX'],
      ['PERSIST'],
    ]) {
      expect(await c.raw('SET', 'k', 'v', ...opts), opts.join(' ')).toBe(err('ERR syntax error'));
    }
    expect(await c.call('EXISTS', 'k')).toBe(0);
  });

  it('a bad TTL is an error that changes nothing, checked before GET and NX', async () => {
    await c.call('SET', 'k', 'old');
    const bad = err("ERR invalid expire time in 'set' command");
    for (const opts of [
      ['EX', '0'],
      ['PX', '-1'],
      ['EXAT', '0'],
      ['EX', '9223372036854775'],
      ['PX', '9223372036854775807'],
      ['EX', '0', 'GET'],
      ['EX', '0', 'NX'],
    ]) {
      expect(await c.raw('SET', 'k', 'new', ...opts), opts.join(' ')).toBe(bad);
    }
    expect(await c.raw('SET', 'k', 'new', 'PX', 'abc')).toBe(
      err('ERR value is not an integer or out of range'),
    );
    expect(await c.call('GET', 'k')).toBe('old');
    expect(await c.call('TTL', 'k')).toBe(-1);
    // A deadline in the past is fine for EXAT: the key is stored and expires on its own.
    expect(await c.raw('SET', 'k', 'new', 'EXAT', '9223372036854775')).toBe('+OK\r\n');
  });

  it('propagates as SET key value PXAT <absolute ms> (spec 9.5)', async () => {
    const before = Date.now();
    await c.call('SET', 'k', 'v', 'EX', '10');
    await c.call('SET', 'k', 'w', 'PX', '500', 'GET', 'XX');
    const after = Date.now();
    await c.call('SET', 'k', 'x', 'EXAT', '4000000000');
    await c.call('SET', 'k', 'y', 'PXAT', '4000000000001');
    await c.call('SET', 'k', 'z', 'KEEPTTL');
    expectAbsolute(records[0]?.argv, ['SET', 'k', 'v', 'PXAT'], before + 10_000, after + 10_000);
    expectAbsolute(records[1]?.argv, ['SET', 'k', 'w', 'PXAT'], before + 500, after + 500);
    expect(argvs().slice(2)).toEqual([
      ['SET', 'k', 'x', 'PXAT', '4000000000000'],
      ['SET', 'k', 'y', 'PXAT', '4000000000001'],
      ['SET', 'k', 'z', 'KEEPTTL'],
    ]);
  });
});

describe('GETEX', () => {
  it('without options is GET', async () => {
    await c.call('SET', 'k', 'v', 'EX', '100');
    records.length = 0;
    expect(await c.call('GETEX', 'k')).toBe('v');
    expect(await c.call('GETEX', 'nope')).toBeNull();
    expect(await c.call('TTL', 'k')).toBe(100);
    expect(records).toEqual([]);
  });

  it('EX, PX, EXAT, PXAT and PERSIST, propagated as PEXPIREAT and PERSIST', async () => {
    await c.call('SET', 'k', 'v');
    records.length = 0;
    const before = Date.now();
    expect(await c.call('GETEX', 'k', 'EX', '100')).toBe('v');
    const after = Date.now();
    expect(await c.call('TTL', 'k')).toBe(100);
    expect(await c.call('GETEX', 'k', 'px', '200000')).toBe('v');
    expect(await c.call('TTL', 'k')).toBe(200);
    await c.call('GETEX', 'k', 'EXAT', '4000000000');
    await c.call('GETEX', 'k', 'PXAT', '4000000000001');
    expect(await c.call('GETEX', 'k', 'PERSIST')).toBe('v');
    expect(await c.call('TTL', 'k')).toBe(-1);
    // PERSIST on a key with no TTL changes nothing.
    await c.call('GETEX', 'k', 'PERSIST', 'PERSIST');
    expectAbsolute(records[0]?.argv, ['PEXPIREAT', 'k'], before + 100_000, after + 100_000);
    expect(argvs().slice(2)).toEqual([
      ['PEXPIREAT', 'k', '4000000000000'],
      ['PEXPIREAT', 'k', '4000000000001'],
      ['PERSIST', 'k'],
    ]);
  });

  it('a past EXAT or PXAT replies with the value, then deletes the key and propagates DEL', async () => {
    await c.call('MSET', 'a', '1', 'b', '2');
    records.length = 0;
    expect(await c.call('GETEX', 'a', 'EXAT', '1')).toBe('1');
    expect(await c.call('GETEX', 'b', 'PXAT', String(Date.now() - 5))).toBe('2');
    expect(await c.call('DBSIZE')).toBe(0);
    expect(argvs()).toEqual([
      ['DEL', 'a'],
      ['DEL', 'b'],
    ]);
  });

  it('errors: options first, then the key, then WRONGTYPE, then the TTL', async () => {
    await c.call('SET', 'k', 'v');
    expect(await c.raw('GETEX', 'nope', 'bogus')).toBe(err('ERR syntax error'));
    expect(await c.raw('GETEX', 'nope', 'EX')).toBe(err('ERR syntax error'));
    for (const opts of [
      ['EX', '10', 'PX', '10'],
      ['PERSIST', 'EX', '10'],
      ['EX', '10', 'PERSIST'],
      ['KEEPTTL'],
      ['NX'],
      ['GET'],
    ]) {
      expect(await c.raw('GETEX', 'k', ...opts), opts.join(' ')).toBe(err('ERR syntax error'));
    }
    // A missing key replies nil before its TTL is even checked, as in Redis.
    expect(await c.raw('GETEX', 'nope', 'EX', '0')).toBe('$-1\r\n');
    expect(await c.raw('GETEX', 'k', 'EX', '0')).toBe(
      err("ERR invalid expire time in 'getex' command"),
    );
    expect(await c.raw('GETEX', 'k', 'EX', 'x')).toBe(
      err('ERR value is not an integer or out of range'),
    );
    expect(await c.call('TTL', 'k')).toBe(-1);
    expect(await c.raw('GETEX')).toBe(err("ERR wrong number of arguments for 'getex' command"));
  });
});

describe('lazy expiry (spec 9.3)', () => {
  it('with active expiry off, GET on an expired key returns nil and DBSIZE drops by one', async () => {
    await c.call('SET', 'other', 'v');
    await expiredKey('k');
    expect(await c.call('DBSIZE')).toBe(2);
    expect(await c.call('GET', 'k')).toBeNull();
    expect(await c.call('DBSIZE')).toBe(1);
    expect(t.server.stats.expiredKeys).toBeGreaterThan(0);
  });

  it('really expires after the TTL passes', async () => {
    await c.call('DEBUG', 'SET-ACTIVE-EXPIRE', '0');
    await c.call('SET', 'k', 'v', 'PX', '50');
    expect(await c.call('GET', 'k')).toBe('v');
    await sleep(80);
    expect(await c.call('DBSIZE')).toBe(1);
    expect(await c.call('GET', 'k')).toBeNull();
    expect(await c.call('DBSIZE')).toBe(0);
  });

  it('propagates DEL k ahead of the command that found the key', async () => {
    await expiredKey('x');
    await c.call('SET', 'x', 'fresh');
    expect(argvs()).toEqual([
      ['DEL', 'x'],
      ['SET', 'x', 'fresh'],
    ]);
  });

  it('a read or a no-op write finding an expired key propagates only the DEL', async () => {
    await expiredKey('g');
    await c.call('GET', 'g');
    expect(argvs()).toEqual([['DEL', 'g']]);
    await expiredKey('d');
    expect(await c.call('DEL', 'd')).toBe(0);
    expect(argvs()).toEqual([['DEL', 'd']]);
    await expiredKey('n');
    expect(await c.call('INCR', 'n')).toBe(1);
    expect(argvs()).toEqual([
      ['DEL', 'n'],
      ['INCR', 'n'],
    ]);
  });

  it('every key command treats an expired key as missing', async () => {
    await c.call('SET', 'live', 'v');
    await expiredKey('dead');
    expect(await c.call('EXISTS', 'dead', 'live')).toBe(1);
    await expiredKey('dead');
    expect(await c.call('TYPE', 'dead')).toBe('none');
    await expiredKey('dead');
    expect(await c.call('TTL', 'dead')).toBe(-2);
    await expiredKey('dead');
    expect(await c.call('KEYS', '*')).toEqual(['live']);
    expect(await c.call('SCAN', '0', 'COUNT', '100')).toEqual(['0', ['live']]);
    await expiredKey('dead');
    for (let i = 0; i < 10; i++) expect(await c.call('RANDOMKEY')).toBe('live');
    await expiredKey('dead');
    expect(await c.raw('RENAME', 'dead', 'x')).toBe(err('ERR no such key'));
    await expiredKey('dead');
    expect(await c.call('MGET', 'dead', 'live')).toEqual([null, 'v']);
    await expiredKey('dead');
    expect(await c.call('SET', 'dead', 'new', 'NX')).toBe('OK');
  });

  it('RENAME carries the TTL over', async () => {
    await c.call('SET', 'a', 'v', 'EX', '100');
    await c.call('RENAME', 'a', 'b');
    expect(await c.call('TTL', 'b')).toBe(100);
  });
});

describe('active expiry (spec 9.3)', () => {
  it('100,000 keys with a 1-second TTL are gone within 3 seconds without being read', async () => {
    const n = 100_000;
    let pipeline = '';
    for (let i = 0; i < n; i++) {
      const key = `key:${i}`;
      pipeline += `*5\r\n$3\r\nSET\r\n$${key.length}\r\n${key}\r\n$1\r\nv\r\n$2\r\nPX\r\n$4\r\n1000\r\n`;
    }
    const before = t.server.stats.expiredKeys;
    const lookups = () => t.server.stats.keyspaceHits + t.server.stats.keyspaceMisses;
    const lookupsBefore = lookups();
    c.write(pipeline);
    for (let i = 0; i < n; i++) expect(await c.read()).toBe('OK');
    // Under load the writes take over a second, so the first keys may already be gone here;
    // the clock starts at the last write, whose key lives a full second from now.
    const written = Date.now();
    while ((await c.call('DBSIZE')) !== 0) {
      expect(Date.now() - written).toBeLessThan(3000);
      await sleep(50);
    }
    expect(t.server.stats.expiredKeys - before).toBe(n);
    expect(lookups()).toBe(lookupsBefore);
  });

  it('propagates DEL for each key it removes', async () => {
    await c.call('SET', 'k', 'v', 'PX', '1');
    records.length = 0;
    await sleep(300);
    expect(argvs()).toEqual([['DEL', 'k']]);
  });

  it('DEBUG SET-ACTIVE-EXPIRE 0 stops it', async () => {
    await c.call('DEBUG', 'SET-ACTIVE-EXPIRE', '0');
    await c.call('SET', 'k', 'v', 'PX', '1');
    await sleep(300);
    expect(await c.call('DBSIZE')).toBe(1);
  });
});

describe('DEBUG', () => {
  it('DIGEST is 40 zeros when empty and tracks every change', async () => {
    const zero = '0'.repeat(40);
    expect(await c.raw('DEBUG', 'DIGEST')).toBe(`+${zero}\r\n`);
    await c.call('SET', 'k', 'v');
    const d1 = await c.call('DEBUG', 'DIGEST');
    expect(d1).toMatch(/^[0-9a-f]{40}$/);
    expect(d1).not.toBe(zero);
    await c.call('EXPIRE', 'k', '100');
    const d2 = await c.call('DEBUG', 'DIGEST');
    expect(d2).not.toBe(d1);
    await c.call('PERSIST', 'k');
    expect(await c.call('DEBUG', 'DIGEST')).toBe(d1);
  });

  it('DIGEST-VALUE digests each key, zeros for a missing one', async () => {
    await c.call('SET', 'a', 'x');
    await c.call('SET', 'b', 'x');
    const [da, db, dm] = (await c.call('DEBUG', 'DIGEST-VALUE', 'a', 'b', 'nope')) as string[];
    expect(da).toMatch(/^[0-9a-f]{40}$/);
    expect(da).toBe(db);
    expect(dm).toBe('0'.repeat(40));
    expect(await c.raw('DEBUG', 'DIGEST-VALUE')).toBe('*0\r\n');
  });

  it('SLEEP blocks the server for that long', async () => {
    const start = Date.now();
    expect(await c.raw('DEBUG', 'SLEEP', '0.05')).toBe('+OK\r\n');
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    expect(await c.raw('DEBUG', 'SLEEP', '0')).toBe('+OK\r\n');
  });

  it('unknown subcommands, HELP, and the arity', async () => {
    expect(await c.raw('DEBUG', 'nope')).toBe(
      err("ERR unknown subcommand 'nope'. Try DEBUG HELP."),
    );
    expect(await c.raw('DEBUG', 'SLEEP')).toBe(
      err("ERR unknown subcommand 'SLEEP'. Try DEBUG HELP."),
    );
    expect(await c.raw('DEBUG')).toBe(err("ERR wrong number of arguments for 'debug' command"));
    const help = (await c.call('DEBUG', 'HELP')) as string[];
    expect(help[0]).toMatch(/^DEBUG <subcommand>/);
    expect(help.join('\n')).toContain('SET-ACTIVE-EXPIRE');
  });

  it('is refused unless enable-debug-command is yes', async () => {
    const off = await startServer({ 'enable-debug-command': 'no' });
    const oc = await TestClient.connect(off.port);
    expect(await oc.raw('DEBUG', 'DIGEST')).toBe(
      err(
        'ERR DEBUG command not allowed. If the enable-debug-command option is set to "local", you can run it from a local connection, otherwise you need to set this option in the configuration file, and then restart the server.',
      ),
    );
    oc.socket.destroy();
    await off.close();
  });
});
