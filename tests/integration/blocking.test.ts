// Step 18: BLPOP, BRPOP and BLMOVE (spec 8.3, 9.12). Every expected reply, including the
// multi-client serve-time cases, was checked against the redis:7.4 reference server.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PropagationRecord } from '../../src/server/propagate.js';
import { TestClient, encodeCommand } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer;
let a: TestClient;
let b: TestClient;
let c: TestClient;
let d: TestClient;
const records: PropagationRecord[] = [];

beforeAll(async () => {
  t = await startServer();
  t.server.propagator.attach({ append: (r) => records.push(r) });
  a = await TestClient.connect(t.port);
  b = await TestClient.connect(t.port);
  c = await TestClient.connect(t.port);
  d = await TestClient.connect(t.port);
});

beforeEach(async () => {
  await d.call('FLUSHALL');
  records.length = 0;
});

afterAll(async () => {
  for (const client of [a, b, c, d]) client.socket.destroy();
  await t.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const argvs = () => records.map((r) => r.argv);
const pair = (key: string, value: string) =>
  `*2\r\n$${key.length}\r\n${key}\r\n$${value.length}\r\n${value}\r\n`;
const WRONGTYPE = '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n';

/** Sends a blocking command and waits until the server has it parked. */
async function block(client: TestClient, ...argv: string[]): Promise<void> {
  const before = t.server.waiters.blockedCount;
  client.send(...argv);
  for (let i = 0; i < 100 && t.server.waiters.blockedCount === before; i++) await sleep(2);
  expect(t.server.waiters.blockedCount).toBe(before + 1);
}

describe('when a list already has elements', () => {
  it('BLPOP and BRPOP pop at once, from the first non-empty key, and propagate a plain pop', async () => {
    await d.call('RPUSH', 'l', 'a', 'b', 'c');
    expect(await a.raw('BLPOP', 'missing', 'l', '0')).toBe(pair('l', 'a'));
    expect(await a.raw('BRPOP', 'l', '0')).toBe(pair('l', 'c'));
    expect(argvs()).toEqual([
      ['RPUSH', 'l', 'a', 'b', 'c'],
      ['LPOP', 'l'],
      ['RPOP', 'l'],
    ]);
  });

  it('deletes the key when the pop empties it', async () => {
    await d.call('RPUSH', 'l', 'a');
    expect(await a.raw('BLPOP', 'l', '1')).toBe(pair('l', 'a'));
    expect(await a.raw('EXISTS', 'l')).toBe(':0\r\n');
  });

  it('BLMOVE moves at once and propagates LMOVE with the words as given', async () => {
    await d.call('RPUSH', 'src', 'a', 'b');
    expect(await a.raw('BLMOVE', 'src', 'dst', 'right', 'LEFT', '0')).toBe('$1\r\nb\r\n');
    expect(await a.raw('LRANGE', 'dst', '0', '-1')).toBe('*1\r\n$1\r\nb\r\n');
    expect(argvs()).toEqual([
      ['RPUSH', 'src', 'a', 'b'],
      ['LMOVE', 'src', 'dst', 'right', 'LEFT'],
    ]);
  });
});

describe('blocking and being served', () => {
  it('BLPOP returns within 10 ms of another client’s push', async () => {
    await block(a, 'BLPOP', 'q', '0');
    const start = performance.now();
    b.send('RPUSH', 'q', 'v');
    expect(await a.readRaw()).toBe(pair('q', 'v'));
    expect(performance.now() - start).toBeLessThan(10);
    expect(await b.readRaw()).toBe(':1\r\n');
  });

  it('serves three waiters on one key in arrival order', async () => {
    await block(a, 'BLPOP', 'q', '0');
    await block(b, 'BLPOP', 'q', '0');
    await block(c, 'BLPOP', 'q', '0');
    expect(await d.raw('RPUSH', 'q', 'x', 'y')).toBe(':2\r\n');
    expect(await a.readRaw()).toBe(pair('q', 'x'));
    expect(await b.readRaw()).toBe(pair('q', 'y'));
    expect(t.server.waiters.blockedCount).toBe(1);
    expect(await d.raw('RPUSH', 'q', 'z')).toBe(':1\r\n');
    expect(await c.readRaw()).toBe(pair('q', 'z'));
    expect(await d.raw('EXISTS', 'q')).toBe(':0\r\n');
  });

  it('propagates the push before the pop it fed', async () => {
    await block(a, 'BRPOP', 'q', '0');
    await d.call('LPUSH', 'q', 'v');
    expect(await a.readRaw()).toBe(pair('q', 'v'));
    expect(argvs()).toEqual([
      ['LPUSH', 'q', 'v'],
      ['RPOP', 'q'],
    ]);
  });

  it('BLMOVE served by a push moves the element and propagates LMOVE after the push', async () => {
    await block(a, 'BLMOVE', 'src', 'dst', 'LEFT', 'RIGHT', '0');
    await d.call('RPUSH', 'src', 'v');
    expect(await a.readRaw()).toBe('$1\r\nv\r\n');
    expect(await d.raw('LRANGE', 'dst', '0', '-1')).toBe('*1\r\n$1\r\nv\r\n');
    expect(argvs()).toEqual([
      ['RPUSH', 'src', 'v'],
      ['LMOVE', 'src', 'dst', 'LEFT', 'RIGHT'],
    ]);
  });

  it('runs a blocked client’s pipelined commands only after it unblocks', async () => {
    const before = t.server.waiters.blockedCount;
    // One chunk: BLPOP parks the client, and the SET and GET behind it wait in its parser.
    a.write(
      encodeCommand(['BLPOP', 'q', '0']) +
        encodeCommand(['SET', 'after', '1']) +
        encodeCommand(['GET', 'after']),
    );
    for (let i = 0; i < 100 && t.server.waiters.blockedCount === before; i++) await sleep(2);
    await sleep(20);
    expect(await b.raw('GET', 'after')).toBe('$-1\r\n');
    expect(a.unread).toBe('');
    await b.call('RPUSH', 'q', 'v');
    expect(await a.readRaw()).toBe(pair('q', 'v'));
    expect(await a.readRaw()).toBe('+OK\r\n');
    expect(await a.readRaw()).toBe('$1\r\n1\r\n');
  });

  it('serves after the whole EXEC, with what is left when it ends', async () => {
    await block(a, 'BLPOP', 'q', '0');
    b.write(
      [['MULTI'], ['RPUSH', 'q', 'a'], ['LPOP', 'q'], ['RPUSH', 'q', 'b'], ['EXEC']]
        .map(encodeCommand)
        .join(''),
    );
    expect(await a.readRaw()).toBe(pair('q', 'b'));
    for (const expected of ['+OK\r\n', '+QUEUED\r\n', '+QUEUED\r\n', '+QUEUED\r\n']) {
      expect(await b.readRaw()).toBe(expected);
    }
    expect(await b.readRaw()).toBe('*3\r\n:1\r\n$1\r\na\r\n:1\r\n');
    expect(argvs()).toEqual([
      ['MULTI'],
      ['RPUSH', 'q', 'a'],
      ['LPOP', 'q'],
      ['RPUSH', 'q', 'b'],
      ['EXEC'],
      ['LPOP', 'q'],
    ]);
  });

  it('a multi-key waiter pops from its first non-empty key, in argument order', async () => {
    await block(a, 'BLPOP', 'k1', 'k2', '0');
    await b.call('MULTI');
    await b.call('RPUSH', 'k2', 'b');
    await b.call('RPUSH', 'k1', 'a');
    await b.call('EXEC');
    expect(await a.readRaw()).toBe(pair('k1', 'a'));
    expect(await b.raw('LRANGE', 'k2', '0', '-1')).toBe('*1\r\n$1\r\nb\r\n');
    expect(t.server.waiters.blockedCount).toBe(0);
  });

  it('a key named twice registers the client once', async () => {
    await block(a, 'BLPOP', 'q', 'q', '0');
    expect(await b.raw('RPUSH', 'q', 'x', 'y')).toBe(':2\r\n');
    expect(await a.readRaw()).toBe(pair('q', 'x'));
    expect(await b.raw('LRANGE', 'q', '0', '-1')).toBe('*1\r\n$1\r\ny\r\n');
  });

  it('waits on the key in its own database only', async () => {
    expect(await a.raw('SELECT', '1')).toBe('+OK\r\n');
    await block(a, 'BLPOP', 'q', '0');
    await b.call('RPUSH', 'q', 'db0');
    await sleep(20);
    expect(a.unread).toBe('');
    await b.call('SELECT', '1');
    await b.call('RPUSH', 'q', 'db1');
    expect(await a.readRaw()).toBe(pair('q', 'db1'));
    await a.call('SELECT', '0');
    await b.call('SELECT', '0');
  });

  it('a BLMOVE served by a push feeds the waiter on its destination', async () => {
    await block(b, 'BLPOP', 'dst', '0');
    await block(a, 'BLMOVE', 'src', 'dst', 'LEFT', 'RIGHT', '0');
    await d.call('RPUSH', 'src', 'v');
    expect(await a.readRaw()).toBe('$1\r\nv\r\n');
    expect(await b.readRaw()).toBe(pair('dst', 'v'));
    expect(await d.raw('EXISTS', 'src', 'dst')).toBe(':0\r\n');
    expect(argvs()).toEqual([
      ['RPUSH', 'src', 'v'],
      ['LMOVE', 'src', 'dst', 'LEFT', 'RIGHT'],
      ['LPOP', 'dst'],
    ]);
  });

  it('a rotating BLMOVE leaves the element for the next waiter on the same key', async () => {
    await block(a, 'BLMOVE', 'r', 'r', 'LEFT', 'RIGHT', '0');
    await block(b, 'BLPOP', 'r', '0');
    await d.call('RPUSH', 'r', 'v');
    expect(await a.readRaw()).toBe('$1\r\nv\r\n');
    expect(await b.readRaw()).toBe(pair('r', 'v'));
    expect(await d.raw('EXISTS', 'r')).toBe(':0\r\n');
  });

  it('a RENAME that brings a list to the key serves its waiter', async () => {
    await block(a, 'BLPOP', 'q', '0');
    await d.call('RPUSH', 'other', 'v');
    await d.call('RENAME', 'other', 'q');
    expect(await a.readRaw()).toBe(pair('q', 'v'));
  });

  it('keeps waiting while the key holds another type', async () => {
    await block(a, 'BLPOP', 'q', '0');
    await b.call('SET', 'q', 'x');
    await sleep(20);
    expect(a.unread).toBe('');
    await b.call('DEL', 'q');
    await b.call('RPUSH', 'q', 'v');
    expect(await a.readRaw()).toBe(pair('q', 'v'));
  });

  it('a BLMOVE whose destination became another type gets WRONGTYPE when served, and nothing moves', async () => {
    await block(a, 'BLMOVE', 'src', 'dst', 'LEFT', 'RIGHT', '0');
    await b.call('SET', 'dst', 'x');
    await b.call('RPUSH', 'src', 'a');
    expect(await a.readRaw()).toBe(WRONGTYPE);
    expect(await b.raw('LRANGE', 'src', '0', '-1')).toBe('*1\r\n$1\r\na\r\n');
    expect(t.server.waiters.blockedCount).toBe(0);
  });

  it('counts a blocked and then served command once in its stats', async () => {
    const calls = () => t.server.commandStats.get('blpop')?.calls ?? 0;
    const before = calls();
    await block(a, 'BLPOP', 'q', '0');
    await b.call('RPUSH', 'q', 'v');
    await a.readRaw();
    expect(calls()).toBe(before + 1);
  });
});

describe('timeouts', () => {
  it('a 0.1-second timeout returns a null array after about 0.1 seconds', async () => {
    const start = performance.now();
    expect(await a.raw('BLPOP', 'q', '0.1')).toBe('*-1\r\n');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(elapsed).toBeLessThan(200);
    expect(t.server.waiters.blockedCount).toBe(0);
  });

  it('BRPOP and BLMOVE time out with a null array too, and nothing propagates', async () => {
    expect(await a.raw('BRPOP', 'q', '0.01')).toBe('*-1\r\n');
    expect(await a.raw('BLMOVE', 'q', 'd', 'LEFT', 'RIGHT', '0.01')).toBe('*-1\r\n');
    expect(records).toEqual([]);
  });

  it('runs the pipelined commands that waited behind a timed-out one', async () => {
    a.send('BLPOP', 'q', '0.02');
    a.send('PING');
    expect(await a.readRaw()).toBe('*-1\r\n');
    expect(await a.readRaw()).toBe('+PONG\r\n');
  });

  it('counts a timed-out command once in its stats', async () => {
    const calls = () => t.server.commandStats.get('brpop')?.calls ?? 0;
    const before = calls();
    await a.raw('BRPOP', 'q', '0.01');
    expect(calls()).toBe(before + 1);
  });

  it("waits on a timeout longer than Node's largest timer instead of firing at once", async () => {
    await block(a, 'BLPOP', 'q', '2147484'); // just over 2^31 ms
    await sleep(30);
    expect(a.unread).toBe('');
    await b.call('RPUSH', 'q', 'v');
    expect(await a.readRaw()).toBe(pair('q', 'v'));
  });

  it('replies with RESP3 null on timeout', async () => {
    const id = Number(await c.call('CLIENT', 'ID'));
    t.server.clients.get(id)!.reply.resp = 3;
    try {
      expect(await c.raw('BLPOP', 'q', '0.01')).toBe('_\r\n');
      expect(await c.raw('BLMOVE', 'q', 'd', 'LEFT', 'RIGHT', '0.01')).toBe('_\r\n');
    } finally {
      t.server.clients.get(id)!.reply.resp = 2;
    }
  });
});

describe('inside MULTI', () => {
  it('BLPOP, BRPOP and BLMOVE on empty lists reply null at once instead of blocking', async () => {
    await a.call('MULTI');
    await a.call('BLPOP', 'q', '0');
    await a.call('BRPOP', 'q', '0');
    await a.call('BLMOVE', 'q', 'd', 'LEFT', 'RIGHT', '0');
    expect(await a.raw('EXEC')).toBe('*3\r\n*-1\r\n*-1\r\n$-1\r\n');
    expect(t.server.waiters.blockedCount).toBe(0);
  });

  it('pops at once when the list has elements, propagated inside the transaction', async () => {
    await d.call('RPUSH', 'q', 'v');
    await a.call('MULTI');
    await a.call('BLPOP', 'q', '0');
    expect(await a.raw('EXEC')).toBe('*1\r\n' + pair('q', 'v'));
    expect(argvs()).toEqual([['RPUSH', 'q', 'v'], ['MULTI'], ['LPOP', 'q'], ['EXEC']]);
  });

  it('a bad timeout is a run-time error inside EXEC', async () => {
    await a.call('MULTI');
    expect(await a.raw('BLPOP', 'q', '-1')).toBe('+QUEUED\r\n');
    expect(await a.raw('EXEC')).toBe('*1\r\n-ERR timeout is negative\r\n');
  });
});

describe('errors', () => {
  it('checks the timeout before anything else', async () => {
    await d.call('SET', 's', 'x');
    expect(await a.raw('BLPOP', 's', 'abc')).toBe(
      '-ERR timeout is not a float or out of range\r\n',
    );
    expect(await a.raw('BLPOP', 'q', '-1')).toBe('-ERR timeout is negative\r\n');
    expect(await a.raw('BLPOP', 'q', 'inf')).toBe('-ERR timeout is out of range\r\n');
    expect(await a.raw('BRPOP', 'q', '1e20')).toBe('-ERR timeout is out of range\r\n');
    expect(await a.raw('BLMOVE', 's', 'd', 'LEFT', 'RIGHT', 'nan')).toBe(
      '-ERR timeout is not a float or out of range\r\n',
    );
  });

  it('BLMOVE checks its directions before its timeout', async () => {
    expect(await a.raw('BLMOVE', 'q', 'd', 'UP', 'RIGHT', 'abc')).toBe('-ERR syntax error\r\n');
    expect(await a.raw('BLMOVE', 'q', 'd', 'LEFT', 'DOWN', '0')).toBe('-ERR syntax error\r\n');
  });

  it('gives WRONGTYPE for a key of another type before the first non-empty list', async () => {
    await d.call('SET', 's', 'x');
    await d.call('RPUSH', 'l', 'v');
    expect(await a.raw('BLPOP', 's', '0.01')).toBe(WRONGTYPE);
    expect(await a.raw('BLPOP', 'missing', 's', '0.01')).toBe(WRONGTYPE);
    expect(await a.raw('BLPOP', 'l', 's', '0')).toBe(pair('l', 'v'));
  });

  it('BLMOVE gives WRONGTYPE for either key when the source has elements', async () => {
    await d.call('SET', 's', 'x');
    await d.call('RPUSH', 'l', 'v');
    expect(await a.raw('BLMOVE', 's', 'd', 'LEFT', 'RIGHT', '0')).toBe(WRONGTYPE);
    expect(await a.raw('BLMOVE', 'l', 's', 'LEFT', 'RIGHT', '0')).toBe(WRONGTYPE);
    expect(await a.raw('LLEN', 'l')).toBe(':1\r\n');
    // A missing source blocks without looking at the destination.
    expect(await a.raw('BLMOVE', 'missing', 's', 'LEFT', 'RIGHT', '0.01')).toBe('*-1\r\n');
  });

  it('checks the argument count', async () => {
    expect(await a.raw('BLPOP', 'q')).toBe(
      "-ERR wrong number of arguments for 'blpop' command\r\n",
    );
    expect(await a.raw('BLMOVE', 'q', 'd', 'LEFT', 'RIGHT')).toBe(
      "-ERR wrong number of arguments for 'blmove' command\r\n",
    );
  });
});

describe('disconnecting', () => {
  it('a client that disconnects while blocked is forgotten, and a later push stays put', async () => {
    const gone = await TestClient.connect(t.port);
    await block(gone, 'BLPOP', 'q', '0');
    gone.socket.destroy();
    await gone.closed;
    for (let i = 0; i < 100 && t.server.waiters.blockedCount > 0; i++) await sleep(2);
    expect(t.server.waiters.blockedCount).toBe(0);
    expect(t.server.dbs[0]!.blockingKeys.size).toBe(0);
    expect(await d.raw('RPUSH', 'q', 'v')).toBe(':1\r\n');
    expect(await d.raw('LLEN', 'q')).toBe(':1\r\n');
  });

  it('a timed client that disconnects leaves no timer behind', async () => {
    const gone = await TestClient.connect(t.port);
    await block(gone, 'BLPOP', 'q', '0.05');
    gone.socket.destroy();
    await gone.closed;
    await sleep(80);
    expect(t.server.waiters.blockedCount).toBe(0);
  });
});
