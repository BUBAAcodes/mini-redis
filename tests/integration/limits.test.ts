// Per-client limits (spec 7.4, 9.1, 12): maxclients, the idle timeout, the query buffer limit,
// the unauthenticated limits, and the output buffer limits per client class.
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeCommand, TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const MAX_CLIENTS = '-ERR max number of clients reached\r\n';

let t: TestServer | null = null;
const sockets: net.Socket[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const c of clients.splice(0)) c.socket.destroy();
  await t?.close();
  t = null;
});

const start = async (directives: Record<string, string> = {}): Promise<TestServer> => {
  t = await startServer(directives);
  return t;
};
const connect = async (): Promise<TestClient> => {
  const c = await TestClient.connect(t!.port);
  clients.push(c);
  return c;
};

/** A socket that never reads, so the server's output to it piles up (a stuck client). */
const stuckClient = (port: number): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    s.once('connect', () => {
      s.pause();
      sockets.push(s);
      resolve(s);
    });
    s.once('error', reject);
  });

/** Is this socket's connection still in the server's client table? (A paused socket never sees the FIN.) */
const serverHas = (s: net.Socket): boolean =>
  [...t!.server.clients.values()].some((c) => c.addr === `127.0.0.1:${s.localPort}`);
const isClosed = (s: net.Socket): boolean => !serverHas(s);
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(10);
  }
  return true;
}

describe('maxclients', () => {
  it('the 11th client gets an error and is closed; a freed slot can be reused', async () => {
    await start({ maxclients: '10' });
    const first: TestClient[] = [];
    for (let i = 0; i < 10; i++) {
      const c = await connect();
      expect(await c.raw('PING')).toBe('+PONG\r\n');
      first.push(c);
    }
    const extra = await TestClient.connect(t!.port);
    clients.push(extra);
    expect(await extra.readRaw()).toBe(MAX_CLIENTS);
    await extra.closed;
    expect(t!.server.stats.rejectedConnections).toBe(1);

    first[0]!.socket.destroy();
    expect(await until(() => t!.server.clients.size < 10, 1000)).toBe(true);
    const again = await connect();
    expect(await again.raw('PING')).toBe('+PONG\r\n');
  });

  it('CONFIG SET maxclients applies to the next connection', async () => {
    await start();
    const a = await connect();
    expect(await a.raw('CONFIG', 'SET', 'maxclients', '1')).toBe('+OK\r\n');
    const b = await TestClient.connect(t!.port);
    clients.push(b);
    expect(await b.readRaw()).toBe(MAX_CLIENTS);
  });
});

describe('timeout (idle clients)', () => {
  it('closes idle clients, but not busy, subscribed or blocked ones', async () => {
    await start({ timeout: '1' });
    const idle = await connect();
    const busy = await connect();
    const subscribed = await connect();
    const blocked = await connect();
    await subscribed.raw('SUBSCRIBE', 'ch');
    blocked.send('BLPOP', 'nolist', '0');
    await idle.raw('PING');
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      expect(await busy.raw('PING')).toBe('+PONG\r\n');
      await sleep(200);
    }
    await Promise.race([
      idle.closed,
      sleep(1500).then(() => Promise.reject(new Error('idle client not closed'))),
    ]);
    expect(t!.server.clients.size).toBe(3);
    expect(await subscribed.raw('PING')).toMatch(/pong/);
    expect(await busy.raw('PING')).toBe('+PONG\r\n');
    expect(blocked.socket.destroyed).toBe(false);
  });

  it('0 means never', async () => {
    await start({ timeout: '0' });
    const c = await connect();
    await sleep(1300);
    expect(await c.raw('PING')).toBe('+PONG\r\n');
  });
});

describe('input limits', () => {
  it('a client over client-query-buffer-limit is closed with no reply, and the log says so', async () => {
    await start({ 'client-query-buffer-limit': '1mb' });
    const c = await connect();
    // The header promises 2 MB; the parser holds the bulk's buffer, which is already past 1 MB.
    c.write('*2\r\n$3\r\nSET\r\n$2000000\r\n');
    await c.closed;
    expect(c.unread).toBe('');
    expect(t!.logs.some((l) => l.includes('max query buffer length'))).toBe(true);
    // Other clients are untouched.
    const d = await connect();
    expect(await d.raw('PING')).toBe('+PONG\r\n');
  });

  it('an unauthenticated client cannot send a 1 MB bulk, or a big array', async () => {
    await start({ requirepass: 'pw' });
    const a = await connect();
    a.write('*2\r\n$3\r\nSET\r\n$1000000\r\n');
    expect(await a.readRaw()).toBe('-ERR Protocol error: unauthenticated bulk length\r\n');
    await a.closed;

    const b = await connect();
    b.write('*11\r\n');
    expect(await b.readRaw()).toBe('-ERR Protocol error: unauthenticated multibulk length\r\n');
    await b.closed;

    // Ten arguments and a 16 KB bulk are still fine before AUTH, and the same bulk is fine after.
    const c = await connect();
    expect(await c.raw('AUTH', 'pw')).toBe('+OK\r\n');
    expect(await c.raw('SET', 'k', 'x'.repeat(1_000_000))).toBe('+OK\r\n');
    // After a successful AUTH the limits are lifted: the same frame works.
    const d = await connect();
    d.write(encodeCommand(['AUTH', 'x'.repeat(16 * 1024)]));
    expect(await d.readRaw()).toBe(
      '-WRONGPASS invalid username-password pair or user is disabled.\r\n',
    );
  });
});

describe('output buffer limits', () => {
  const setLimits = async (spec: string): Promise<void> => {
    const admin = await connect();
    expect(await admin.raw('CONFIG', 'SET', 'client-output-buffer-limit', spec)).toBe('+OK\r\n');
  };

  it('a normal client that stops reading is closed at its hard limit', async () => {
    await start();
    await setLimits('normal 1mb 0 0');
    const admin = await connect();
    expect(await admin.raw('SET', 'big', 'x'.repeat(8_000_000))).toBe('+OK\r\n');
    const stuck = await stuckClient(t!.port);
    // Four GETs of 8 MB: the kernel takes a few MB and the rest waits in the server.
    stuck.write(encodeCommand(['GET', 'big']).repeat(4));
    expect(await until(() => isClosed(stuck), 5000)).toBe(true);
    expect(t!.logs.some((l) => l.includes('overcoming of output buffer limits'))).toBe(true);
  });

  it('the default is no limit for normal clients', async () => {
    await start();
    const admin = await connect();
    await admin.raw('SET', 'big', 'x'.repeat(2_000_000));
    const slow = await stuckClient(t!.port);
    slow.write(encodeCommand(['GET', 'big']).repeat(20));
    await sleep(300);
    expect(serverHas(slow)).toBe(true);
  });

  it('a subscriber that never reads is disconnected while server memory stays flat', async () => {
    await start();
    await setLimits('pubsub 4mb 0 0');
    const stuck = await stuckClient(t!.port);
    stuck.write(encodeCommand(['SUBSCRIBE', 'ch']));
    await sleep(100);
    const pub = await connect();
    const payload = 'p'.repeat(100_000);
    const before = process.memoryUsage();
    let peakQueued = 0;
    let receivers = -1;
    let published = 0;
    // 200 MB in all; unbounded, the server would hold all of it but what the kernel took.
    for (; published < 2000; published++) {
      receivers = Number(await pub.call('PUBLISH', 'ch', payload));
      for (const c of t!.server.clients.values()) {
        if (c.channels.size > 0)
          peakQueued = Math.max(peakQueued, c.reply.pendingBytes + (c.socket?.writableLength ?? 0));
      }
      if (receivers === 0) break;
    }
    expect(receivers).toBe(0);
    expect(published).toBeLessThan(2000);
    expect(isClosed(stuck) || (await until(() => isClosed(stuck), 2000))).toBe(true);
    // The queue never grew past the limit by more than the message that crossed it.
    expect(peakQueued).toBeLessThan(4 * 1024 * 1024 + 2 * payload.length);
    const after = process.memoryUsage();
    expect(after.arrayBuffers - before.arrayBuffers).toBeLessThan(100 * 1024 * 1024);
    expect(t!.logs.some((l) => l.includes('overcoming of output buffer limits'))).toBe(true);
    expect(await pub.raw('PING')).toBe('+PONG\r\n');
  });

  it('a soft limit closes a client that stays over it for its seconds', async () => {
    await start();
    await setLimits('pubsub 1gb 100kb 1');
    const stuck = await stuckClient(t!.port);
    stuck.write(encodeCommand(['SUBSCRIBE', 'ch']));
    await sleep(100);
    const pub = await connect();
    const payload = 'p'.repeat(100_000);
    // Enough that the kernel's buffers are full and 100 KB is still waiting in the server.
    for (let i = 0; i < 400; i++) await pub.call('PUBLISH', 'ch', payload);
    // Over the soft limit, but not yet for a second.
    expect(isClosed(stuck)).toBe(false);
    expect(await until(() => isClosed(stuck), 4000)).toBe(true);
  });

  it('a subscriber that reads keeps its connection', async () => {
    await start();
    await setLimits('pubsub 1mb 512kb 60');
    const sub = await connect();
    await sub.raw('SUBSCRIBE', 'ch');
    const pub = await connect();
    for (let i = 0; i < 50; i++) {
      expect(await pub.call('PUBLISH', 'ch', 'm'.repeat(100_000))).toBe(1);
      await sub.read();
    }
    expect(serverHas(sub.socket)).toBe(true);
  });
});
