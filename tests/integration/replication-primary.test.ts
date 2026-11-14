// Step 20: the primary side of replication (spec 9.13), driven by fake replicas on raw sockets:
// full sync through the copy-on-write engine, partial sync from the backlog, the stream and its
// SELECTs, REPLCONF, heartbeats and keepalives, WAIT, ROLE, INFO, CLIENT KILL and the replica
// output limit. Replies were checked against the redis:7.4 reference.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crc64 } from '../../src/persistence/crc64.js';
import type { SnapshotSink } from '../../src/persistence/snapshot-job.js';
import { SnapshotJob } from '../../src/persistence/snapshot-job.js';
import { RespParser } from '../../src/protocol/parser.js';
import { Generator } from '../differential/generator.js';
import { FakeReplica } from '../helpers/fake-replica.js';
import { RespError, TestClient, encodeCommand } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

const open: Array<TestServer | TestClient | FakeReplica> = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const thing of open.splice(0).reverse()) {
    if (thing instanceof TestClient) thing.socket.destroy();
    else if (thing instanceof FakeReplica) await thing.close();
    else await thing.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** No heartbeat PINGs unless a test asks: they'd land between the bytes a test compares. */
async function boot(directives: Record<string, string> = {}): Promise<[TestServer, TestClient]> {
  const t = await startServer({ 'repl-ping-replica-period': '3600', ...directives });
  open.push(t);
  const c = await TestClient.connect(t.port);
  open.push(c);
  return [t, c];
}

async function client(t: TestServer): Promise<TestClient> {
  const c = await TestClient.connect(t.port);
  open.push(c);
  return c;
}

async function synced(t: TestServer, listeningPort = 7000): Promise<FakeReplica> {
  const r = await FakeReplica.synced(t.port, listeningPort);
  open.push(r);
  return r;
}

async function handshake(t: TestServer, opts?: Parameters<typeof FakeReplica.handshake>[1]) {
  const r = await FakeReplica.handshake(t.port, opts);
  open.push(r);
  return r;
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

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

const cmd = (...argv: string[]): string => encodeCommand(argv);

/** Splits stream bytes into commands, as a replica's parser would. */
function commands(stream: string): string[][] {
  const parser = new RespParser({ maxBulkLen: () => 1 << 30, authRequired: () => false });
  parser.feed(Buffer.from(stream, 'latin1'));
  const out: string[][] = [];
  for (let next = parser.next(); next !== null; next = parser.next()) out.push([...next.argv]);
  return out;
}

describe('full sync (spec 9.13)', () => {
  it('sends +FULLRESYNC, a snapshot with a valid checksum, then the live stream', async () => {
    const [t, c] = await boot();
    await c.call('SET', 'a', '1');
    await c.call('RPUSH', 'l', 'x', 'y');
    const r = await handshake(t, { listeningPort: 7001 });
    const reply = await r.psync('?', -1);
    if (reply.kind !== 'full') throw new Error('expected a full sync');
    const before = await info(c, 'replication');
    expect(reply).toEqual({
      kind: 'full',
      replid: before.master_replid,
      offset: Number(before.master_repl_offset),
    });
    const payload = r.payload!;
    expect(payload.subarray(0, 13).toString('latin1')).toBe('MINIREDIS0001');
    const body = payload.subarray(0, payload.length - 8);
    expect(payload.readBigUInt64LE(payload.length - 8)).toBe(crc64(body));

    // The first record after a full sync carries a SELECT (spec 9.5); later ones only on change.
    await c.call('SET', 'live', '1');
    await c.call('INCR', 'live');
    await c.call('SELECT', '3');
    await c.call('SET', 'x', 'y');
    await c.call('PUBLISH', 'ch', 'hello');
    await c.call('SELECT', '0');
    const expected =
      cmd('SELECT', '0') +
      cmd('SET', 'live', '1') +
      cmd('INCR', 'live') +
      cmd('SELECT', '3') +
      cmd('SET', 'x', 'y') +
      cmd('PUBLISH', 'ch', 'hello');
    expect(await r.waitStream((s) => s.length >= expected.length)).toBe(expected);

    const after = await info(c, 'replication');
    expect(after.role).toBe('master');
    expect(after.connected_slaves).toBe('1');
    expect(after.slave0).toMatch(/^ip=127\.0\.0\.1,port=7001,state=online,offset=0,lag=\d+$/);
    expect(Number(after.master_repl_offset)).toBe(reply.offset + expected.length);
    expect(after.repl_backlog_active).toBe('1');
    expect(after.repl_backlog_histlen).toBe(String(expected.length));
    expect(after.repl_backlog_first_byte_offset).toBe(String(reply.offset + 1));
    expect(after.master_replid2).toBe('0'.repeat(40));
    expect(after.second_repl_offset).toBe('-1');
    const stats = await info(c, 'stats');
    expect([stats.sync_full, stats.sync_partial_ok, stats.sync_partial_err]).toEqual([
      '1',
      '0',
      '0',
    ]);
    expect(
      t.logs.some((l) => l.includes('Synchronization with replica 127.0.0.1:7001 succeeded')),
    ).toBe(true);
  });

  it('starts every full sync with a SELECT, even when the stream is already in that db', async () => {
    const [t, c] = await boot();
    const r1 = await synced(t, 7001);
    await c.call('SET', 'a', '1');
    await r1.waitStream((s) => s.endsWith(cmd('SET', 'a', '1')));
    const r2 = await synced(t, 7002);
    await c.call('SET', 'b', '2');
    expect(await r2.waitStream((s) => s.length > 0 && s.endsWith(cmd('SET', 'b', '2')))).toBe(
      cmd('SELECT', '0') + cmd('SET', 'b', '2'),
    );
    // The stream is shared, so r1 gets that SELECT too: redundant for it, and harmless.
    expect(await r1.waitStream((s) => s.endsWith(cmd('SET', 'b', '2')))).toBe(
      cmd('SELECT', '0') + cmd('SET', 'a', '1') + cmd('SELECT', '0') + cmd('SET', 'b', '2'),
    );
  });

  it('gives the replica a new replication ID when the backlog is created, as Redis does', async () => {
    const [t, c] = await boot();
    const first = (await info(c, 'replication')).master_replid!;
    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect((await info(c, 'replication')).repl_backlog_active).toBe('0');
    const reply = await (await handshake(t)).psync('?', -1);
    expect(reply.kind === 'full' && reply.replid).not.toBe(first);
    expect((await info(c, 'replication')).master_replid).toBe(
      reply.kind === 'full' && reply.replid,
    );
  });

  it('keeps the offset growing with no replica once the backlog exists (it is never freed)', async () => {
    const [t, c] = await boot();
    const r = await synced(t);
    await r.close();
    await until(async () => (await info(c, 'replication')).connected_slaves === '0');
    const before = Number((await info(c, 'replication')).master_repl_offset);
    await c.call('SET', 'k', 'v');
    const after = await info(c, 'replication');
    // The first record since the full sync still carries its SELECT (spec 9.5).
    expect(Number(after.master_repl_offset)).toBe(
      before + cmd('SELECT', '0').length + cmd('SET', 'k', 'v').length,
    );
    expect(after.repl_backlog_active).toBe('1');
  });

  it('rebuilds the primary exactly from the payload plus the stream, under concurrent writes', async () => {
    const [t, c] = await boot();
    // Enough keys that the walk takes many slices while writes keep coming.
    let pipeline = '';
    for (let i = 0; i < 30_000; i++) pipeline += cmd('SET', `seed:${i}`, `v${i}`);
    c.write(pipeline);
    for (let i = 0; i < 30_000; i++) await c.read();

    const writer = await client(t);
    // No flushes: they abort the full sync and drop the replica (spec 9.8), tested below.
    const names = [...t.server.commands.keys()].filter((n) => !n.startsWith('flush'));
    const gen = new Generator(2020, new Set(names));
    let writing = true;
    const writes = (async () => {
      while (writing) {
        const batch: string[][] = [];
        for (let i = 0; i < 100; i++) batch.push(gen.next());
        batch.push(...gen.drain());
        for (const argv of batch) writer.send(...argv);
        for (let i = 0; i < batch.length; i++) await writer.read();
      }
    })();
    await sleep(20);
    const r = await handshake(t);
    const reply = await r.psync('?', -1);
    await sleep(50);
    writing = false;
    await writes;
    await writer.call('SELECT', '0');
    const end = Number((await info(c, 'replication')).master_repl_offset);
    await r.waitOffset(end);
    expect(r.offset).toBe(end);
    expect(reply.kind).toBe('full');
    expect(t.server.stats.syncFull).toBe(1);
    // The writes really overlapped the walk: the hook saved keys just before they changed.
    const cow = t.logs.map((l) => /Copy-on-write saved (\d+) of/.exec(l)).find((m) => m !== null);
    expect(Number(cow![1])).toBeGreaterThan(0);

    const dir = mkdtempSync(join(tmpdir(), 'miniredis-repl-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'dump.mrdb'), r.payload!);
    const copy = await startServer({ dir });
    open.push(copy);
    const cc = await client(copy);
    for (const argv of commands(r.stream)) await cc.call(...argv);
    expect(await cc.call('DEBUG', 'DIGEST')).toBe(await c.call('DEBUG', 'DIGEST'));
  });

  it('makes a replica wait while another job runs, sending a newline every second', async () => {
    const [t, c] = await boot();
    await c.call('SET', 'k', 'v');
    // A job whose output never finishes keeps the engine busy.
    const stuck: SnapshotSink = {
      write() {},
      flush() {},
      backlogged: false,
      error: null,
      end() {},
      abort() {},
    };
    const job = new SnapshotJob(t.server, 'bgsave', stuck, () => {});
    const r = await handshake(t);
    const sync = r.psync('?', -1);
    await until(async () => /state=wait_bgsave/.test((await info(c, 'replication')).slave0 ?? ''));
    await sleep(1300);
    expect(r.newlines).toBeGreaterThanOrEqual(1);
    job.abort('test');
    const reply = await sync;
    expect(reply.kind).toBe('full');
    await c.call('SET', 'after', '1');
    await r.waitStream((s) => s.includes('after'));
  });

  it('refuses BGSAVE and SAVE during a full sync; a flush aborts it and drops the replica', async () => {
    const [t, c] = await boot();
    for (let i = 0; i < 100; i++) await c.call('SET', `k${i}`, 'v');
    // The server runs in this process: hold the walk the moment it starts, by making its sink
    // look backlogged, so the job is surely still running when the commands below arrive.
    const repl = t.server.repl;
    const start = repl.startFullSync.bind(repl);
    repl.startFullSync = () => {
      start();
      const job = t.server.snapshotJob;
      if (job?.kind === 'fullsync') Object.defineProperty(job.sink, 'backlogged', { value: true });
    };
    const r = await handshake(t);
    r.send('PSYNC', '?', '-1');
    await until(() => t.server.snapshotJob?.kind === 'fullsync');
    expect(t.server.snapshotJob!.walking).toBe(true);
    expect(await c.raw('BGSAVE')).toBe('-ERR Background save already in progress\r\n');
    expect(await c.raw('SAVE')).toBe('-ERR Background save already in progress\r\n');
    expect((await info(c, 'persistence')).rdb_bgsave_in_progress).toBe('1');
    expect(await c.call('FLUSHALL')).toBe('OK');
    await r.closed;
    expect(t.server.snapshotJob).toBeNull();
    expect((await info(c, 'replication')).connected_slaves).toBe('0');
  });
});

describe('partial sync (spec 9.13)', () => {
  it('answers +CONTINUE and sends exactly the bytes the replica missed', async () => {
    const [t, c] = await boot();
    const first = await synced(t);
    await c.call('SET', 'a', '1');
    await first.waitStream((s) => s.endsWith(cmd('SET', 'a', '1')));
    const replid = (await info(c, 'replication')).master_replid!;
    const seen = first.offset;
    await first.close();
    await c.call('SET', 'b', '2');
    await c.call('INCR', 'n');

    const again = await handshake(t);
    expect(await again.psync(replid, seen + 1)).toEqual({ kind: 'continue', replid });
    const missed = cmd('SET', 'b', '2') + cmd('INCR', 'n');
    expect(await again.waitStream((s) => s.length >= missed.length)).toBe(missed);
    // Then it's online: live writes follow, with no SELECT (the stream's db didn't change).
    await c.call('DEL', 'a');
    await again.waitStream((s) => s.length > missed.length);
    await sleep(50);
    expect(again.stream).toBe(missed + cmd('DEL', 'a'));
    const stats = await info(c, 'stats');
    expect([stats.sync_full, stats.sync_partial_ok, stats.sync_partial_err]).toEqual([
      '1',
      '1',
      '0',
    ]);
    expect(t.logs.some((l) => l.includes('Partial resynchronization request from'))).toBe(true);
  });

  it('answers a bare +CONTINUE to a replica without capa psync2, and nothing past the end', async () => {
    const [t, c] = await boot();
    await (await synced(t)).close();
    const { master_replid: replid, master_repl_offset: offset } = await info(c, 'replication');
    const r = await handshake(t, { psync2: false });
    expect(await r.psync(replid!, Number(offset) + 1)).toEqual({ kind: 'continue', replid: null });
    await sleep(50);
    expect(r.stream).toBe('');
  });

  it('falls back to a full sync for an offset outside the backlog or another replid', async () => {
    const [t, c] = await boot({ 'repl-backlog-size': '1024' });
    const first = await synced(t);
    const seen = first.offset;
    await first.close();
    for (let i = 0; i < 20; i++) await c.call('SET', `k${i}`, 'x'.repeat(100));
    const { master_replid: replid, master_repl_offset: offset } = await info(c, 'replication');

    const gone = await handshake(t);
    expect((await gone.psync(replid!, seen + 1)).kind).toBe('full');
    const ahead = await handshake(t);
    expect((await ahead.psync(replid!, Number(offset) + 2)).kind).toBe('full');
    const other = await handshake(t);
    expect((await other.psync('f'.repeat(40), Number(offset) + 1)).kind).toBe('full');
    const stats = await info(c, 'stats');
    expect([stats.sync_full, stats.sync_partial_ok, stats.sync_partial_err]).toEqual([
      '4',
      '0',
      '3',
    ]);
    const repl = await info(c, 'replication');
    expect(repl.repl_backlog_size).toBe('1024');
    expect(Number(repl.repl_backlog_histlen)).toBeLessThanOrEqual(1024);
  });

  it('rejects a bad offset with an error and leaves the client a normal client', async () => {
    const [t] = await boot();
    const r = await handshake(t);
    expect(await r.command('PSYNC', '?', 'x')).toBe('-ERR value is not an integer or out of range');
    expect(await r.command('PING')).toBe('+PONG');
  });

  it('keeps the newest bytes when the backlog is resized', async () => {
    const [t, c] = await boot();
    const r = await synced(t);
    for (let i = 0; i < 50; i++) await c.call('SET', `k${i}`, 'v'.repeat(50));
    await r.waitOffset(Number((await info(c, 'replication')).master_repl_offset));
    expect(await c.call('CONFIG', 'SET', 'repl-backlog-size', '512')).toBe('OK');
    const repl = await info(c, 'replication');
    expect(repl.repl_backlog_size).toBe('512');
    expect(repl.repl_backlog_histlen).toBe('512');
    // A replica 100 bytes behind can still continue, and gets exactly those bytes.
    const behind = await handshake(t);
    const end = Number(repl.master_repl_offset);
    expect((await behind.psync(repl.master_replid!, end - 99)).kind).toBe('continue');
    expect(await behind.waitStream((s) => s.length >= 100)).toBe(r.stream.slice(-100));
  });
});

describe('the stream (spec 9.5, 9.13)', () => {
  it('wraps a transaction in MULTI … EXEC and sends lazy-expiry DELs', async () => {
    const [t, c] = await boot();
    const r = await synced(t);
    await c.call('DEBUG', 'SET-ACTIVE-EXPIRE', '0');
    await c.call('SET', 'gone', 'v', 'PX', '1');
    await sleep(5);
    await c.call('MULTI');
    await c.call('GET', 'gone');
    await c.call('SET', 'k', 'v');
    await c.call('EXEC');
    await r.waitStream((s) => s.includes('EXEC'));
    const names = commands(r.stream).map((argv) => argv[0]!.toUpperCase());
    expect(names).toEqual(['SELECT', 'SET', 'MULTI', 'DEL', 'SET', 'EXEC']);
  });

  it('sends a PING every repl-ping-replica-period seconds, counted in the offset', async () => {
    const [t, c] = await boot({ 'repl-ping-replica-period': '1' });
    const r = await synced(t);
    await r.waitStream((s) => s.includes(cmd('PING')), 3000);
    expect(r.stream.startsWith(cmd('PING'))).toBe(true);
    const offset = Number((await info(c, 'replication')).master_repl_offset);
    expect(offset).toBeGreaterThanOrEqual(r.offset);
  });

  it('disconnects a replica that sends a command with a reply, as Redis does', async () => {
    const [t, c] = await boot();
    const r = await synced(t);
    r.send('PING');
    await r.closed;
    expect(t.logs.some((l) => l.includes("Replica generated a reply to command 'ping'"))).toBe(
      true,
    );
    await until(async () => (await info(c, 'replication')).connected_slaves === '0');
  });

  it('cuts off a replica that stops reading past the replica output limit', async () => {
    const [t, c] = await boot();
    expect(await c.call('CONFIG', 'SET', 'client-output-buffer-limit', 'replica 1mb 0 0')).toBe(
      'OK',
    );
    const r = await synced(t);
    r.socket.pause();
    const value = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 40 && !t.logs.some((l) => l.includes('output buffer limits')); i++) {
      await c.call('SET', `big${i}`, value);
    }
    await until(async () => (await info(c, 'replication')).connected_slaves === '0');
    expect(t.logs.some((l) => l.includes('for overcoming of output buffer limits'))).toBe(true);
  });

  it('applies the soft limit only after it has been exceeded for its seconds', async () => {
    const [t, c] = await boot();
    await c.call('CONFIG', 'SET', 'client-output-buffer-limit', 'replica 0 64kb 1');
    const r = await synced(t);
    r.socket.pause();
    const value = 'x'.repeat(256 * 1024);
    for (let i = 0; i < 40; i++) await c.call('SET', `big${i}`, value);
    expect((await info(c, 'replication')).connected_slaves).toBe('1');
    await until(async () => (await info(c, 'replication')).connected_slaves === '0', 4000);
  });
});

describe('REPLCONF', () => {
  it('replies as Redis 7.4 does, and never to ACK or GETACK', async () => {
    const [, c] = await boot();
    expect(await c.raw('REPLCONF')).toBe('+OK\r\n');
    expect(await c.raw('REPLCONF', 'a')).toBe('-ERR syntax error\r\n');
    expect(await c.raw('REPLCONF', 'foo', 'bar')).toBe(
      '-ERR Unrecognized REPLCONF option: foo\r\n',
    );
    expect(await c.raw('REPLCONF', 'listening-port', 'x')).toBe(
      '-ERR value is not an integer or out of range\r\n',
    );
    expect(await c.raw('REPLCONF', 'listening-port', '1', 'capa', 'psync2', 'capa', 'eof')).toBe(
      '+OK\r\n',
    );
    c.send('REPLCONF', 'ACK', '5');
    c.send('REPLCONF', 'GETACK', '*');
    c.send('REPLCONF', 'ACK', 'x');
    expect(await c.raw('PING')).toBe('+PONG\r\n');
  });

  it('records ACKs, shown in INFO and ROLE', async () => {
    const [t, c] = await boot();
    const r = await synced(t, 7002);
    await c.call('SET', 'k', 'v');
    await r.waitStream((s) => s.length > 0);
    r.ack();
    await until(async () => (await info(c, 'replication')).slave0!.includes(`offset=${r.offset},`));
    expect(await c.call('ROLE')).toEqual([
      'master',
      r.offset,
      [['127.0.0.1', '7002', String(r.offset)]],
    ]);
  });
});

describe('WAIT (spec 9.13)', () => {
  it("blocks until enough replicas acknowledge the client's last write", async () => {
    const [t, c] = await boot();
    const r1 = await synced(t, 7001);
    const r2 = await synced(t, 7002);
    await c.call('SET', 'k', 'v');
    c.send('WAIT', '2', '0');
    c.send('PING');
    // The primary asks for ACKs at the end of the turn; the ask is part of the stream.
    const getack = cmd('REPLCONF', 'GETACK', '*');
    await r1.waitStream((s) => s.endsWith(getack));
    await r2.waitStream((s) => s.endsWith(getack));
    r1.ack();
    await sleep(50);
    expect(c.unread).toBe('');
    r2.ack();
    expect(await c.readRaw()).toBe(':2\r\n');
    // The pipelined PING runs only after WAIT returned (rule 12).
    expect(await c.read()).toBe('PONG');
  });

  it('replies with the count reached so far when the timeout ends', async () => {
    const [t, c] = await boot();
    const r1 = await synced(t, 7001);
    await synced(t, 7002);
    await c.call('SET', 'k', 'v');
    const started = Date.now();
    c.send('WAIT', '2', '200');
    await r1.waitStream((s) => s.includes('GETACK'));
    r1.ack();
    expect(await c.read()).toBe(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  it('replies at once when enough have acknowledged, or inside MULTI', async () => {
    const [t, c] = await boot();
    expect(await c.raw('WAIT', '0', '0')).toBe(':0\r\n');
    expect(await c.raw('WAIT', '-1', '0')).toBe(':0\r\n');
    const r = await synced(t);
    await c.call('SET', 'k', 'v');
    await r.waitStream((s) => s.length > 0);
    r.ack();
    await until(async () => (await info(c, 'replication')).slave0!.includes(`offset=${r.offset},`));
    expect(await c.raw('WAIT', '1', '0')).toBe(':1\r\n');
    await c.call('SET', 'k', 'w');
    expect(await c.call('MULTI')).toBe('OK');
    expect(await c.call('WAIT', '1', '1000')).toBe('QUEUED');
    expect(await c.call('EXEC')).toEqual([0]);
  });

  it('checks its arguments as Redis 7.4 does', async () => {
    const [, c] = await boot();
    expect(await c.raw('WAIT', 'x', '-1')).toBe('-ERR value is not an integer or out of range\r\n');
    expect(await c.raw('WAIT', '1', '-1')).toBe('-ERR timeout is negative\r\n');
    expect(await c.raw('WAIT', '0', 'x')).toBe(
      '-ERR timeout is not an integer or out of range\r\n',
    );
  });

  it('forgets a waiting client that disconnects', async () => {
    const [t] = await boot();
    await synced(t);
    const w = await client(t);
    await w.call('SET', 'k', 'v');
    w.send('WAIT', '1', '0');
    await until(() => t.server.repl.waitingCount === 1);
    w.socket.destroy();
    await until(() => t.server.repl.waitingCount === 0);
  });
});

describe('ROLE', () => {
  it('lists only online replicas, with port and offset as bulk strings', async () => {
    const [t, c] = await boot();
    expect(await c.raw('ROLE')).toBe('*3\r\n$6\r\nmaster\r\n:0\r\n*0\r\n');
    await synced(t, 7005);
    expect(await c.call('ROLE')).toEqual([
      'master',
      expect.any(Number),
      [['127.0.0.1', '7005', '0']],
    ]);
  });
});

describe('CLIENT KILL', () => {
  it('kills replicas by TYPE (replica or slave)', async () => {
    const [t, c] = await boot();
    const r1 = await synced(t, 7001);
    const r2 = await synced(t, 7002);
    expect(await c.call('CLIENT', 'KILL', 'TYPE', 'replica')).toBe(2);
    await r1.closed;
    await r2.closed;
    await until(async () => (await info(c, 'replication')).connected_slaves === '0');
    expect(await c.call('CLIENT', 'KILL', 'TYPE', 'slave')).toBe(0);
    expect(t.logs.some((l) => l.includes('Connection with replica 127.0.0.1:7001 lost'))).toBe(
      true,
    );
  });

  it('kills by ID, ADDR and TYPE, skipping the caller unless SKIPME no', async () => {
    const [t, c] = await boot();
    const other = await client(t);
    const otherId = Number(await other.call('CLIENT', 'ID'));
    expect(await c.call('CLIENT', 'KILL', 'ID', '99999')).toBe(0);
    expect(await c.call('CLIENT', 'KILL', 'ID', String(otherId))).toBe(1);
    await other.closed;

    const third = await client(t);
    const addr = `${third.socket.localAddress}:${third.socket.localPort}`;
    expect(await c.call('CLIENT', 'KILL', 'ADDR', addr)).toBe(1);
    await third.closed;

    const sub = await client(t);
    await sub.call('SUBSCRIBE', 'ch');
    expect(await c.call('CLIENT', 'KILL', 'TYPE', 'pubsub')).toBe(1);
    await sub.closed;

    expect(await c.call('CLIENT', 'KILL', 'TYPE', 'normal')).toBe(0);
    expect(await c.call('CLIENT', 'KILL', 'TYPE', 'master')).toBe(0);
    expect(await c.raw('CLIENT', 'KILL', 'TYPE', 'normal', 'SKIPME', 'no')).toBe(':1\r\n');
    await c.closed;
  });

  it('kills by address in the old form', async () => {
    const [t, c] = await boot();
    const other = await client(t);
    const addr = `${other.socket.localAddress}:${other.socket.localPort}`;
    expect(await c.raw('CLIENT', 'KILL', addr)).toBe('+OK\r\n');
    await other.closed;
    expect(await c.raw('CLIENT', 'KILL', addr)).toBe('-ERR No such client\r\n');
  });

  it('checks its arguments as Redis 7.4 does', async () => {
    const [, c] = await boot();
    expect(await c.raw('CLIENT', 'KILL')).toBe(
      "-ERR wrong number of arguments for 'client|kill' command\r\n",
    );
    for (const id of ['x', '0', '-5']) {
      expect(await c.raw('CLIENT', 'KILL', 'ID', id)).toBe(
        '-ERR client-id should be greater than 0\r\n',
      );
    }
    expect(await c.raw('CLIENT', 'KILL', 'TYPE', 'foo')).toBe("-ERR Unknown client type 'foo'\r\n");
    expect(await c.raw('CLIENT', 'KILL', 'ID', '1', 'TYPE')).toBe('-ERR syntax error\r\n');
    expect(await c.raw('CLIENT', 'KILL', 'SKIPME', 'maybe')).toBe('-ERR syntax error\r\n');
    expect(await c.raw('CLIENT', 'KILL', 'BOGUS', 'x')).toBe('-ERR syntax error\r\n');
    expect(await c.call('PING')).toBe('PONG');
    expect(await c.call('CLIENT', 'KILL', 'ID', '5', 'ID', '6')).not.toBeInstanceOf(RespError);
  });
});
