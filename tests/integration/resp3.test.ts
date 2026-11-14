// RESP3 replies (spec 7.3), as the exact bytes Redis 7.4 sends. The differential test checks
// the same commands against a live Redis; these literals keep the shapes pinned in `npm test`,
// which runs without Docker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer;
const clients: TestClient[] = [];
const connect3 = async (): Promise<TestClient> => {
  const c = await TestClient.connect(t.port);
  clients.push(c);
  await c.raw('HELLO', '3');
  return c;
};

beforeAll(async () => {
  t = await startServer();
});

afterAll(async () => {
  for (const c of clients) c.socket.destroy();
  await t.close();
});

describe('RESP3 reply types', () => {
  it('maps, sets, doubles and nulls', async () => {
    const c = await connect3();
    await c.call('HSET', 'h', 'f', 'v');
    await c.call('SADD', 's', 'a');
    await c.call('ZADD', 'z', '1.5', 'm', 'inf', 'big');
    expect(await c.raw('HGETALL', 'h')).toBe('%1\r\n$1\r\nf\r\n$1\r\nv\r\n');
    expect(await c.raw('HGETALL', 'nokey')).toBe('%0\r\n');
    expect(await c.raw('SMEMBERS', 's')).toBe('~1\r\n$1\r\na\r\n');
    expect(await c.raw('ZSCORE', 'z', 'm')).toBe(',1.5\r\n');
    expect(await c.raw('ZSCORE', 'z', 'big')).toBe(',inf\r\n');
    expect(await c.raw('ZSCORE', 'z', 'nope')).toBe('_\r\n');
    expect(await c.raw('GET', 'nokey')).toBe('_\r\n');
    expect(await c.raw('CONFIG', 'GET', 'maxclients')).toBe(
      '%1\r\n$10\r\nmaxclients\r\n$5\r\n10000\r\n',
    );
    // WITHSCORES: an array of [member, score] pairs, not a flat array.
    expect(await c.raw('ZRANGE', 'z', '0', '-1', 'WITHSCORES')).toBe(
      '*2\r\n*2\r\n$1\r\nm\r\n,1.5\r\n*2\r\n$3\r\nbig\r\n,inf\r\n',
    );
    expect(await c.raw('ZPOPMIN', 'z')).toBe('*2\r\n$1\r\nm\r\n,1.5\r\n');
    expect(await c.raw('ZPOPMIN', 'z', '1')).toBe('*1\r\n*2\r\n$3\r\nbig\r\n,inf\r\n');
  });

  it('nulls: a blocking timeout and an aborted EXEC are _ too', async () => {
    const c = await connect3();
    expect(await c.raw('BLPOP', 'nolist', '0.01')).toBe('_\r\n');
    await c.raw('WATCH', 'w');
    await c.raw('SET', 'w', '1');
    await c.raw('MULTI');
    await c.raw('PING');
    expect(await c.raw('EXEC')).toBe('_\r\n');
  });

  it('INFO is a verbatim string', async () => {
    const c = await connect3();
    expect(await c.raw('INFO', 'server')).toMatch(/^=\d+\r\ntxt:# Server\r\n/);
  });

  it('the same commands in RESP2 are unchanged', async () => {
    const c = await TestClient.connect(t.port);
    clients.push(c);
    expect(await c.raw('HGETALL', 'h')).toBe('*2\r\n$1\r\nf\r\n$1\r\nv\r\n');
    expect(await c.raw('SMEMBERS', 's')).toBe('*1\r\n$1\r\na\r\n');
    await c.call('ZADD', 'z2', 'inf', 'big');
    expect(await c.raw('ZSCORE', 'z2', 'big')).toBe('$3\r\ninf\r\n');
    expect(await c.raw('GET', 'nokey')).toBe('$-1\r\n');
  });

  it('HELLO 2 takes a connection back, and replies from then on are RESP2', async () => {
    const c = await connect3();
    expect((await c.raw('HELLO', '2')).startsWith('*14\r\n')).toBe(true);
    expect(await c.raw('GET', 'nokey')).toBe('$-1\r\n');
  });
});

describe('RESP3 pub/sub', () => {
  it('delivers push frames, and a subscriber may still run other commands', async () => {
    const sub = await connect3();
    const pub = await connect3();
    expect(await sub.raw('SUBSCRIBE', 'ch')).toBe('>3\r\n$9\r\nsubscribe\r\n$2\r\nch\r\n:1\r\n');
    expect(await sub.raw('PSUBSCRIBE', 'c*')).toBe('>3\r\n$10\r\npsubscribe\r\n$2\r\nc*\r\n:2\r\n');
    expect(await pub.raw('PUBLISH', 'ch', 'hi')).toBe(':2\r\n');
    expect(await sub.readRaw()).toBe('>3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$2\r\nhi\r\n');
    expect(await sub.readRaw()).toBe(
      '>4\r\n$8\r\npmessage\r\n$2\r\nc*\r\n$2\r\nch\r\n$2\r\nhi\r\n',
    );
    // No subscriber-mode restriction in RESP3 (spec 9.11), and PING is the ordinary +PONG.
    expect(await sub.raw('GET', 'nokey')).toBe('_\r\n');
    expect(await sub.raw('PING')).toBe('+PONG\r\n');
    expect(await sub.raw('PING', 'x')).toBe('$1\r\nx\r\n');
    expect(await sub.raw('UNSUBSCRIBE')).toBe('>3\r\n$11\r\nunsubscribe\r\n$2\r\nch\r\n:1\r\n');
    expect(await sub.raw('UNSUBSCRIBE')).toBe('>3\r\n$11\r\nunsubscribe\r\n_\r\n:1\r\n');
  });
});
