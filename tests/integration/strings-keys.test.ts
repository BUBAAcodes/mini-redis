import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer;
let c: TestClient;

beforeAll(async () => {
  t = await startServer();
  c = await TestClient.connect(t.port);
});

afterAll(async () => {
  c.socket.destroy();
  await t.close();
});

describe('GET and SET', () => {
  it('stores and returns values', async () => {
    expect(await c.raw('SET', 'a', '1')).toBe('+OK\r\n');
    expect(await c.raw('GET', 'a')).toBe('$1\r\n1\r\n');
    expect(await c.raw('SET', 'a', 'two')).toBe('+OK\r\n');
    expect(await c.raw('GET', 'a')).toBe('$3\r\ntwo\r\n');
    expect(await c.raw('GET', 'missing')).toBe('$-1\r\n');
    expect(await c.raw('SET', 'empty', '')).toBe('+OK\r\n');
    expect(await c.raw('GET', 'empty')).toBe('$0\r\n\r\n');
  });

  it('round-trips every byte value and invalid UTF-8 (spec 7.1)', async () => {
    let all = '';
    for (let b = 0; b < 256; b++) {
      const v = String.fromCharCode(b);
      all += v;
      await c.call('SET', `byte:${b}`, v);
      expect(await c.call('GET', `byte:${b}`)).toBe(v);
    }
    await c.call('SET', '\xff\xfe', all);
    expect(await c.raw('GET', '\xff\xfe')).toBe(`$256\r\n${all}\r\n`);
  });

  it('gives the Redis errors', async () => {
    expect(await c.raw('GET')).toBe("-ERR wrong number of arguments for 'get' command\r\n");
    expect(await c.raw('GET', 'a', 'b')).toBe(
      "-ERR wrong number of arguments for 'get' command\r\n",
    );
    expect(await c.raw('SET', 'a')).toBe("-ERR wrong number of arguments for 'set' command\r\n");
    expect(await c.raw('SET', 'a', 'b', 'c')).toBe('-ERR syntax error\r\n');
  });

  it('changes nothing when it replies with an error (rule 4)', async () => {
    await c.call('SET', 'kept', 'v');
    const dirty = t.server.dirty;
    await c.call('SET', 'kept', 'new', 'bogus');
    expect(await c.call('GET', 'kept')).toBe('v');
    expect(t.server.dirty).toBe(dirty);
  });

  it('counts keyspace hits and misses', async () => {
    t.server.resetStats();
    await c.call('GET', 'a');
    await c.call('GET', 'nope');
    await c.call('GET', 'nope');
    expect(t.server.stats.keyspaceHits).toBe(1);
    expect(t.server.stats.keyspaceMisses).toBe(2);
  });
});

describe('DEL', () => {
  it('counts the keys it removed, each once', async () => {
    await c.call('SET', 'd1', 'x');
    await c.call('SET', 'd2', 'x');
    expect(await c.raw('DEL', 'd1', 'd1', 'd2', 'nope')).toBe(':2\r\n');
    expect(await c.raw('GET', 'd1')).toBe('$-1\r\n');
    expect(await c.raw('DEL', 'd1')).toBe(':0\r\n');
    expect(await c.raw('DEL')).toBe("-ERR wrong number of arguments for 'del' command\r\n");
  });

  it('marks the dataset dirty once per key changed', async () => {
    await c.call('SET', 'd3', 'x');
    const before = t.server.dirty;
    await c.call('DEL', 'd3', 'd3', 'nope');
    expect(t.server.dirty).toBe(before + 1);
  });
});
