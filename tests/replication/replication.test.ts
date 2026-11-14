// The replication suite (spec 15.7): an in-process primary and two real replicas on random
// ports. Random writes of every type (TTLs, transactions, served blocking pops) reach both
// replicas exactly; a killed link resumes with a partial sync, or a full one once the backlog
// has moved past it; replicas are read-only and hide expired keys; and a promoted replica lets
// the other one continue from the history they shared.
import { afterEach, describe, expect, it } from 'vitest';
import { Generator } from '../differential/generator.js';
import { RespError, TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

const open: Array<TestServer | TestClient> = [];

afterEach(async () => {
  for (const thing of open.splice(0).reverse()) {
    if (thing instanceof TestClient) thing.socket.destroy();
    else await thing.close();
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Node {
  t: TestServer;
  c: TestClient;
}

async function node(directives: Record<string, string> = {}): Promise<Node> {
  const t = await startServer(directives);
  open.push(t);
  const c = await TestClient.connect(t.port);
  open.push(c);
  return { t, c };
}

async function client(n: Node): Promise<TestClient> {
  const c = await TestClient.connect(n.t.port);
  open.push(c);
  return c;
}

async function info(c: TestClient, section: string): Promise<Record<string, string>> {
  const text = String(await c.call('INFO', section));
  const out: Record<string, string> = {};
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

/** Both replicas' links are up and the primary streams to both. */
async function allOnline(primary: Node, replicas: Node[]): Promise<void> {
  await until(async () => {
    for (const r of replicas) {
      if ((await info(r.c, 'replication')).master_link_status !== 'up') return false;
    }
    const repl = await info(primary.c, 'replication');
    return replicas.every((_, i) => repl[`slave${i}`]?.includes('state=online') ?? false);
  });
}

/** A primary and two replicas of it, all synced. */
async function trio(primaryDirectives: Record<string, string> = {}): Promise<[Node, Node, Node]> {
  const p = await node(primaryDirectives);
  const r1 = await node({ replicaof: `127.0.0.1 ${p.t.port}` });
  const r2 = await node({ replicaof: `127.0.0.1 ${p.t.port}` });
  await allOnline(p, [r1, r2]);
  return [p, r1, r2];
}

const stat = async (c: TestClient, name: string): Promise<number> =>
  Number((await info(c, 'stats'))[name]);

describe('replication (spec 15.7)', () => {
  it('random writes of every type reach both replicas: equal digests after WAIT', async () => {
    const [p, r1, r2] = await trio();
    const gen = new Generator(2121, new Set(p.t.server.commands.keys()));
    for (let round = 0; round < 10; round++) {
      const batch: string[][] = [];
      for (let i = 0; i < 300; i++) batch.push(gen.next());
      batch.push(...gen.drain());
      for (const argv of batch) p.c.send(...argv);
      for (let i = 0; i < batch.length; i++) await p.c.read();
    }
    // Short TTLs, all gone before the digests (lazily, actively or hidden), and a long one.
    await p.c.call('SELECT', '0');
    for (let i = 0; i < 50; i++) await p.c.call('SET', `ttl${i}`, 'v', 'PX', String(20 + i));
    await p.c.call('HSET', 'h:ttl', 'f', 'v');
    await p.c.call('PEXPIRE', 'h:ttl', '100000');
    // Served blocking pops reach the replicas as plain pops after the push that fed them.
    const waiter = await client(p);
    for (const argv of [
      ['BLPOP', 'bl', '0'],
      ['BRPOP', 'bl', '0'],
      ['BLMOVE', 'bl', 'dst', 'LEFT', 'RIGHT', '0'],
    ]) {
      waiter.send(...argv);
      await until(() => p.t.server.waiters.blockedCount === 1);
      await p.c.call('RPUSH', 'bl', 'x');
      await waiter.read();
    }
    await sleep(300);
    expect(await p.c.call('WAIT', '2', '5000')).toBe(2);
    const digest = await p.c.call('DEBUG', 'DIGEST');
    expect(digest).not.toBe('0'.repeat(40));
    expect(await r1.c.call('DEBUG', 'DIGEST')).toBe(digest);
    expect(await r2.c.call('DEBUG', 'DIGEST')).toBe(digest);
    const offset = (await info(p.c, 'replication')).master_repl_offset;
    for (const r of [r1, r2]) {
      await until(async () => (await info(r.c, 'replication')).slave_repl_offset === offset);
    }
  });

  it('CLIENT KILL TYPE replica: both reconnect with a partial sync, no full one', async () => {
    const [p, r1, r2] = await trio();
    for (let i = 0; i < 100; i++) await p.c.call('SET', `k${i}`, String(i));
    expect(await p.c.call('WAIT', '2', '5000')).toBe(2);
    const full = await stat(p.c, 'sync_full');
    const partial = await stat(p.c, 'sync_partial_ok');
    expect(await p.c.call('CLIENT', 'KILL', 'TYPE', 'replica')).toBe(2);
    await p.c.call('SET', 'after', 'the kill');
    await allOnline(p, [r1, r2]);
    expect(await stat(p.c, 'sync_partial_ok')).toBe(partial + 2);
    expect(await stat(p.c, 'sync_full')).toBe(full);
    expect(await p.c.call('WAIT', '2', '5000')).toBe(2);
    const digest = await p.c.call('DEBUG', 'DIGEST');
    expect(await r1.c.call('DEBUG', 'DIGEST')).toBe(digest);
    expect(await r2.c.call('DEBUG', 'DIGEST')).toBe(digest);
  });

  it('with a 16kb backlog, 1 MB written while the link is down means a full sync', async () => {
    const [p, r1, r2] = await trio({ 'repl-backlog-size': '16kb' });
    const full = await stat(p.c, 'sync_full');
    // One transaction, so the kill and the 1 MB happen before either replica can reconnect.
    const value = 'v'.repeat(10_000);
    const tx: string[][] = [['MULTI'], ['CLIENT', 'KILL', 'TYPE', 'replica']];
    for (let i = 0; i < 100; i++) tx.push(['SET', `big${i}`, value]);
    tx.push(['EXEC']);
    for (const argv of tx) p.c.send(...argv);
    for (let i = 0; i < tx.length - 1; i++) await p.c.read();
    const result = await p.c.read();
    expect(Array.isArray(result) && result[0]).toBe(2);
    await allOnline(p, [r1, r2]);
    expect(await stat(p.c, 'sync_full')).toBe(full + 2);
    expect(await stat(p.c, 'sync_partial_err')).toBeGreaterThanOrEqual(2);
    expect(await p.c.call('WAIT', '2', '5000')).toBe(2);
    const digest = await p.c.call('DEBUG', 'DIGEST');
    expect(await r1.c.call('DEBUG', 'DIGEST')).toBe(digest);
    expect(await r2.c.call('DEBUG', 'DIGEST')).toBe(digest);
    expect(await r1.c.call('STRLEN', 'big99')).toBe(10_000);
  });

  it("a replica rejects writes, and hides an expired key before the primary's DEL", async () => {
    const [p, r1] = await trio();
    expect(await r1.c.call('SET', 'a', '1')).toEqual(
      new RespError("READONLY You can't write against a read only replica."),
    );
    expect(await p.c.call('DEBUG', 'SET-ACTIVE-EXPIRE', '0')).toBe('OK');
    await p.c.call('SET', 'k', 'v', 'PX', '300');
    await p.c.call('SET', 'other', 'v');
    expect(await p.c.call('WAIT', '2', '5000')).toBe(2);
    expect(await r1.c.call('GET', 'k')).toBe('v');
    await sleep(400);
    expect(await r1.c.call('GET', 'k')).toBeNull();
    expect(await r1.c.call('EXISTS', 'k')).toBe(0);
    expect(await r1.c.call('DBSIZE')).toBe(2); // still stored: no DEL has arrived
    // The primary collects it on a read and propagates DEL; then the replica lets go.
    expect(await p.c.call('GET', 'k')).toBeNull();
    expect(await p.c.call('WAIT', '2', '5000')).toBe(2);
    await until(async () => (await r1.c.call('DBSIZE')) === 1);
  });

  it('promotion: REPLICAOF NO ONE on replica 1, then replica 2 follows it with +CONTINUE', async () => {
    const [p, r1, r2] = await trio();
    for (let i = 0; i < 200; i++) await p.c.call('RPUSH', 'list', String(i));
    await p.c.call('HSET', 'h', 'f', 'v');
    expect(await p.c.call('WAIT', '2', '5000')).toBe(2);
    const offset = (await info(p.c, 'replication')).master_repl_offset;
    for (const r of [r1, r2]) {
      await until(async () => (await info(r.c, 'replication')).slave_repl_offset === offset);
    }
    // The primary fails; replica 1 takes over.
    open.splice(open.indexOf(p.t), 1);
    await p.t.close();
    expect(await r1.c.call('REPLICAOF', 'NO', 'ONE')).toBe('OK');
    expect(await r2.c.call('REPLICAOF', '127.0.0.1', String(r1.t.port))).toBe('OK');
    await allOnline(r1, [r2]);
    expect(await stat(r1.c, 'sync_partial_ok')).toBe(1);
    expect(await stat(r1.c, 'sync_full')).toBe(0);
    expect(r2.t.logs.some((l) => l.includes('Successful partial resynchronization'))).toBe(true);
    // The new primary's writes reach replica 2.
    await r1.c.call('RPUSH', 'list', 'after');
    expect(await r1.c.call('WAIT', '1', '5000')).toBe(1);
    expect(await r2.c.call('LLEN', 'list')).toBe(201);
    expect(await r2.c.call('DEBUG', 'DIGEST')).toBe(await r1.c.call('DEBUG', 'DIGEST'));
  });
});
