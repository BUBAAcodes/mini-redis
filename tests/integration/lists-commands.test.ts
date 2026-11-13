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
const NOT_INT = err('ERR value is not an integer or out of range');
const WRONGTYPE = err('WRONGTYPE Operation against a key holding the wrong kind of value');
const NOT_POSITIVE = err('ERR value is out of range, must be positive');
const range = (key: string) => c.call('LRANGE', key, '0', '-1');

describe('LPUSH, RPUSH, LLEN, LRANGE', () => {
  it('push at either end and reply with the new length', async () => {
    expect(await c.call('RPUSH', 'l', 'a', 'b')).toBe(2);
    expect(await c.call('LPUSH', 'l', 'x', 'y')).toBe(4);
    expect(await range('l')).toEqual(['y', 'x', 'a', 'b']);
    expect(await c.call('LLEN', 'l')).toBe(4);
    expect(await c.call('LLEN', 'missing')).toBe(0);
    expect(await c.call('TYPE', 'l')).toBe('list');
  });

  it('LRANGE clamps like Redis', async () => {
    await c.call('RPUSH', 'l', 'a', 'b', 'c', 'd');
    expect(await c.call('LRANGE', 'l', '1', '2')).toEqual(['b', 'c']);
    expect(await c.call('LRANGE', 'l', '-2', '100')).toEqual(['c', 'd']);
    expect(await c.call('LRANGE', 'l', '-100', '0')).toEqual(['a']);
    expect(await c.call('LRANGE', 'l', '3', '1')).toEqual([]);
    expect(await c.call('LRANGE', 'l', '10', '20')).toEqual([]);
    expect(await c.raw('LRANGE', 'missing', '0', '-1')).toBe('*0\r\n');
    expect(await c.raw('LRANGE', 'l', 'a', '1')).toBe(NOT_INT);
    expect(await c.call('LRANGE', 'l', '-9223372036854775808', '9223372036854775807')).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('a list holds any bytes, across node splits', async () => {
    const all = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i));
    expect(await c.call('RPUSH', 'bin', ...all)).toBe(256);
    expect(await range('bin')).toEqual(all);
  });

  it('WRONGTYPE for every list command on a string', async () => {
    await c.call('SET', 's', 'v');
    for (const argv of [
      ['LPUSH', 's', 'x'],
      ['RPUSH', 's', 'x'],
      ['LPOP', 's'],
      ['RPOP', 's', '2'],
      ['LLEN', 's'],
      ['LRANGE', 's', '0', '-1'],
      ['LINDEX', 's', '0'],
      ['LSET', 's', '0', 'x'],
      ['LINSERT', 's', 'BEFORE', 'a', 'b'],
      ['LREM', 's', '0', 'a'],
      ['LTRIM', 's', '0', '1'],
      ['LMOVE', 's', 'd', 'LEFT', 'LEFT'],
    ]) {
      expect(await c.raw(...argv), argv.join(' ')).toBe(WRONGTYPE);
    }
    expect(await c.raw('GET', 's')).toBe('$1\r\nv\r\n');
    await c.call('RPUSH', 'l', 'a');
    expect(await c.raw('GET', 'l')).toBe(WRONGTYPE);
  });

  it('wrong arity', async () => {
    expect(await c.raw('LPUSH', 'l')).toBe(
      err("ERR wrong number of arguments for 'lpush' command"),
    );
    expect(await c.raw('LPOP', 'l', '1', '2')).toBe(
      err("ERR wrong number of arguments for 'lpop' command"),
    );
  });
});

describe('LPOP and RPOP', () => {
  it('pop one, or a count, and delete the emptied key', async () => {
    await c.call('RPUSH', 'l', 'a', 'b', 'c', 'd');
    expect(await c.raw('LPOP', 'l')).toBe('$1\r\na\r\n');
    expect(await c.call('RPOP', 'l', '2')).toEqual(['d', 'c']);
    expect(await c.raw('LPOP', 'l', '0')).toBe('*0\r\n');
    expect(await c.call('LPOP', 'l', '100')).toEqual(['b']);
    expect(await c.call('EXISTS', 'l')).toBe(0);
  });

  it('a missing key is a nil bulk, or a nil array with a count', async () => {
    expect(await c.raw('LPOP', 'missing')).toBe('$-1\r\n');
    expect(await c.raw('LPOP', 'missing', '2')).toBe('*-1\r\n');
    expect(await c.raw('RPOP', 'missing', '0')).toBe('*-1\r\n');
  });

  it('a negative or non-integer count is out of range', async () => {
    await c.call('RPUSH', 'l', 'a');
    expect(await c.raw('LPOP', 'l', '-1')).toBe(NOT_POSITIVE);
    expect(await c.raw('LPOP', 'l', 'abc')).toBe(NOT_POSITIVE);
    expect(await c.raw('LPOP', 'missing', 'abc')).toBe(NOT_POSITIVE);
    expect(await range('l')).toEqual(['a']);
  });

  it('a pop that took nothing is not propagated; an emptying pop propagates as sent', async () => {
    await c.call('RPUSH', 'l', 'a');
    records.length = 0;
    await c.call('LPOP', 'l', '0');
    await c.call('LPOP', 'missing');
    expect(records).toEqual([]);
    await c.call('LPOP', 'l');
    expect(records).toEqual([{ db: 0, argv: ['LPOP', 'l'] }]);
  });
});

describe('LINDEX and LSET', () => {
  it('index from either end', async () => {
    await c.call('RPUSH', 'l', 'a', 'b', 'c');
    expect(await c.call('LINDEX', 'l', '0')).toBe('a');
    expect(await c.call('LINDEX', 'l', '-1')).toBe('c');
    expect(await c.raw('LINDEX', 'l', '3')).toBe('$-1\r\n');
    expect(await c.raw('LINDEX', 'missing', '0')).toBe('$-1\r\n');
    expect(await c.raw('LINDEX', 'l', 'x')).toBe(NOT_INT);
  });

  it('LSET replaces an item, and checks the key before the index', async () => {
    await c.call('RPUSH', 'l', 'a', 'b', 'c');
    expect(await c.raw('LSET', 'l', '-1', 'z')).toBe('+OK\r\n');
    expect(await range('l')).toEqual(['a', 'b', 'z']);
    expect(await c.raw('LSET', 'l', '3', 'x')).toBe(err('ERR index out of range'));
    expect(await c.raw('LSET', 'missing', 'abc', 'x')).toBe(err('ERR no such key'));
    expect(await c.raw('LSET', 'l', 'abc', 'x')).toBe(NOT_INT);
  });
});

describe('LINSERT', () => {
  it('inserts before or after the first matching pivot', async () => {
    await c.call('RPUSH', 'l', 'a', 'b', 'a');
    expect(await c.call('LINSERT', 'l', 'BEFORE', 'a', 'x')).toBe(4);
    expect(await c.call('LINSERT', 'l', 'after', 'b', 'y')).toBe(5);
    expect(await range('l')).toEqual(['x', 'a', 'b', 'y', 'a']);
  });

  it('-1 for a missing pivot, 0 for a missing key, syntax error for a bad position', async () => {
    await c.call('RPUSH', 'l', 'a');
    expect(await c.call('LINSERT', 'l', 'BEFORE', 'zz', 'x')).toBe(-1);
    expect(await c.call('LINSERT', 'missing', 'BEFORE', 'a', 'x')).toBe(0);
    expect(await c.raw('LINSERT', 'l', 'MIDDLE', 'a', 'x')).toBe(err('ERR syntax error'));
    expect(await c.call('EXISTS', 'missing')).toBe(0);
    expect(records.filter((r) => r.argv[0] === 'LINSERT')).toEqual([]);
  });
});

describe('LREM and LTRIM', () => {
  it('LREM removes from the head, the tail, or everywhere', async () => {
    await c.call('RPUSH', 'l', 'a', 'b', 'a', 'c', 'a');
    expect(await c.call('LREM', 'l', '1', 'a')).toBe(1);
    expect(await c.call('LREM', 'l', '-1', 'a')).toBe(1);
    expect(await range('l')).toEqual(['b', 'a', 'c']);
    expect(await c.call('LREM', 'l', '0', 'a')).toBe(1);
    expect(await c.call('LREM', 'missing', '0', 'a')).toBe(0);
    expect(await c.raw('LREM', 'l', 'x', 'a')).toBe(NOT_INT);
    expect(await c.call('LREM', 'l', '0', 'b')).toBe(1);
    expect(await c.call('LREM', 'l', '0', 'c')).toBe(1);
    expect(await c.call('EXISTS', 'l')).toBe(0);
  });

  it('LTRIM keeps a range, and deletes the key when nothing is left', async () => {
    await c.call('RPUSH', 'l', 'a', 'b', 'c', 'd', 'e');
    expect(await c.raw('LTRIM', 'l', '1', '-2')).toBe('+OK\r\n');
    expect(await range('l')).toEqual(['b', 'c', 'd']);
    expect(await c.raw('LTRIM', 'missing', '0', '1')).toBe('+OK\r\n');
    expect(await c.raw('LTRIM', 'missing', 'a', 'b')).toBe(NOT_INT);
    expect(await c.raw('LTRIM', 'l', '5', '10')).toBe('+OK\r\n');
    expect(await c.call('EXISTS', 'l')).toBe(0);
  });

  it('an LTRIM that removed nothing is not propagated', async () => {
    await c.call('RPUSH', 'l', 'a', 'b');
    records.length = 0;
    await c.call('LTRIM', 'l', '0', '-1');
    expect(records).toEqual([]);
  });
});

describe('LMOVE', () => {
  it('moves between lists and creates the destination', async () => {
    await c.call('RPUSH', 'src', 'a', 'b', 'c');
    expect(await c.call('LMOVE', 'src', 'dst', 'RIGHT', 'LEFT')).toBe('c');
    expect(await c.call('LMOVE', 'src', 'dst', 'left', 'right')).toBe('a');
    expect(await range('dst')).toEqual(['c', 'a']);
    expect(await c.call('LMOVE', 'src', 'dst', 'LEFT', 'LEFT')).toBe('b');
    expect(await c.call('EXISTS', 'src')).toBe(0);
  });

  it('the same key rotates', async () => {
    await c.call('RPUSH', 'l', 'a', 'b', 'c');
    expect(await c.call('LMOVE', 'l', 'l', 'RIGHT', 'LEFT')).toBe('c');
    expect(await range('l')).toEqual(['c', 'a', 'b']);
  });

  it('nil for a missing source; WRONGTYPE for a non-list destination; syntax errors', async () => {
    expect(await c.raw('LMOVE', 'missing', 'd', 'LEFT', 'LEFT')).toBe('$-1\r\n');
    await c.call('RPUSH', 'l', 'a');
    await c.call('SET', 's', 'v');
    expect(await c.raw('LMOVE', 'l', 's', 'LEFT', 'LEFT')).toBe(WRONGTYPE);
    expect(await c.raw('LMOVE', 'l', 'd', 'UP', 'LEFT')).toBe(err('ERR syntax error'));
    expect(await range('l')).toEqual(['a']);
  });
});

describe('lists and expiry', () => {
  it('a list keeps its TTL across pushes and loses it when it empties', async () => {
    await c.call('RPUSH', 'l', 'a');
    await c.call('EXPIRE', 'l', '100');
    await c.call('RPUSH', 'l', 'b');
    expect(await c.call('TTL', 'l')).toBeGreaterThan(90);
    await c.call('LPOP', 'l', '2');
    await c.call('RPUSH', 'l', 'c');
    expect(await c.call('TTL', 'l')).toBe(-1);
  });
});
