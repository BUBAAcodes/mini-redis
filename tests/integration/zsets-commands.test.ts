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
const SYNTAX = err('ERR syntax error');
const NOT_FLOAT = err('ERR value is not a valid float');
const MINMAX = err('ERR min or max is not a float');
const LEX = err('ERR min or max not valid string range item');
const bulks = (...xs: string[]) =>
  `*${xs.length}\r\n${xs.map((x) => `$${x.length}\r\n${x}\r\n`).join('')}`;
const abcde = () => c.call('ZADD', 'z', '1', 'a', '2', 'b', '3', 'c', '4', 'd', '5', 'e');

describe('ZADD', () => {
  it('adds, updates and counts; CH counts changes too', async () => {
    expect(await c.call('ZADD', 'z', '1', 'a', '2', 'b')).toBe(2);
    expect(await c.call('ZADD', 'z', 'CH', '10', 'a', '3', 'c')).toBe(2);
    expect(await c.call('ZADD', 'z', '10', 'a')).toBe(0);
    expect(await c.raw('ZRANGE', 'z', '0', '-1', 'WITHSCORES')).toBe(
      bulks('b', '2', 'c', '3', 'a', '10'),
    );
    expect(await c.call('TYPE', 'z')).toBe('zset');
  });

  it('NX, XX, GT and LT', async () => {
    await c.call('ZADD', 'z', '5', 'a');
    expect(await c.call('ZADD', 'z', 'NX', '1', 'a', '1', 'b')).toBe(1);
    expect(await c.call('ZADD', 'z', 'XX', '7', 'a', '1', 'nope')).toBe(0);
    expect(await c.call('ZSCORE', 'z', 'a')).toBe('7');
    expect(await c.call('EXISTS', 'nope')).toBe(0);
    expect(await c.call('ZADD', 'z', 'GT', 'CH', '6', 'a')).toBe(0);
    expect(await c.call('ZADD', 'z', 'GT', 'CH', '8', 'a')).toBe(1);
    expect(await c.call('ZADD', 'z', 'LT', 'CH', '9', 'a', '0', 'b')).toBe(1);
    expect(await c.raw('ZADD', 'z', 'GT', '1', 'new')).toBe(':1\r\n');
    expect(await c.call('ZADD', 'missing', 'XX', '1', 'a')).toBe(0);
    expect(await c.call('EXISTS', 'missing')).toBe(0);
  });

  it('INCR returns the new score, or nil when a flag stopped it', async () => {
    await c.call('ZADD', 'z', '1', 'a');
    expect(await c.raw('ZADD', 'z', 'INCR', '5', 'a')).toBe('$1\r\n6\r\n');
    expect(await c.raw('ZADD', 'z', 'NX', 'INCR', '5', 'a')).toBe('$-1\r\n');
    expect(await c.raw('ZADD', 'z', 'XX', 'INCR', '5', 'nope')).toBe('$-1\r\n');
    expect(await c.raw('ZADD', 'z', 'LT', 'INCR', '100', 'a')).toBe('$-1\r\n');
    expect(await c.raw('ZADD', 'z', 'INCR', '0', 'a')).toBe('$1\r\n6\r\n');
  });

  it('rejects clashing flags, bad pairs and bad scores, changing nothing', async () => {
    await c.call('ZADD', 'z', '1', 'a');
    expect(await c.raw('ZADD', 'z', 'NX', 'XX', '1', 'a')).toBe(
      err('ERR XX and NX options at the same time are not compatible'),
    );
    for (const f of [
      ['GT', 'LT'],
      ['NX', 'GT'],
      ['LT', 'NX'],
    ]) {
      expect(await c.raw('ZADD', 'z', ...f, '1', 'a')).toBe(
        err('ERR GT, LT, and/or NX options at the same time are not compatible'),
      );
    }
    expect(await c.raw('ZADD', 'z', 'INCR', '1', 'a', '2', 'b')).toBe(
      err('ERR INCR option supports a single increment-element pair'),
    );
    expect(await c.raw('ZADD', 'z', '1', 'a', '2')).toBe(SYNTAX);
    expect(await c.raw('ZADD', 'z', 'bogus', '1', 'a')).toBe(SYNTAX);
    expect(await c.raw('ZADD', 'z', '1')).toBe(
      err("ERR wrong number of arguments for 'zadd' command"),
    );
    for (const bad of ['abc', 'nan', '', ' 1', '1e400', '1e-400']) {
      expect(await c.raw('ZADD', 'z', '9', 'b', bad, 'c'), JSON.stringify(bad)).toBe(NOT_FLOAT);
    }
    expect(await c.call('ZCARD', 'z')).toBe(1);
    expect(records.filter((r) => r.argv[0] !== 'ZADD' || r.argv[2] !== '1')).toEqual([]);
  });

  it('accepts what strtod accepts: +1, .5, 5., inf, infinity', async () => {
    expect(
      await c.call('ZADD', 'z', '+1', 'a', '.5', 'b', '5.', 'c', 'infinity', 'd', '-inf', 'e'),
    ).toBe(5);
    expect(await c.raw('ZRANGE', 'z', '0', '-1', 'WITHSCORES')).toBe(
      bulks('e', '-inf', 'b', '0.5', 'a', '1', 'c', '5', 'd', 'inf'),
    );
  });

  it('ZINCRBY, and a NaN result is an error that changes nothing', async () => {
    expect(await c.call('ZINCRBY', 'z', '2.5', 'a')).toBe('2.5');
    expect(await c.call('ZINCRBY', 'z', '-1', 'a')).toBe('1.5');
    await c.call('ZADD', 'z', 'inf', 'x');
    expect(await c.raw('ZINCRBY', 'z', '-inf', 'x')).toBe(
      err('ERR resulting score is not a number (NaN)'),
    );
    expect(await c.raw('ZADD', 'z', 'INCR', '-inf', 'x')).toBe(
      err('ERR resulting score is not a number (NaN)'),
    );
    expect(await c.call('ZSCORE', 'z', 'x')).toBe('inf');
    expect(await c.raw('ZINCRBY', 'z', 'abc', 'a')).toBe(NOT_FLOAT);
  });

  it('-0: the computing reply says -0, the stored score is 0 (as in a small Redis zset)', async () => {
    expect(await c.raw('ZINCRBY', 'z', '-0', 'm')).toBe('$2\r\n-0\r\n');
    expect(await c.raw('ZADD', 'z', 'INCR', '-0', 'n')).toBe('$2\r\n-0\r\n');
    expect(await c.raw('ZSCORE', 'z', 'm')).toBe('$1\r\n0\r\n');
    expect(await c.raw('ZINCRBY', 'z', '-0', 'm')).toBe('$1\r\n0\r\n');
    await c.call('ZADD', 'y', '0', 'p');
    await c.call('ZUNIONSTORE', 'd', '1', 'y', 'WEIGHTS', '-0.25');
    expect(await c.raw('ZSCORE', 'd', 'p')).toBe('$1\r\n0\r\n');
  });

  it('scores print like Redis', async () => {
    await c.call('ZADD', 'z', '1e30', 'a', '12345678901234567890', 'b', '0.1', 'c', '-0', 'd');
    expect(await c.call('ZSCORE', 'z', 'a')).toBe('1e+30');
    expect(await c.call('ZSCORE', 'z', 'b')).toBe('12345678901234567000');
    expect(await c.call('ZSCORE', 'z', 'c')).toBe('0.1');
    expect(await c.call('ZSCORE', 'z', 'd')).toBe('0');
    expect(await c.raw('ZSCORE', 'z', 'nope')).toBe('$-1\r\n');
    expect(await c.raw('ZSCORE', 'missing', 'a')).toBe('$-1\r\n');
  });
});

describe('ZRANGE and friends', () => {
  beforeEach(abcde);

  it('by rank, forwards and reversed', async () => {
    expect(await c.call('ZRANGE', 'z', '1', '3')).toEqual(['b', 'c', 'd']);
    expect(await c.call('ZRANGE', 'z', '-2', '100')).toEqual(['d', 'e']);
    expect(await c.call('ZRANGE', 'z', '0', '1', 'REV')).toEqual(['e', 'd']);
    expect(await c.raw('ZREVRANGE', 'z', '0', '1', 'WITHSCORES')).toBe(bulks('e', '5', 'd', '4'));
    expect(await c.raw('ZRANGE', 'z', '3', '1')).toBe('*0\r\n');
    expect(await c.raw('ZRANGE', 'missing', '0', '-1')).toBe('*0\r\n');
    expect(await c.raw('ZRANGE', 'z', '', '1')).toBe(
      err('ERR value is not an integer or out of range'),
    );
  });

  it('by score, with exclusive bounds, REV and LIMIT', async () => {
    expect(await c.call('ZRANGE', 'z', '(1', '3', 'BYSCORE')).toEqual(['b', 'c']);
    expect(await c.call('ZRANGE', 'z', '3', '(1', 'BYSCORE', 'REV')).toEqual(['c', 'b']);
    expect(await c.call('ZRANGEBYSCORE', 'z', '(1', '(5')).toEqual(['b', 'c', 'd']);
    expect(await c.raw('ZRANGEBYSCORE', 'z', '-inf', '+inf', 'WITHSCORES', 'LIMIT', '1', '2')).toBe(
      bulks('b', '2', 'c', '3'),
    );
    expect(await c.call('ZREVRANGEBYSCORE', 'z', '5', '1')).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(await c.raw('ZRANGEBYSCORE', 'z', '5', '1')).toBe('*0\r\n');
    expect(await c.call('ZRANGE', 'z', '-inf', '+inf', 'BYSCORE', 'LIMIT', '1', '-1')).toEqual([
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(await c.raw('ZRANGE', 'z', '-inf', '+inf', 'BYSCORE', 'LIMIT', '-1', '2')).toBe(
      '*0\r\n',
    );
    expect(await c.raw('ZRANGE', 'z', '-inf', '+inf', 'BYSCORE', 'LIMIT', '1', '0')).toBe('*0\r\n');
    expect(
      await c.call('ZRANGEBYSCORE', 'z', '1', '3', 'LIMIT', '0', '1', 'LIMIT', '1', '1'),
    ).toEqual(['b']);
  });

  it('score bounds are parsed like strtod: empty is 0, a leading space is fine', async () => {
    await c.call('ZADD', 'z', '0', 'zero');
    expect(await c.call('ZCOUNT', 'z', '', '+inf')).toBe(6);
    expect(await c.call('ZCOUNT', 'z', '(', '+inf')).toBe(5);
    expect(await c.call('ZCOUNT', 'z', ' 1', '+inf')).toBe(5);
    expect(await c.call('ZCOUNT', 'z', '( 1', '+inf')).toBe(4);
    expect(await c.call('ZCOUNT', 'z', '1e400', '+inf')).toBe(0);
    expect(await c.call('ZCOUNT', 'z', '-INF', '+Inf')).toBe(6);
    expect(await c.raw('ZCOUNT', 'z', '1 ', '+inf')).toBe(MINMAX);
    expect(await c.raw('ZCOUNT', 'z', 'x', '3')).toBe(MINMAX);
  });

  it('by lex', async () => {
    await c.call('DEL', 'z');
    await c.call('ZADD', 'z', '0', 'a', '0', 'b', '0', 'c', '0', 'd');
    expect(await c.call('ZRANGE', 'z', '[b', '[d', 'BYLEX')).toEqual(['b', 'c', 'd']);
    expect(await c.call('ZRANGE', 'z', '-', '+', 'BYLEX', 'LIMIT', '1', '2')).toEqual(['b', 'c']);
    expect(await c.call('ZRANGE', 'z', '(c', '[a', 'BYLEX', 'REV')).toEqual(['b', 'a']);
    expect(await c.raw('ZRANGE', 'z', '[a', '(c', 'BYLEX', 'REV')).toBe('*0\r\n');
    expect(await c.call('ZRANGEBYLEX', 'z', '[a', '(c')).toEqual(['a', 'b']);
    expect(await c.call('ZRANGE', 'z', '[', '[b', 'BYLEX')).toEqual(['a', 'b']);
    expect(await c.raw('ZRANGEBYLEX', 'z', 'a', 'c')).toBe(LEX);
    expect(await c.raw('ZRANGE', 'z', '-a', '+', 'BYLEX')).toBe(LEX);
    expect(await c.raw('ZRANGE', 'z', '0', '-1', 'BYLEX')).toBe(LEX);
  });

  it('option errors match Redis', async () => {
    expect(await c.raw('ZRANGE', 'z', '0', '-1', 'LIMIT', '0', '5')).toBe(
      err('ERR syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX'),
    );
    expect(await c.call('ZRANGE', 'z', '0', '-1', 'LIMIT', '1', '-1')).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(await c.raw('ZRANGE', 'z', '[a', '[c', 'BYLEX', 'WITHSCORES')).toBe(
      err('ERR syntax error, WITHSCORES not supported in combination with BYLEX'),
    );
    expect(await c.raw('ZRANGEBYLEX', 'z', '[a', '[c', 'WITHSCORES')).toBe(
      err('ERR syntax error, WITHSCORES not supported in combination with BYLEX'),
    );
    expect(await c.raw('ZRANGE', 'z', 'a', 'b', 'BYSCORE')).toBe(MINMAX);
    for (const argv of [
      ['ZRANGE', 'z', '0', '-1', 'bogus'],
      ['ZRANGE', 'z', '0', '-1', 'LIMIT', '0'],
      ['ZRANGEBYSCORE', 'z', '1', '3', 'BYSCORE'],
      ['ZRANGEBYSCORE', 'z', '1', '3', 'REV'],
      ['ZREVRANGE', 'z', '0', '-1', 'REV'],
      ['ZRANGEBYLEX', 'z', '-', '+', 'BYLEX'],
    ]) {
      expect(await c.raw(...argv), argv.join(' ')).toBe(SYNTAX);
    }
    expect(await c.raw('ZRANGEBYSCORE', 'z', '-inf', '+inf', 'LIMIT', 'a', '1')).toBe(
      err('ERR value is not an integer or out of range'),
    );
  });
});

describe('ZRANK, ZCOUNT, ZCARD, ZREM', () => {
  beforeEach(abcde);

  it('ZRANK and ZREVRANK, with WITHSCORE', async () => {
    expect(await c.call('ZRANK', 'z', 'c')).toBe(2);
    expect(await c.call('ZREVRANK', 'z', 'a')).toBe(4);
    expect(await c.raw('ZRANK', 'z', 'c', 'WITHSCORE')).toBe('*2\r\n:2\r\n$1\r\n3\r\n');
    expect(await c.raw('ZREVRANK', 'z', 'c', 'withscore')).toBe('*2\r\n:2\r\n$1\r\n3\r\n');
    expect(await c.raw('ZRANK', 'z', 'nope')).toBe('$-1\r\n');
    expect(await c.raw('ZRANK', 'z', 'nope', 'WITHSCORE')).toBe('*-1\r\n');
    expect(await c.raw('ZRANK', 'missing', 'a', 'WITHSCORE')).toBe('*-1\r\n');
    expect(await c.raw('ZRANK', 'z', 'c', 'bogus')).toBe(SYNTAX);
    expect(await c.raw('ZRANK', 'z', 'a', 'WITHSCORE', 'x')).toBe(
      err("ERR wrong number of arguments for 'zrank' command"),
    );
  });

  it('ZCOUNT and ZCARD', async () => {
    expect(await c.call('ZCOUNT', 'z', '(1', '3')).toBe(2);
    expect(await c.call('ZCOUNT', 'z', '-inf', '+inf')).toBe(5);
    expect(await c.call('ZCOUNT', 'z', '6', '9')).toBe(0);
    expect(await c.call('ZCOUNT', 'missing', '1', '2')).toBe(0);
    expect(await c.call('ZCARD', 'z')).toBe(5);
    expect(await c.call('ZCARD', 'missing')).toBe(0);
  });

  it('ZREM removes, deletes the emptied key, and a no-op is not propagated', async () => {
    records.length = 0;
    expect(await c.call('ZREM', 'z', 'nope')).toBe(0);
    expect(await c.call('ZREM', 'missing', 'a')).toBe(0);
    expect(records).toEqual([]);
    expect(await c.call('ZREM', 'z', 'a', 'b', 'nope')).toBe(2);
    expect(await c.call('ZREM', 'z', 'c', 'd', 'e')).toBe(3);
    expect(await c.call('EXISTS', 'z')).toBe(0);
  });

  it('WRONGTYPE on a string for every zset command', async () => {
    await c.call('SET', 's', 'v');
    for (const argv of [
      ['ZADD', 's', '1', 'a'],
      ['ZINCRBY', 's', '1', 'a'],
      ['ZSCORE', 's', 'a'],
      ['ZCARD', 's'],
      ['ZCOUNT', 's', '0', '1'],
      ['ZRANGE', 's', '0', '-1'],
      ['ZRANGEBYSCORE', 's', '0', '1'],
      ['ZREVRANGEBYSCORE', 's', '1', '0'],
      ['ZRANGEBYLEX', 's', '-', '+'],
      ['ZREVRANGE', 's', '0', '-1'],
      ['ZRANK', 's', 'a'],
      ['ZREVRANK', 's', 'a'],
      ['ZREM', 's', 'a'],
      ['ZREMRANGEBYRANK', 's', '0', '1'],
      ['ZREMRANGEBYSCORE', 's', '0', '1'],
      ['ZPOPMIN', 's'],
      ['ZPOPMAX', 's', '2'],
      ['ZSCAN', 's', '0'],
      ['ZUNIONSTORE', 'd', '2', 'z', 's'],
      ['ZINTERSTORE', 'd', '1', 's'],
    ]) {
      expect(await c.raw(...argv), argv.join(' ')).toBe(WRONGTYPE);
    }
    expect(await c.raw('GET', 'z')).toBe(WRONGTYPE);
  });
});

describe('ZREMRANGEBYRANK, ZREMRANGEBYSCORE, ZPOPMIN, ZPOPMAX', () => {
  beforeEach(abcde);

  it('remove ranges', async () => {
    expect(await c.call('ZREMRANGEBYRANK', 'z', '0', '0')).toBe(1);
    expect(await c.call('ZREMRANGEBYSCORE', 'z', '(3', '4')).toBe(1);
    expect(await c.call('ZRANGE', 'z', '0', '-1')).toEqual(['b', 'c', 'e']);
    expect(await c.call('ZREMRANGEBYRANK', 'z', '5', '10')).toBe(0);
    expect(await c.call('ZREMRANGEBYRANK', 'missing', '0', '1')).toBe(0);
    expect(await c.raw('ZREMRANGEBYRANK', 'z', 'a', '1')).toBe(
      err('ERR value is not an integer or out of range'),
    );
    expect(await c.raw('ZREMRANGEBYSCORE', 'z', 'x', '1')).toBe(MINMAX);
    expect(await c.call('ZREMRANGEBYRANK', 'z', '0', '-1')).toBe(3);
    expect(await c.call('EXISTS', 'z')).toBe(0);
  });

  it('pop from either end', async () => {
    expect(await c.raw('ZPOPMIN', 'z')).toBe(bulks('a', '1'));
    expect(await c.raw('ZPOPMAX', 'z', '2')).toBe(bulks('e', '5', 'd', '4'));
    expect(await c.raw('ZPOPMIN', 'z', '0')).toBe('*0\r\n');
    expect(await c.raw('ZPOPMIN', 'z', '10')).toBe(bulks('b', '2', 'c', '3'));
    expect(await c.call('EXISTS', 'z')).toBe(0);
    expect(await c.raw('ZPOPMIN', 'missing')).toBe('*0\r\n');
    expect(await c.raw('ZPOPMIN', 'missing', '2')).toBe('*0\r\n');
  });

  it('ZPOP count errors', async () => {
    const NOT_POSITIVE = err('ERR value is out of range, must be positive');
    expect(await c.raw('ZPOPMIN', 'z', '-1')).toBe(NOT_POSITIVE);
    expect(await c.raw('ZPOPMIN', 'z', 'abc')).toBe(NOT_POSITIVE);
    expect(await c.raw('ZPOPMIN', 'z', '1', '2')).toBe(SYNTAX);
    expect(await c.call('ZCARD', 'z')).toBe(5);
  });
});

describe('ZUNIONSTORE and ZINTERSTORE', () => {
  beforeEach(async () => {
    await c.call('ZADD', 'a', '1', 'x', '2', 'y');
    await c.call('ZADD', 'b', '10', 'y', '20', 'z');
    await c.call('SADD', 's', 'y', 'w');
  });

  const withScores = (key: string) => c.raw('ZRANGE', key, '0', '-1', 'WITHSCORES');

  it('SUM by default; plain sets count with score 1', async () => {
    expect(await c.call('ZUNIONSTORE', 'd', '2', 'a', 'b')).toBe(3);
    expect(await withScores('d')).toBe(bulks('x', '1', 'y', '12', 'z', '20'));
    expect(await c.call('ZINTERSTORE', 'd', '3', 'a', 'b', 's')).toBe(1);
    expect(await withScores('d')).toBe(bulks('y', '13'));
  });

  it('WEIGHTS and AGGREGATE', async () => {
    expect(
      await c.call('ZUNIONSTORE', 'd', '2', 'a', 'b', 'WEIGHTS', '2', '3', 'AGGREGATE', 'MAX'),
    ).toBe(3);
    expect(await withScores('d')).toBe(bulks('x', '2', 'y', '30', 'z', '60'));
    expect(await c.call('ZINTERSTORE', 'd', '2', 'a', 'b', 'aggregate', 'min')).toBe(1);
    expect(await withScores('d')).toBe(bulks('y', '2'));
  });

  it('NaN becomes 0: inf + -inf, and inf × 0', async () => {
    await c.call('ZADD', 'i', 'inf', 'p');
    await c.call('ZADD', 'j', '-inf', 'p');
    await c.call('ZUNIONSTORE', 'd', '2', 'i', 'j');
    expect(await withScores('d')).toBe(bulks('p', '0'));
    await c.call('ZUNIONSTORE', 'd', '2', 'i', 'j', 'WEIGHTS', '0', '1');
    expect(await withScores('d')).toBe(bulks('p', '-inf'));
    await c.call('ZUNIONSTORE', 'd', '1', 'a', 'WEIGHTS', 'inf');
    expect(await withScores('d')).toBe(bulks('x', 'inf', 'y', 'inf'));
  });

  it('an empty result deletes the destination; the destination may be a source', async () => {
    await c.call('SET', 'd', 'v');
    expect(await c.call('ZINTERSTORE', 'd', '2', 'a', 'missing')).toBe(0);
    expect(await c.call('EXISTS', 'd')).toBe(0);
    expect(await c.call('ZUNIONSTORE', 'a', '2', 'a', 'b')).toBe(3);
    expect(await withScores('a')).toBe(bulks('x', '1', 'y', '12', 'z', '20'));
    records.length = 0;
    expect(await c.call('ZUNIONSTORE', 'none', '1', 'missing')).toBe(0);
    expect(records).toEqual([]);
  });

  it('argument errors match Redis', async () => {
    expect(await c.raw('ZUNIONSTORE', 'd', '0', 'a')).toBe(
      err("ERR at least 1 input key is needed for 'zunionstore' command"),
    );
    expect(await c.raw('ZINTERSTORE', 'd', '-1', 'a')).toBe(
      err("ERR at least 1 input key is needed for 'zinterstore' command"),
    );
    expect(await c.raw('ZUNIONSTORE', 'd', '3', 'a', 'b')).toBe(SYNTAX);
    expect(await c.raw('ZUNIONSTORE', 'd', 'abc', 'a')).toBe(
      err('ERR value is not an integer or out of range'),
    );
    expect(await c.raw('ZUNIONSTORE', 'd', '1', 'a', 'WEIGHTS')).toBe(SYNTAX);
    for (const w of ['x', 'nan', '', ' 1']) {
      expect(await c.raw('ZUNIONSTORE', 'd', '1', 'a', 'WEIGHTS', w)).toBe(
        err('ERR weight value is not a float'),
      );
    }
    expect(await c.raw('ZUNIONSTORE', 'd', '1', 'a', 'AGGREGATE', 'avg')).toBe(SYNTAX);
    expect(await c.raw('ZUNIONSTORE', 'd', '1', 'a', 'bogus')).toBe(SYNTAX);
    await c.call('SET', 'str', 'v');
    // WRONGTYPE comes before option parsing, as in Redis.
    expect(await c.raw('ZUNIONSTORE', 'd', '2', 'a', 'str', 'bogus')).toBe(WRONGTYPE);
    expect(await c.call('EXISTS', 'd')).toBe(0);
  });
});

describe('ZSCAN', () => {
  it('a full scan returns every member with its score', async () => {
    const args: string[] = [];
    for (let i = 0; i < 300; i++) args.push(String(i / 4), `m${i}`);
    await c.call('ZADD', 'z', ...args);
    const seen = new Map<string, string>();
    let cursor = '0';
    do {
      const [next, items] = (await c.call('ZSCAN', 'z', cursor, 'COUNT', '25')) as [
        string,
        string[],
      ];
      for (let i = 0; i < items.length; i += 2) seen.set(items[i]!, items[i + 1]!);
      cursor = next;
    } while (cursor !== '0');
    expect(seen.size).toBe(300);
    expect(seen.get('m6')).toBe('1.5');
    expect(await c.raw('ZSCAN', 'missing', '0')).toBe('*2\r\n$1\r\n0\r\n*0\r\n');
  });
});

describe('RESP3', () => {
  it('scores are doubles; WITHSCORES and counted pops are [member, score] pairs', async () => {
    const r3 = await TestClient.connect(t.port);
    const id = (await r3.call('CLIENT', 'ID')) as number;
    t.server.clients.get(id)!.reply.resp = 3;
    try {
      await r3.call('ZADD', 'z', '1', 'a', '2.5', 'b');
      expect(await r3.raw('ZADD', 'z', 'INCR', '1', 'a')).toBe(',2\r\n');
      expect(await r3.raw('ZADD', 'z', 'NX', 'INCR', '1', 'a')).toBe('_\r\n');
      expect(await r3.raw('ZSCORE', 'z', 'a')).toBe(',2\r\n');
      expect(await r3.raw('ZRANGE', 'z', '0', '-1', 'WITHSCORES')).toBe(
        '*2\r\n*2\r\n$1\r\na\r\n,2\r\n*2\r\n$1\r\nb\r\n,2.5\r\n',
      );
      expect(await r3.raw('ZRANK', 'z', 'a', 'WITHSCORE')).toBe('*2\r\n:0\r\n,2\r\n');
      expect(await r3.raw('ZRANK', 'z', 'nope', 'WITHSCORE')).toBe('_\r\n');
      expect(await r3.raw('ZPOPMAX', 'z', '1')).toBe('*1\r\n*2\r\n$1\r\nb\r\n,2.5\r\n');
      expect(await r3.raw('ZPOPMIN', 'z')).toBe('*2\r\n$1\r\na\r\n,2\r\n');
    } finally {
      r3.socket.destroy();
    }
  });
});
