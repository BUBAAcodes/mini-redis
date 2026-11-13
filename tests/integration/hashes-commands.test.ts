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
  await c.call('FLUSHALL');
  records.length = 0;
});

afterAll(async () => {
  c.socket.destroy();
  await t.close();
});

const err = (msg: string) => `-${msg}\r\n`;
const WRONGTYPE = err('WRONGTYPE Operation against a key holding the wrong kind of value');
const sorted = (v: unknown) => [...(v as string[])].sort();

describe('HSET, HGET, HMGET, HLEN, HEXISTS', () => {
  it('HSET counts only new fields; the last value for a repeated field wins', async () => {
    expect(await c.call('HSET', 'h', 'f', 'v', 'f', 'w')).toBe(1);
    expect(await c.call('HSET', 'h', 'f', 'x', 'g', 'y')).toBe(1);
    expect(await c.call('HGET', 'h', 'f')).toBe('x');
    expect(await c.raw('HGET', 'h', 'nope')).toBe('$-1\r\n');
    expect(await c.raw('HGET', 'missing', 'f')).toBe('$-1\r\n');
    expect(await c.call('HMGET', 'h', 'f', 'nope', 'g')).toEqual(['x', null, 'y']);
    expect(await c.call('HMGET', 'missing', 'a', 'b')).toEqual([null, null]);
    expect(await c.call('HLEN', 'h')).toBe(2);
    expect(await c.call('HLEN', 'missing')).toBe(0);
    expect(await c.call('HEXISTS', 'h', 'g')).toBe(1);
    expect(await c.call('HEXISTS', 'h', 'z')).toBe(0);
    expect(await c.call('TYPE', 'h')).toBe('hash');
  });

  it('HSET with an odd number of field/value words is an arity error', async () => {
    expect(await c.raw('HSET', 'h', 'f', 'v', 'g')).toBe(
      err("ERR wrong number of arguments for 'hset' command"),
    );
    expect(await c.call('EXISTS', 'h')).toBe(0);
  });

  it('binary fields and values round-trip', async () => {
    const all = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i));
    await c.call('HSET', 'h', ...all.flatMap((b) => [b, b + b]));
    expect(await c.call('HLEN', 'h')).toBe(256);
    for (const b of ['\x00', '\xff', '\r', '\n']) expect(await c.call('HGET', 'h', b)).toBe(b + b);
  });
});

describe('HDEL, HKEYS, HVALS, HGETALL', () => {
  it('HDEL counts removed fields and deletes the emptied key', async () => {
    await c.call('HSET', 'h', 'a', '1', 'b', '2');
    expect(await c.call('HDEL', 'h', 'a', 'a', 'zz')).toBe(1);
    expect(await c.call('HDEL', 'missing', 'a')).toBe(0);
    expect(await c.call('HDEL', 'h', 'b')).toBe(1);
    expect(await c.call('EXISTS', 'h')).toBe(0);
  });

  it('HKEYS, HVALS and HGETALL return everything; missing keys are empty', async () => {
    await c.call('HSET', 'h', 'a', '1', 'b', '2', 'c', '3');
    expect(sorted(await c.call('HKEYS', 'h'))).toEqual(['a', 'b', 'c']);
    expect(sorted(await c.call('HVALS', 'h'))).toEqual(['1', '2', '3']);
    const all = (await c.call('HGETALL', 'h')) as string[];
    const pairs: string[] = [];
    for (let i = 0; i < all.length; i += 2) pairs.push(`${all[i]}=${all[i + 1]}`);
    expect(pairs.sort()).toEqual(['a=1', 'b=2', 'c=3']);
    expect(await c.raw('HGETALL', 'missing')).toBe('*0\r\n');
    expect(await c.raw('HKEYS', 'missing')).toBe('*0\r\n');
  });

  it('WRONGTYPE for hash commands on a string, and string commands on a hash', async () => {
    await c.call('SET', 's', 'v');
    for (const argv of [
      ['HSET', 's', 'f', 'v'],
      ['HGET', 's', 'f'],
      ['HMGET', 's', 'f'],
      ['HDEL', 's', 'f'],
      ['HLEN', 's'],
      ['HEXISTS', 's', 'f'],
      ['HKEYS', 's'],
      ['HVALS', 's'],
      ['HGETALL', 's'],
      ['HINCRBY', 's', 'f', '1'],
      ['HINCRBYFLOAT', 's', 'f', '1'],
      ['HSCAN', 's', '0'],
    ]) {
      expect(await c.raw(...argv), argv.join(' ')).toBe(WRONGTYPE);
    }
    await c.call('HSET', 'h', 'f', 'v');
    expect(await c.raw('GET', 'h')).toBe(WRONGTYPE);
    expect(await c.raw('LPUSH', 'h', 'x')).toBe(WRONGTYPE);
  });
});

describe('HINCRBY and HINCRBYFLOAT', () => {
  it('HINCRBY adds in int64 and catches overflow and non-integer values', async () => {
    expect(await c.call('HINCRBY', 'h', 'n', '5')).toBe(5);
    expect(await c.call('HINCRBY', 'h', 'n', '-7')).toBe(-2);
    await c.call('HSET', 'h', 'big', '9223372036854775807', 'fl', '1.5', 'sp', ' 1');
    expect(await c.raw('HINCRBY', 'h', 'big', '1')).toBe(
      err('ERR increment or decrement would overflow'),
    );
    expect(await c.raw('HINCRBY', 'h', 'fl', '1')).toBe(err('ERR hash value is not an integer'));
    expect(await c.raw('HINCRBY', 'h', 'sp', '1')).toBe(err('ERR hash value is not an integer'));
    expect(await c.raw('HINCRBY', 'h', 'n', 'abc')).toBe(
      err('ERR value is not an integer or out of range'),
    );
    expect(await c.call('HGET', 'h', 'big')).toBe('9223372036854775807');
  });

  it('HINCRBYFLOAT adds doubles and checks the increment, the value and the result', async () => {
    expect(await c.call('HINCRBYFLOAT', 'h', 'x', '1.5')).toBe('1.5');
    expect(await c.call('HINCRBYFLOAT', 'h', 'x', '0.25')).toBe('1.75');
    expect(await c.call('HINCRBYFLOAT', 'h', 'e', '5e20')).toBe('500000000000000000000');
    await c.call('HSET', 'h', 'word', 'abc', 'max', '1.7976931348623157e308');
    expect(await c.raw('HINCRBYFLOAT', 'h', 'word', '1')).toBe(
      err('ERR hash value is not a float'),
    );
    expect(await c.raw('HINCRBYFLOAT', 'h', 'x', 'abc')).toBe(
      err('ERR value is not a valid float'),
    );
    expect(await c.raw('HINCRBYFLOAT', 'h', 'x', 'inf')).toBe(err('ERR value is NaN or Infinity'));
    expect(await c.raw('HINCRBYFLOAT', 'h', 'max', '1.7976931348623157e308')).toBe(
      err('ERR increment would produce NaN or Infinity'),
    );
    expect(await c.call('HGET', 'h', 'x')).toBe('1.75');
  });

  it('HINCRBYFLOAT propagates as HSET with the result; HINCRBY as sent', async () => {
    await c.call('HINCRBYFLOAT', 'h', 'f', '2.5');
    await c.call('HINCRBY', 'h', 'n', '3');
    expect(records).toEqual([
      { db: 0, argv: ['HSET', 'h', 'f', '2.5'] },
      { db: 0, argv: ['HINCRBY', 'h', 'n', '3'] },
    ]);
  });

  it('a failed increment creates nothing', async () => {
    expect(await c.raw('HINCRBYFLOAT', 'h', 'f', 'inf')).toMatch(/^-ERR/);
    expect(await c.raw('HINCRBY', 'h', 'f', 'x')).toMatch(/^-ERR/);
    expect(await c.call('EXISTS', 'h')).toBe(0);
    expect(records).toEqual([]);
  });
});

describe('HSCAN', () => {
  it('returns every field with its value over a full scan', async () => {
    const fields = Array.from({ length: 300 }, (_, i) => `f${i}`);
    await c.call('HSET', 'h', ...fields.flatMap((f) => [f, `v${f}`]));
    const seen = new Map<string, string>();
    let cursor = '0';
    do {
      const [next, items] = (await c.call('HSCAN', 'h', cursor, 'COUNT', '20')) as [
        string,
        string[],
      ];
      for (let i = 0; i < items.length; i += 2) seen.set(items[i]!, items[i + 1]!);
      cursor = next;
    } while (cursor !== '0');
    expect(seen.size).toBe(300);
    expect(seen.get('f42')).toBe('vf42');
  });

  it('MATCH filters fields; a missing key is an empty scan; bad options error', async () => {
    await c.call('HSET', 'h', 'a1', '1', 'a2', '2', 'b1', '3');
    const [cursor, items] = (await c.call('HSCAN', 'h', '0', 'MATCH', 'a*', 'COUNT', '100')) as [
      string,
      string[],
    ];
    expect(cursor).toBe('0');
    expect(items.filter((_, i) => i % 2 === 0).sort()).toEqual(['a1', 'a2']);
    expect(await c.raw('HSCAN', 'missing', '0')).toBe('*2\r\n$1\r\n0\r\n*0\r\n');
    expect(await c.raw('HSCAN', 'h', 'x')).toBe(err('ERR invalid cursor'));
    expect(await c.raw('HSCAN', 'h', '0', 'TYPE', 'hash')).toBe(err('ERR syntax error'));
    expect(await c.raw('HSCAN', 'h', '0', 'COUNT', '0')).toBe(err('ERR syntax error'));
  });
});

/** A client switched to RESP3 on the server side (HELLO arrives in step 22). */
async function resp3Client(): Promise<TestClient> {
  const r3 = await TestClient.connect(t.port);
  const id = (await r3.call('CLIENT', 'ID')) as number;
  t.server.clients.get(id)!.reply.resp = 3;
  return r3;
}

describe('RESP3', () => {
  it('HGETALL is a map', async () => {
    const r3 = await resp3Client();
    try {
      await r3.call('HSET', 'h', 'f', 'v');
      expect(await r3.raw('HGETALL', 'h')).toBe('%1\r\n$1\r\nf\r\n$1\r\nv\r\n');
      expect(await r3.raw('HGETALL', 'missing')).toBe('%0\r\n');
      expect(await r3.raw('HKEYS', 'h')).toBe('*1\r\n$1\r\nf\r\n');
    } finally {
      r3.socket.destroy();
    }
  });
});
