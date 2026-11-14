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
const NOT_POSITIVE = err('ERR value is out of range, must be positive');
const members = async (key: string) => [...((await c.call('SMEMBERS', key)) as string[])].sort();

describe('SADD, SREM, SISMEMBER, SCARD, SMEMBERS', () => {
  it('count only real changes', async () => {
    expect(await c.call('SADD', 's', 'a', 'b', 'a')).toBe(2);
    expect(await c.call('SADD', 's', 'b', 'c')).toBe(1);
    expect(await c.call('SREM', 's', 'a', 'zz')).toBe(1);
    expect(await c.call('SISMEMBER', 's', 'b')).toBe(1);
    expect(await c.call('SISMEMBER', 's', 'a')).toBe(0);
    expect(await c.call('SISMEMBER', 'missing', 'a')).toBe(0);
    expect(await c.call('SCARD', 's')).toBe(2);
    expect(await c.call('SCARD', 'missing')).toBe(0);
    expect(await members('s')).toEqual(['b', 'c']);
    expect(await c.raw('SMEMBERS', 'missing')).toBe('*0\r\n');
    expect(await c.call('TYPE', 's')).toBe('set');
  });

  it('SREM deletes the emptied key; a no-op SADD or SREM is not propagated', async () => {
    await c.call('SADD', 's', 'a');
    records.length = 0;
    await c.call('SADD', 's', 'a');
    await c.call('SREM', 's', 'zz');
    await c.call('SREM', 'missing', 'a');
    expect(records).toEqual([]);
    expect(await c.call('SREM', 's', 'a')).toBe(1);
    expect(await c.call('EXISTS', 's')).toBe(0);
  });

  it('all 256 byte values are distinct members', async () => {
    const all = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i));
    expect(await c.call('SADD', 's', ...all)).toBe(256);
    expect(await members('s')).toEqual([...all].sort());
  });

  it('WRONGTYPE on a string, for every set command', async () => {
    await c.call('SET', 'str', 'v');
    await c.call('SADD', 's', 'a');
    for (const argv of [
      ['SADD', 'str', 'a'],
      ['SREM', 'str', 'a'],
      ['SISMEMBER', 'str', 'a'],
      ['SMEMBERS', 'str'],
      ['SCARD', 'str'],
      ['SPOP', 'str'],
      ['SRANDMEMBER', 'str'],
      ['SINTER', 's', 'str'],
      ['SINTER', 'missing', 'str'],
      ['SUNION', 'missing', 'str'],
      ['SDIFF', 'missing', 'str'],
      ['SINTERSTORE', 'd', 's', 'str'],
      ['SSCAN', 'str', '0'],
    ]) {
      expect(await c.raw(...argv), argv.join(' ')).toBe(WRONGTYPE);
    }
    expect(await c.call('EXISTS', 'd')).toBe(0);
  });
});

describe('SINTER, SUNION, SDIFF and their STORE forms', () => {
  beforeEach(async () => {
    await c.call('SADD', 'a', '1', '2', '3', '4');
    await c.call('SADD', 'b', '3', '4', '5');
    await c.call('SADD', 'c', '4', '6');
  });

  it('compute the set algebra; a missing key is an empty set', async () => {
    expect([...((await c.call('SINTER', 'a', 'b', 'c')) as string[])]).toEqual(['4']);
    expect([...((await c.call('SUNION', 'a', 'c')) as string[])].sort()).toEqual(
      ['1', '2', '3', '4', '6'].sort(),
    );
    expect([...((await c.call('SDIFF', 'a', 'b', 'c')) as string[])].sort()).toEqual(['1', '2']);
    expect(await c.raw('SINTER', 'a', 'missing')).toBe('*0\r\n');
    expect([...((await c.call('SUNION', 'missing', 'c')) as string[])].sort()).toEqual(['4', '6']);
    expect(await c.raw('SDIFF', 'missing', 'a')).toBe('*0\r\n');
  });

  it('STORE forms replace the destination, whatever it held, and drop its TTL', async () => {
    await c.call('SET', 'd', 'string');
    await c.call('EXPIRE', 'd', '100');
    expect(await c.call('SUNIONSTORE', 'd', 'a', 'b')).toBe(5);
    expect(await c.call('TYPE', 'd')).toBe('set');
    expect(await c.call('TTL', 'd')).toBe(-1);
    expect(await c.call('SINTERSTORE', 'd', 'a', 'b')).toBe(2);
    expect(await members('d')).toEqual(['3', '4']);
    expect(await c.call('SDIFFSTORE', 'd', 'a', 'b')).toBe(2);
    expect(await members('d')).toEqual(['1', '2']);
  });

  it('an empty result deletes the destination; a source can be the destination', async () => {
    await c.call('SADD', 'd', 'x');
    expect(await c.call('SINTERSTORE', 'd', 'a', 'missing')).toBe(0);
    expect(await c.call('EXISTS', 'd')).toBe(0);
    expect(await c.call('SDIFFSTORE', 'a', 'a', 'b')).toBe(2);
    expect(await members('a')).toEqual(['1', '2']);
  });

  it('a STORE that changed nothing is not propagated', async () => {
    records.length = 0;
    expect(await c.call('SINTERSTORE', 'none', 'a', 'missing')).toBe(0);
    expect(records).toEqual([]);
  });
});

describe('SPOP and SRANDMEMBER', () => {
  it('SPOP removes random members and propagates them as SREM', async () => {
    await c.call('SADD', 's', 'a', 'b', 'c', 'd');
    records.length = 0;
    const popped = (await c.call('SPOP', 's', '2')) as string[];
    expect(popped).toHaveLength(2);
    expect(new Set(popped).size).toBe(2);
    expect(await c.call('SCARD', 's')).toBe(2);
    for (const m of popped) expect(await c.call('SISMEMBER', 's', m)).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.argv[0]).toBe('SREM');
    expect(records[0]!.argv[1]).toBe('s');
    expect([...records[0]!.argv.slice(2)].sort()).toEqual([...popped].sort());

    const one = (await c.call('SPOP', 's')) as string;
    expect(records[1]).toEqual({ db: 0, argv: ['SREM', 's', one] });
  });

  it('an SPOP that empties the set propagates as DEL', async () => {
    await c.call('SADD', 's', 'a', 'b');
    records.length = 0;
    expect(((await c.call('SPOP', 's', '10')) as string[]).sort()).toEqual(['a', 'b']);
    expect(await c.call('EXISTS', 's')).toBe(0);
    expect(records).toEqual([{ db: 0, argv: ['DEL', 's'] }]);
  });

  it('SPOP replies and errors match Redis', async () => {
    await c.call('SADD', 's', 'a');
    expect(await c.raw('SPOP', 'missing')).toBe('$-1\r\n');
    expect(await c.raw('SPOP', 'missing', '2')).toBe('*0\r\n');
    expect(await c.raw('SPOP', 's', '0')).toBe('*0\r\n');
    expect(await c.raw('SPOP', 's', '-1')).toBe(NOT_POSITIVE);
    expect(await c.raw('SPOP', 's', 'abc')).toBe(NOT_POSITIVE);
    expect(await c.raw('SPOP', 's', '1', '2')).toBe(err('ERR syntax error'));
    expect(records.filter((r) => r.argv[0] !== 'SADD')).toEqual([]);
  });

  it('SRANDMEMBER: distinct members for a positive count, repeats for a negative one', async () => {
    await c.call('SADD', 's', 'a', 'b', 'c');
    expect(['a', 'b', 'c']).toContain(await c.call('SRANDMEMBER', 's'));
    const two = (await c.call('SRANDMEMBER', 's', '2')) as string[];
    expect(new Set(two).size).toBe(2);
    expect(((await c.call('SRANDMEMBER', 's', '10')) as string[]).sort()).toEqual(['a', 'b', 'c']);
    const many = (await c.call('SRANDMEMBER', 's', '-20')) as string[];
    expect(many).toHaveLength(20);
    for (const m of many) expect(['a', 'b', 'c']).toContain(m);
    expect(await c.call('SCARD', 's')).toBe(3);
    expect(await c.raw('SRANDMEMBER', 'missing')).toBe('$-1\r\n');
    expect(await c.raw('SRANDMEMBER', 'missing', '2')).toBe('*0\r\n');
    expect(await c.raw('SRANDMEMBER', 's', '0')).toBe('*0\r\n');
    expect(await c.raw('SRANDMEMBER', 's', 'abc')).toBe(
      err('ERR value is not an integer or out of range'),
    );
    expect(await c.raw('SRANDMEMBER', 's', '-9223372036854775808')).toBe(
      err(
        'ERR value is out of range, value must between -9223372036854775807 and 9223372036854775807',
      ),
    );
    expect(records.filter((r) => r.argv[0] !== 'SADD')).toEqual([]);
  });
});

describe('SRANDMEMBER limits (DIFFERENCES.md)', () => {
  it('caps a negative count at 1,048,576 so one call cannot loop for hours', async () => {
    await c.call('SADD', 's', 'a');
    expect(((await c.call('SRANDMEMBER', 's', '-1048576')) as string[]).length).toBe(1_048_576);
    expect(await c.raw('SRANDMEMBER', 's', '-1048577')).toBe(
      err('ERR value is out of range, value must between -1048576 and 9223372036854775807'),
    );
    // A million-item reply takes about 10 s on its own, half the default budget.
  }, 60_000);
});

describe('SSCAN', () => {
  it('a full scan returns every member; MATCH filters', async () => {
    const all = Array.from({ length: 500 }, (_, i) => `m${i}`);
    await c.call('SADD', 's', ...all);
    const seen = new Set<string>();
    let cursor = '0';
    do {
      const [next, items] = (await c.call('SSCAN', 's', cursor, 'MATCH', 'm1*')) as [
        string,
        string[],
      ];
      for (const m of items) seen.add(m);
      cursor = next;
    } while (cursor !== '0');
    expect([...seen].sort()).toEqual(all.filter((m) => m.startsWith('m1')).sort());
    expect(await c.raw('SSCAN', 'missing', '0')).toBe('*2\r\n$1\r\n0\r\n*0\r\n');
  });
});

describe('RESP3', () => {
  it('SMEMBERS, SINTER and SPOP with a count are sets; SRANDMEMBER is an array', async () => {
    const r3 = await TestClient.connect(t.port);
    const id = (await r3.call('CLIENT', 'ID')) as number;
    t.server.clients.get(id)!.reply.resp = 3;
    try {
      await r3.call('SADD', 's', 'a');
      expect(await r3.raw('SMEMBERS', 's')).toBe('~1\r\n$1\r\na\r\n');
      expect(await r3.raw('SMEMBERS', 'missing')).toBe('~0\r\n');
      expect(await r3.raw('SINTER', 's')).toBe('~1\r\n$1\r\na\r\n');
      expect(await r3.raw('SRANDMEMBER', 's', '1')).toBe('*1\r\n$1\r\na\r\n');
      expect(await r3.raw('SPOP', 'missing', '2')).toBe('~0\r\n');
      expect(await r3.raw('SPOP', 's', '1')).toBe('~1\r\n$1\r\na\r\n');
    } finally {
      r3.socket.destroy();
    }
  });
});
