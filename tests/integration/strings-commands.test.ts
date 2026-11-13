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

describe('SET options', () => {
  it('NX only sets a missing key, XX only an existing one', async () => {
    expect(await c.raw('SET', 'k', '1', 'NX')).toBe('+OK\r\n');
    expect(await c.raw('SET', 'k', '2', 'NX')).toBe('$-1\r\n');
    expect(await c.call('GET', 'k')).toBe('1');
    expect(await c.raw('SET', 'k', '3', 'XX')).toBe('+OK\r\n');
    expect(await c.raw('SET', 'nope', '3', 'XX')).toBe('$-1\r\n');
    expect(await c.call('GET', 'nope')).toBeNull();
  });

  it('options are case-insensitive', async () => {
    expect(await c.raw('set', 'k', '1', 'nx')).toBe('+OK\r\n');
    expect(await c.raw('set', 'k', '2', 'xX')).toBe('+OK\r\n');
  });

  it('GET returns the old value, or nil, and still sets', async () => {
    expect(await c.raw('SET', 'k', '1', 'GET')).toBe('$-1\r\n');
    expect(await c.raw('SET', 'k', '2', 'GET')).toBe('$1\r\n1\r\n');
    expect(await c.call('GET', 'k')).toBe('2');
  });

  it('NX with GET returns the old value and leaves it alone', async () => {
    await c.call('SET', 'k', 'old');
    expect(await c.raw('SET', 'k', 'new', 'NX', 'GET')).toBe('$3\r\nold\r\n');
    expect(await c.call('GET', 'k')).toBe('old');
  });

  it('clashing or unknown options are a syntax error and change nothing', async () => {
    await c.call('SET', 'k', 'v');
    const dirty = t.server.dirty;
    for (const opts of [['NX', 'XX'], ['XX', 'NX'], ['bogus'], ['NX', 'bogus']]) {
      expect(await c.raw('SET', 'k', 'new', ...opts), opts.join(' ')).toBe(err('ERR syntax error'));
    }
    expect(await c.call('GET', 'k')).toBe('v');
    expect(t.server.dirty).toBe(dirty);
  });

  it('repeating an option is allowed, as in Redis', async () => {
    expect(await c.raw('SET', 'k', '1', 'NX', 'NX')).toBe('+OK\r\n');
    expect(await c.raw('SET', 'k', '2', 'GET', 'GET')).toBe('$1\r\n1\r\n');
  });

  it('a SET that NX or XX skipped is not propagated', async () => {
    await c.call('SET', 'k', '1');
    records.length = 0;
    await c.call('SET', 'k', '2', 'NX');
    await c.call('SET', 'other', '2', 'XX');
    expect(records).toEqual([]);
  });
});

describe('GETDEL, MGET, MSET', () => {
  it('GETDEL returns the value and removes the key', async () => {
    await c.call('SET', 'k', 'v');
    expect(await c.raw('GETDEL', 'k')).toBe('$1\r\nv\r\n');
    expect(await c.raw('GETDEL', 'k')).toBe('$-1\r\n');
    expect(await c.call('EXISTS', 'k')).toBe(0);
    expect(records).toEqual([
      { db: 0, argv: ['SET', 'k', 'v'] },
      { db: 0, argv: ['GETDEL', 'k'] },
    ]);
  });

  it('MGET returns nil for missing keys', async () => {
    await c.call('SET', 'a', '1');
    await c.call('SET', 'c', '3');
    expect(await c.call('MGET', 'a', 'b', 'c', 'a')).toEqual(['1', null, '3', '1']);
    expect(await c.raw('MGET')).toBe(err("ERR wrong number of arguments for 'mget' command"));
  });

  it('MSET sets every pair; an odd count is a wrong-arity error', async () => {
    expect(await c.raw('MSET', 'a', '1', 'b', '2')).toBe('+OK\r\n');
    expect(await c.call('MGET', 'a', 'b')).toEqual(['1', '2']);
    expect(await c.raw('MSET', 'a', '1', 'b')).toBe(
      err("ERR wrong number of arguments for 'mset' command"),
    );
    expect(await c.call('GET', 'a')).toBe('1');
  });

  it('MSET with a repeated key keeps the last value and marks every pair dirty', async () => {
    const dirty = t.server.dirty;
    await c.call('MSET', 'a', '1', 'a', '2');
    expect(await c.call('GET', 'a')).toBe('2');
    expect(t.server.dirty).toBe(dirty + 2);
  });
});

describe('APPEND and STRLEN', () => {
  it('APPEND creates or extends and returns the new length', async () => {
    expect(await c.call('APPEND', 'k', 'ab')).toBe(2);
    expect(await c.call('APPEND', 'k', 'cde')).toBe(5);
    expect(await c.call('GET', 'k')).toBe('abcde');
    expect(await c.call('APPEND', 'k', '')).toBe(5);
  });

  it('STRLEN counts bytes, and is 0 for a missing key', async () => {
    await c.call('SET', 'k', '\xff\xfe\x00');
    expect(await c.call('STRLEN', 'k')).toBe(3);
    expect(await c.call('STRLEN', 'nope')).toBe(0);
  });
});

describe('INCR family', () => {
  it('counts from zero and returns the new value', async () => {
    expect(await c.call('INCR', 'n')).toBe(1);
    expect(await c.call('INCRBY', 'n', '10')).toBe(11);
    expect(await c.call('DECR', 'n')).toBe(10);
    expect(await c.call('DECRBY', 'n', '25')).toBe(-15);
    expect(await c.call('GET', 'n')).toBe('-15');
  });

  it('rejects stored values that are not strict integers', async () => {
    for (const bad of ['abc', '1.5', ' 1', '+1', '007', '-0', '', '9223372036854775808']) {
      await c.call('SET', 'n', bad);
      expect(await c.raw('INCR', 'n'), JSON.stringify(bad)).toBe(NOT_INT);
      expect(await c.call('GET', 'n')).toBe(bad);
    }
  });

  it('rejects a bad increment', async () => {
    expect(await c.raw('INCRBY', 'n', 'x')).toBe(NOT_INT);
    expect(await c.raw('INCRBY', 'n', '1.5')).toBe(NOT_INT);
    expect(await c.raw('DECRBY', 'n', '-9223372036854775808')).toBe(
      err('ERR decrement would overflow'),
    );
  });

  it('is exact up to int64 and overflows past it (spec 7.2)', async () => {
    await c.call('SET', 'n', '9223372036854775806');
    expect(await c.call('INCR', 'n')).toBe(9223372036854775807n);
    expect(await c.raw('INCR', 'n')).toBe(err('ERR increment or decrement would overflow'));
    expect(await c.call('GET', 'n')).toBe('9223372036854775807');
    await c.call('SET', 'm', '-9223372036854775808');
    expect(await c.raw('DECR', 'm')).toBe(err('ERR increment or decrement would overflow'));
  });

  it('is propagated as it arrived', async () => {
    await c.call('INCRBY', 'n', '5');
    expect(records).toEqual([{ db: 0, argv: ['INCRBY', 'n', '5'] }]);
  });
});

describe('INCRBYFLOAT', () => {
  it('adds floats and prints them without exponent', async () => {
    expect(await c.call('INCRBYFLOAT', 'f', '1.5')).toBe('1.5');
    expect(await c.call('INCRBYFLOAT', 'f', '0.25')).toBe('1.75');
    expect(await c.call('INCRBYFLOAT', 'f', '-2')).toBe('-0.25');
    await c.call('SET', 'big', '1e3');
    expect(await c.call('INCRBYFLOAT', 'big', '1')).toBe('1001');
  });

  it('rejects non-floats and results that are NaN or infinite', async () => {
    expect(await c.raw('INCRBYFLOAT', 'f', 'abc')).toBe(err('ERR value is not a valid float'));
    expect(await c.raw('INCRBYFLOAT', 'f', 'nan')).toBe(err('ERR value is not a valid float'));
    await c.call('SET', 'f', 'xyz');
    expect(await c.raw('INCRBYFLOAT', 'f', '1')).toBe(err('ERR value is not a valid float'));
    await c.call('SET', 'f', '1');
    expect(await c.raw('INCRBYFLOAT', 'f', 'inf')).toBe(
      err('ERR increment would produce NaN or Infinity'),
    );
    expect(await c.call('GET', 'f')).toBe('1');
  });

  it('propagates as SET key result KEEPTTL (spec 9.5)', async () => {
    await c.call('INCRBYFLOAT', 'f', '3.5');
    expect(records).toEqual([{ db: 0, argv: ['SET', 'f', '3.5', 'KEEPTTL'] }]);
  });
});

describe('GETRANGE and SETRANGE', () => {
  beforeEach(async () => {
    await c.call('SET', 's', 'Hello World');
  });

  it('GETRANGE is inclusive and negative indexes count from the end', async () => {
    expect(await c.call('GETRANGE', 's', '0', '4')).toBe('Hello');
    expect(await c.call('GETRANGE', 's', '-5', '-1')).toBe('World');
    expect(await c.call('GETRANGE', 's', '0', '-1')).toBe('Hello World');
    expect(await c.call('GETRANGE', 's', '0', '100')).toBe('Hello World');
    expect(await c.call('GETRANGE', 's', '-100', '2')).toBe('Hel');
    expect(await c.call('GETRANGE', 's', '5', '2')).toBe('');
    expect(await c.call('GETRANGE', 's', '20', '30')).toBe('');
    expect(await c.call('GETRANGE', 'nope', '0', '-1')).toBe('');
  });

  it('GETRANGE accepts any int64 index and rejects non-integers', async () => {
    expect(await c.call('GETRANGE', 's', '0', '9223372036854775807')).toBe('Hello World');
    expect(await c.call('GETRANGE', 's', '-9223372036854775808', '2')).toBe('Hel');
    expect(await c.raw('GETRANGE', 's', 'a', '1')).toBe(NOT_INT);
  });

  it('SETRANGE overwrites, extends and zero-pads', async () => {
    expect(await c.call('SETRANGE', 's', '6', 'Redis')).toBe(11);
    expect(await c.call('GET', 's')).toBe('Hello Redis');
    expect(await c.call('SETRANGE', 's', '13', '!')).toBe(14);
    expect(await c.call('GET', 's')).toBe('Hello Redis\x00\x00!');
    expect(await c.call('SETRANGE', 'new', '3', 'x')).toBe(4);
    expect(await c.call('GET', 'new')).toBe('\x00\x00\x00x');
  });

  it('SETRANGE with an empty value never creates a key', async () => {
    expect(await c.call('SETRANGE', 'nope', '5', '')).toBe(0);
    expect(await c.call('EXISTS', 'nope')).toBe(0);
    expect(await c.call('SETRANGE', 's', '5', '')).toBe(11);
  });

  it('SETRANGE checks the offset and the size before changing anything', async () => {
    const dirty = t.server.dirty;
    expect(await c.raw('SETRANGE', 's', '-1', 'x')).toBe(err('ERR offset is out of range'));
    expect(await c.raw('SETRANGE', 's', 'x', 'x')).toBe(NOT_INT);
    expect(await c.raw('SETRANGE', 's', '67108864', 'x')).toBe(
      err('ERR string exceeds maximum allowed size (proto-max-bulk-len)'),
    );
    expect(await c.call('GET', 's')).toBe('Hello World');
    expect(t.server.dirty).toBe(dirty);
  });
});

describe('wrong arity and arguments', () => {
  it('uses the lowercase command name', async () => {
    for (const [argv, name] of [
      [['STRLEN'], 'strlen'],
      [['APPEND', 'k'], 'append'],
      [['INCR'], 'incr'],
      [['INCRBY', 'k'], 'incrby'],
      [['GETRANGE', 'k', '0'], 'getrange'],
      [['SETRANGE', 'k', '0'], 'setrange'],
      [['GETDEL'], 'getdel'],
    ] as const) {
      expect(await c.raw(...argv)).toBe(err(`ERR wrong number of arguments for '${name}' command`));
    }
  });
});
