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
const sorted = (v: unknown) => [...(v as string[])].sort();

describe('EXISTS, TYPE, UNLINK, DBSIZE', () => {
  it('EXISTS counts repeats', async () => {
    await c.call('MSET', 'a', '1', 'b', '2');
    expect(await c.call('EXISTS', 'a', 'a', 'b', 'nope')).toBe(3);
    expect(await c.raw('EXISTS')).toBe(err("ERR wrong number of arguments for 'exists' command"));
  });

  it('EXISTS leaves the hit and miss counters alone', async () => {
    await c.call('SET', 'a', '1');
    t.server.resetStats();
    await c.call('EXISTS', 'a', 'nope');
    await c.call('TYPE', 'a');
    expect(t.server.stats).toMatchObject({ keyspaceHits: 0, keyspaceMisses: 0 });
  });

  it('TYPE replies with a simple string', async () => {
    await c.call('SET', 'a', '1');
    expect(await c.raw('TYPE', 'a')).toBe('+string\r\n');
    expect(await c.raw('TYPE', 'nope')).toBe('+none\r\n');
  });

  it('UNLINK behaves like DEL', async () => {
    await c.call('MSET', 'a', '1', 'b', '2');
    expect(await c.call('UNLINK', 'a', 'a', 'b', 'nope')).toBe(2);
    expect(await c.call('DBSIZE')).toBe(0);
  });

  it('DBSIZE counts keys in the current db only', async () => {
    await c.call('SET', 'a', '1');
    await c.call('SELECT', '1');
    expect(await c.call('DBSIZE')).toBe(0);
    await c.call('SET', 'b', '1');
    await c.call('SET', 'c', '1');
    expect(await c.call('DBSIZE')).toBe(2);
    await c.call('SELECT', '0');
    expect(await c.call('DBSIZE')).toBe(1);
  });
});

describe('KEYS', () => {
  it('matches glob patterns', async () => {
    await c.call('MSET', 'hello', '1', 'hallo', '1', 'hxllo', '1', 'world', '1');
    expect(sorted(await c.call('KEYS', '*'))).toEqual(['hallo', 'hello', 'hxllo', 'world']);
    expect(sorted(await c.call('KEYS', 'h?llo'))).toEqual(['hallo', 'hello', 'hxllo']);
    expect(sorted(await c.call('KEYS', 'h[ae]llo'))).toEqual(['hallo', 'hello']);
    expect(sorted(await c.call('KEYS', 'h[^e]llo'))).toEqual(['hallo', 'hxllo']);
    expect(await c.call('KEYS', 'nothing*')).toEqual([]);
  });

  it('works on byte strings', async () => {
    await c.call('SET', '\xff\xfe', '1');
    expect(await c.call('KEYS', '\xff*')).toEqual(['\xff\xfe']);
  });
});

describe('SCAN', () => {
  it('returns every key by following the cursor to 0', async () => {
    const want: string[] = [];
    for (let i = 0; i < 500; i++) want.push(`key:${i}`);
    for (const k of want) await c.call('SET', k, '1');
    const seen = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = (await c.call('SCAN', cursor, 'COUNT', '25')) as [string, string[]];
      for (const k of keys) seen.add(k);
      cursor = next;
    } while (cursor !== '0');
    expect([...seen].sort()).toEqual([...want].sort());
  });

  it('keeps every key that existed throughout, despite writes and growth in between', async () => {
    const stable: string[] = [];
    for (let i = 0; i < 200; i++) {
      stable.push(`s${i}`);
      await c.call('SET', `s${i}`, '1');
    }
    const seen = new Set<string>();
    let cursor = '0';
    let n = 0;
    do {
      const [next, keys] = (await c.call('SCAN', cursor, 'COUNT', '10')) as [string, string[]];
      for (const k of keys) seen.add(k);
      cursor = next;
      // Grow the dict while the scan is running, and delete some temporary keys.
      for (let j = 0; j < 20; j++) await c.call('SET', `tmp${n}:${j}`, '1');
      if (n % 3 === 0) await c.call('DEL', `tmp${n}:0`, `tmp${n}:1`);
      n++;
    } while (cursor !== '0');
    for (const k of stable) expect(seen.has(k), k).toBe(true);
  });

  it('MATCH filters after the step, so a page may be empty', async () => {
    await c.call('MSET', 'user:1', 'a', 'user:2', 'b', 'other', 'c');
    const found = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = (await c.call('SCAN', cursor, 'MATCH', 'user:*', 'COUNT', '100')) as [
        string,
        string[],
      ];
      for (const k of keys) found.add(k);
      cursor = next;
    } while (cursor !== '0');
    expect([...found].sort()).toEqual(['user:1', 'user:2']);
  });

  it('TYPE filters by type', async () => {
    await c.call('MSET', 'a', '1', 'b', '2');
    const [, strings] = (await c.call('SCAN', '0', 'COUNT', '100', 'TYPE', 'string')) as [
      string,
      string[],
    ];
    expect(sorted(strings)).toEqual(['a', 'b']);
    const [, lists] = (await c.call('SCAN', '0', 'COUNT', '100', 'TYPE', 'list')) as [
      string,
      string[],
    ];
    expect(lists).toEqual([]);
  });

  it('replies with the cursor as a bulk string, then an array', async () => {
    expect(await c.raw('SCAN', '0')).toBe('*2\r\n$1\r\n0\r\n*0\r\n');
  });

  it('rejects bad cursors and options', async () => {
    for (const bad of ['abc', '1.5', '1x', ' 1', '99999999999999999999']) {
      expect(await c.raw('SCAN', bad), JSON.stringify(bad)).toBe(err('ERR invalid cursor'));
    }
    expect(await c.raw('SCAN', '0', 'COUNT', '0')).toBe(err('ERR syntax error'));
    expect(await c.raw('SCAN', '0', 'COUNT', '-1')).toBe(err('ERR syntax error'));
    expect(await c.raw('SCAN', '0', 'COUNT', 'x')).toBe(
      err('ERR value is not an integer or out of range'),
    );
    expect(await c.raw('SCAN', '0', 'COUNT')).toBe(err('ERR syntax error'));
    expect(await c.raw('SCAN', '0', 'BOGUS', '1')).toBe(err('ERR syntax error'));
    expect(await c.raw('SCAN')).toBe(err("ERR wrong number of arguments for 'scan' command"));
  });

  it('accepts a cursor past the table size', async () => {
    await c.call('SET', 'a', '1');
    const [next] = (await c.call('SCAN', '4294967295')) as [string, string[]];
    expect(Number(next)).toBeGreaterThanOrEqual(0);
  });
});

describe('RENAME', () => {
  it('moves the value and replaces the destination', async () => {
    await c.call('MSET', 'a', '1', 'b', '2');
    expect(await c.raw('RENAME', 'a', 'b')).toBe('+OK\r\n');
    expect(await c.call('GET', 'a')).toBeNull();
    expect(await c.call('GET', 'b')).toBe('1');
    expect(await c.call('DBSIZE')).toBe(1);
  });

  it('errors on a missing source, and changes nothing', async () => {
    await c.call('SET', 'b', '2');
    const dirty = t.server.dirty;
    expect(await c.raw('RENAME', 'nope', 'b')).toBe(err('ERR no such key'));
    expect(await c.call('GET', 'b')).toBe('2');
    expect(t.server.dirty).toBe(dirty);
  });

  it('renaming a key to itself is OK, and a missing key to itself is still an error', async () => {
    await c.call('SET', 'a', '1');
    expect(await c.raw('RENAME', 'a', 'a')).toBe('+OK\r\n');
    expect(await c.call('GET', 'a')).toBe('1');
    expect(await c.raw('RENAME', 'nope', 'nope')).toBe(err('ERR no such key'));
  });

  it('keeps the TTL of the source', async () => {
    await c.call('SET', 'a', '1');
    t.server.dbs[0]!.expires.set('a', 4_000_000_000_000);
    await c.call('RENAME', 'a', 'b');
    expect(t.server.dbs[0]!.expires.get('b')).toBe(4_000_000_000_000);
    expect(t.server.dbs[0]!.expires.has('a')).toBe(false);
  });

  it('is propagated as it arrived', async () => {
    await c.call('SET', 'a', '1');
    records.length = 0;
    await c.call('RENAME', 'a', 'b');
    expect(records).toEqual([{ db: 0, argv: ['RENAME', 'a', 'b'] }]);
  });
});

describe('RANDOMKEY', () => {
  it('is nil on an empty db and a live key otherwise', async () => {
    expect(await c.raw('RANDOMKEY')).toBe('$-1\r\n');
    await c.call('MSET', 'a', '1', 'b', '2');
    expect(['a', 'b']).toContain(await c.call('RANDOMKEY'));
  });
});

describe('FLUSHDB and FLUSHALL', () => {
  it('FLUSHDB empties only the current db', async () => {
    await c.call('SET', 'a', '1');
    await c.call('SELECT', '1');
    await c.call('SET', 'b', '1');
    expect(await c.raw('FLUSHDB')).toBe('+OK\r\n');
    expect(await c.call('DBSIZE')).toBe(0);
    await c.call('SELECT', '0');
    expect(await c.call('DBSIZE')).toBe(1);
  });

  it('FLUSHALL empties every db', async () => {
    await c.call('SET', 'a', '1');
    await c.call('SELECT', '1');
    await c.call('SET', 'b', '1');
    expect(await c.raw('FLUSHALL')).toBe('+OK\r\n');
    expect(await c.call('DBSIZE')).toBe(0);
    await c.call('SELECT', '0');
    expect(await c.call('DBSIZE')).toBe(0);
  });

  it('accepts SYNC and ASYNC in any case, and rejects anything else', async () => {
    expect(await c.raw('FLUSHALL', 'ASYNC')).toBe('+OK\r\n');
    expect(await c.raw('FLUSHDB', 'sync')).toBe('+OK\r\n');
    expect(await c.raw('FLUSHDB', 'now')).toBe(err('ERR syntax error'));
    expect(await c.raw('FLUSHALL', 'sync', 'async')).toBe(err('ERR syntax error'));
  });

  it('counts every removed key as dirty and propagates', async () => {
    await c.call('MSET', 'a', '1', 'b', '2', 'c', '3');
    const dirty = t.server.dirty;
    records.length = 0;
    await c.call('FLUSHDB');
    expect(t.server.dirty).toBe(dirty + 3);
    expect(records).toEqual([{ db: 0, argv: ['FLUSHDB'] }]);
  });

  it('an empty FLUSHDB propagates nothing, but FLUSHALL always does (Redis forces it)', async () => {
    await c.call('FLUSHDB');
    expect(records).toEqual([]);
    await c.call('FLUSHALL');
    expect(records).toEqual([{ db: 0, argv: ['FLUSHALL'] }]);
  });
});
