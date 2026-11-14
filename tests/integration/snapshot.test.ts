// Step 13: snapshots end to end (spec 9.8, 9.9, 11.2): SAVE, BGSAVE and LASTSAVE with Redis
// 7.4's replies (checked against the reference), DEBUG RELOAD, loading at startup, save points,
// FLUSHALL, damaged files, and BGSAVE staying point-in-time under load. The PING latency check
// during a 1M-key BGSAVE lives in tests/perf/ (npm run test:perf): it would starve the
// rest of this suite of CPU when the machine is slow.
import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../../src/config.js';
import { SnapshotLoadError, readSnapshot } from '../../src/persistence/snapshot-format.js';
import type { PropagationRecord } from '../../src/server/propagate.js';
import { Server } from '../../src/server/server.js';
import { createStringObject } from '../../src/storage/redis-object.js';
import { Generator } from '../differential/generator.js';
import { TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let dir: string;
const open: Array<TestServer | TestClient> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'miniredis-snap-it-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const thing of open.splice(0).reverse()) {
    if (thing instanceof TestClient) thing.socket.destroy();
    else await thing.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dumpPath = () => join(dir, 'dump.mrdb');
const temps = () => readdirSync(dir).filter((n) => n.startsWith('temp-'));

async function boot(directives: Record<string, string> = {}): Promise<[TestServer, TestClient]> {
  const t = await startServer({ dir, ...directives });
  open.push(t);
  const c = await TestClient.connect(t.port);
  open.push(c);
  return [t, c];
}

async function stop(t: TestServer, c: TestClient): Promise<void> {
  c.socket.destroy();
  await t.close();
  open.splice(open.indexOf(c), 1);
  open.splice(open.indexOf(t), 1);
}

/** Enough keys that a BGSAVE takes many slices. */
function fillDirect(t: TestServer, n: number, value = 'v'): void {
  const db = t.server.dbs[0]!;
  for (let i = 0; i < n; i++) db.add(`fill:${i}`, createStringObject(value));
}

const info = async (c: TestClient, field: string): Promise<string> => {
  const text = (await c.call('INFO', 'persistence')) as string;
  return new RegExp(`\\r\\n${field}:([^\\r]*)\\r\\n`).exec(text)![1]!;
};

const waitForBgsave = (t: TestServer) =>
  vi.waitFor(() => expect(t.server.snapshotJob).toBeNull(), { timeout: 15_000, interval: 1 });

describe('SAVE, BGSAVE and LASTSAVE', () => {
  it('reply as Redis 7.4 does', async () => {
    const [t, c] = await boot();
    await c.call('SET', 'k', 'v');
    expect(await c.raw('SAVE')).toBe('+OK\r\n');
    expect(existsSync(dumpPath())).toBe(true);
    const lastsave = await c.call('LASTSAVE');
    expect(typeof lastsave).toBe('number');
    expect(Math.abs((lastsave as number) - Date.now() / 1000)).toBeLessThan(2);
    expect(await c.raw('BGSAVE')).toBe('+Background saving started\r\n');
    await waitForBgsave(t);
    expect(await c.raw('BGSAVE', 'SCHEDULE')).toBe('+Background saving started\r\n');
    await waitForBgsave(t);
    expect(await c.raw('BGSAVE', 'foo')).toBe('-ERR syntax error\r\n');
    expect(await c.raw('BGSAVE', 'schedule', 'x')).toBe('-ERR syntax error\r\n');
    expect(await c.raw('SAVE', 'x')).toBe("-ERR wrong number of arguments for 'save' command\r\n");
    expect(await c.raw('LASTSAVE', 'x')).toBe(
      "-ERR wrong number of arguments for 'lastsave' command\r\n",
    );
    expect(await info(c, 'rdb_last_bgsave_status')).toBe('ok');
    expect(await info(c, 'rdb_bgsave_in_progress')).toBe('0');
  });

  it('refuse to start while a job runs, and INFO shows it', async () => {
    const [t, c] = await boot();
    fillDirect(t, 200_000);
    // Pipelined, so all three run in the turn the first one starts the job.
    c.send('BGSAVE');
    c.send('BGSAVE');
    c.send('SAVE');
    c.send('INFO', 'persistence');
    expect(await c.read()).toBe('Background saving started');
    const inProgress = '-ERR Background save already in progress\r\n';
    expect(await c.readRaw()).toBe(inProgress);
    expect(await c.readRaw()).toBe(inProgress);
    expect(await c.read()).toContain('\r\nrdb_bgsave_in_progress:1\r\n');
    await waitForBgsave(t);
    expect(await info(c, 'rdb_bgsave_in_progress')).toBe('0');
  });

  it('SAVE is refused inside MULTI; BGSAVE inside EXEC is scheduled for serverCron', async () => {
    const [t, c] = await boot({ hz: '50' });
    await c.call('MULTI');
    expect(await c.raw('SAVE')).toBe('-ERR Command not allowed inside a transaction\r\n');
    await c.call('DISCARD');
    await c.call('SET', 'k', 'v');
    await c.call('MULTI');
    await c.call('BGSAVE');
    await c.call('LASTSAVE');
    const replies = (await c.call('EXEC')) as unknown[];
    expect(replies[0]).toBe('Background saving scheduled');
    expect(t.server.bgsaveScheduled).toBe(true);
    await vi.waitFor(() => expect(existsSync(dumpPath())).toBe(true));
    await waitForBgsave(t);
    expect(t.server.bgsaveScheduled).toBe(false);
    expect(await info(c, 'rdb_changes_since_last_save')).toBe('0');
  });

  it('a save that cannot write replies a bare -ERR and records the failure', async () => {
    const [, c] = await boot();
    const openSync = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path).includes('temp-')) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return (openSync as (...a: unknown[]) => number)(path, ...rest);
    }) as typeof fs.openSync);
    expect(await c.raw('BGSAVE')).toBe('-ERR\r\n');
    expect(await info(c, 'rdb_last_bgsave_status')).toBe('err');
    expect(await c.raw('SAVE')).toBe('-ERR\r\n');
    vi.restoreAllMocks();
    expect(await c.raw('SAVE')).toBe('+OK\r\n');
    expect(await info(c, 'rdb_last_bgsave_status')).toBe('ok');
  });
});

describe('DEBUG RELOAD and restarts', () => {
  it('DEBUG RELOAD keeps DEBUG DIGEST for every type, TTLs and binary data', async () => {
    const [t, c] = await boot();
    const gen = new Generator(4321, new Set(t.server.commands.keys()));
    for (let round = 0; round < 10; round++) {
      const batch: string[][] = [];
      for (let i = 0; i < 300; i++) batch.push(gen.next());
      batch.push(...gen.drain());
      for (const argv of batch) c.send(...argv);
      for (let i = 0; i < batch.length; i++) await c.read();
    }
    await c.call('SELECT', '0');
    const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
    await c.call('SET', binary, binary);
    await c.call('RPUSH', 'list', binary, 'b');
    await c.call('HSET', 'hash', binary, binary);
    await c.call('SADD', 'set', binary);
    await c.call('ZADD', 'zset', '-inf', binary, '1.5', 'm');
    await c.call('SET', 'ttl', 'v', 'EX', '1000');
    const digest = await c.call('DEBUG', 'DIGEST');
    expect(digest).not.toBe('0'.repeat(40));
    expect(await c.raw('DEBUG', 'RELOAD')).toBe('+OK\r\n');
    expect(await c.call('DEBUG', 'DIGEST')).toBe(digest);
    expect(await c.call('GET', binary)).toBe(binary);
    expect(t.logs.some((l) => l.includes('DB reloaded by DEBUG RELOAD'))).toBe(true);
  });

  it('a relative TTL keeps counting down across a reload', async () => {
    const [, c] = await boot();
    await c.call('SET', 'k', 'v');
    await c.call('EXPIRE', 'k', '100');
    await sleep(2000);
    expect(await c.call('DEBUG', 'RELOAD')).toBe('OK');
    const ttl = Number(await c.call('TTL', 'k'));
    expect(ttl).toBeGreaterThan(90);
    expect(ttl).toBeLessThanOrEqual(98);
  });

  it('DEBUG RELOAD resets the watches on keys it reloads', async () => {
    const [t, c] = await boot();
    const other = await TestClient.connect(t.port);
    open.push(other);
    await c.call('SET', 'w', '1');
    await other.call('WATCH', 'w');
    await c.call('DEBUG', 'RELOAD');
    await other.call('MULTI');
    await other.call('SET', 'w', '2');
    expect(await other.call('EXEC')).toBeNull();
  });

  it('a restart loads dump.mrdb, skipping keys that expired meanwhile', async () => {
    let [t, c] = await boot();
    await c.call('SET', 'a', '1');
    await c.call('SELECT', '7');
    await c.call('RPUSH', 'l', 'x', 'y');
    await c.call('SET', 'brief', 'v', 'PX', '300');
    await c.call('SAVE');
    await stop(t, c);
    await sleep(400);
    [t, c] = await boot();
    expect(await c.call('GET', 'a')).toBe('1');
    await c.call('SELECT', '7');
    expect(await c.call('LRANGE', 'l', '0', '-1')).toEqual(['x', 'y']);
    expect(await c.call('EXISTS', 'brief')).toBe(0);
    expect(await info(c, 'rdb_changes_since_last_save')).toBe('0');
    expect(t.logs.some((l) => l.includes('keys loaded: 2, keys expired: 1'))).toBe(true);
  });

  it('with appendonly yes, startup loads the AOF and not the snapshot', async () => {
    let [t, c] = await boot({ appendonly: 'yes' });
    await c.call('SET', 'from-aof', '1');
    await stop(t, c);
    // With the AOF off, the AOF on disk is left alone and only the snapshot gets this key.
    [t, c] = await boot();
    await c.call('SET', 'from-snapshot', '1');
    await c.call('SAVE');
    await stop(t, c);
    [, c] = await boot({ appendonly: 'yes' });
    expect(await c.call('EXISTS', 'from-aof')).toBe(1);
    expect(await c.call('EXISTS', 'from-snapshot')).toBe(0);
  });

  it('a damaged snapshot stops startup with its offset, and stays on disk', async () => {
    const [t, c] = await boot();
    for (let i = 0; i < 50; i++) await c.call('SET', `k${i}`, `v${i}`);
    await c.call('SAVE');
    await stop(t, c);
    const data = readFileSync(dumpPath());
    data[Math.floor(data.length / 2)]! ^= 0x20;
    writeFileSync(dumpPath(), data);
    const logs: string[] = [];
    const config = Config.fromDirectives(
      Object.entries({ dir, port: '0' }).map(([name, value]) => ({
        args: [name, value],
        where: 'in a test',
        line: `${name} ${value}`,
      })),
    );
    const server = new Server({ config, log: (l) => logs.push(l) });
    await expect(server.start()).rejects.toBeInstanceOf(SnapshotLoadError);
    expect(logs.some((l) => /Bad snapshot file .*dump\.mrdb: .* at offset \d+/.test(l))).toBe(true);
    expect(readFileSync(dumpPath())).toEqual(data);
    await server.close();
  });

  it('startup deletes temp files a crash left behind, and nothing else', async () => {
    writeFileSync(join(dir, 'temp-123-4.mrdb'), 'half');
    writeFileSync(join(dir, 'temp-rewrite-123.aof'), 'half');
    writeFileSync(join(dir, 'keep-me.mrdb'), 'mine');
    const [t] = await boot();
    expect(temps()).toEqual([]);
    expect(existsSync(join(dir, 'keep-me.mrdb'))).toBe(true);
    expect(t.logs.some((l) => l.includes('Removed leftover temp file temp-123-4.mrdb'))).toBe(true);
  });

  it('close() aborts a running BGSAVE and deletes its temp file', async () => {
    const [t, c] = await boot();
    fillDirect(t, 200_000);
    expect(await c.call('BGSAVE')).toBe('Background saving started');
    expect(temps()).toHaveLength(1);
    await stop(t, c);
    await vi.waitFor(() => expect(temps()).toEqual([]));
    expect(existsSync(dumpPath())).toBe(false);
  });
});

describe('save points and FLUSHALL', () => {
  it('a save point starts a BGSAVE on its own', async () => {
    const [t, c] = await boot({ save: '1 2', hz: '50' });
    await c.call('SET', 'a', '1');
    t.server.lastSave -= 5;
    await sleep(100);
    expect(existsSync(dumpPath())).toBe(false);
    await c.call('SET', 'b', '2');
    await vi.waitFor(() => expect(existsSync(dumpPath())).toBe(true));
    await waitForBgsave(t);
    expect(await info(c, 'rdb_changes_since_last_save')).toBe('0');
    expect(t.logs.some((l) => l.includes('2 changes in 1 seconds. Saving...'))).toBe(true);
  });

  it('FLUSHALL with save points saves the empty dataset and still propagates', async () => {
    const [t, c] = await boot();
    const records: PropagationRecord[] = [];
    t.server.propagator.attach({ append: (r) => records.push(r) });
    await c.call('SET', 'a', '1');
    await c.call('SAVE');
    await c.call('SET', 'b', '2');
    expect(await c.call('FLUSHALL')).toBe('OK');
    expect(await info(c, 'rdb_changes_since_last_save')).toBe('0');
    const loaded = readSnapshot(t.server, readFileSync(dumpPath()), { now: null });
    expect(loaded.keys).toBe(0);
    // Even with nothing to flush, FLUSHALL reaches the AOF and replicas, as in Redis.
    expect(await c.call('FLUSHALL')).toBe('OK');
    expect(records.filter((r) => r.argv[0] === 'FLUSHALL')).toHaveLength(2);
  });

  it('FLUSHALL with save points aborts a running BGSAVE, which then never lands', async () => {
    const [t, c] = await boot();
    fillDirect(t, 200_000);
    expect(await c.call('BGSAVE')).toBe('Background saving started');
    expect(await c.call('FLUSHALL')).toBe('OK');
    expect(t.server.snapshotJob).toBeNull();
    await sleep(300);
    expect(readSnapshot(t.server, readFileSync(dumpPath()), { now: null }).keys).toBe(0);
    expect(temps()).toEqual([]);
  });

  it('FLUSHALL without save points writes no file', async () => {
    const [, c] = await boot({ save: '' });
    await c.call('SET', 'a', '1');
    await c.call('FLUSHALL');
    expect(existsSync(dumpPath())).toBe(false);
  });
});

describe('BGSAVE under load', () => {
  it('100 BGSAVEs taken while 50 clients run the transfer transaction all keep A + B', async () => {
    const [t, c] = await boot({ save: '' });
    const TOTAL = 2_000_000;
    await c.call('SET', 'A', String(TOTAL / 2));
    await c.call('SET', 'B', String(TOTAL / 2));
    fillDirect(t, 30_000);
    let stop = false;
    let transfers = 0;
    const workers = await Promise.all(Array.from({ length: 50 }, () => TestClient.connect(t.port)));
    open.push(...workers);
    const loops = workers.map(async (w, i) => {
      while (!stop) {
        const n = String(1 + ((i * 7 + transfers) % 100));
        w.send('MULTI');
        w.send('DECRBY', 'A', n);
        w.send('INCRBY', 'B', n);
        w.send('EXEC');
        for (let k = 0; k < 4; k++) await w.read();
        transfers++;
      }
    });
    const scratch = new Server({ log: () => {} });
    let copied = 0;
    for (let i = 0; i < 100; i++) {
      expect(await c.call('BGSAVE')).toBe('Background saving started');
      await waitForBgsave(t);
      expect(t.server.lastBgsaveStatus).toBe('ok');
      const loaded = readSnapshot(scratch, readFileSync(dumpPath()), { now: null });
      const a = Number(loaded.dbs[0]!.peek('A')!.value);
      const b = Number(loaded.dbs[0]!.peek('B')!.value);
      expect(a + b).toBe(TOTAL);
    }
    stop = true;
    await Promise.all(loops);
    for (const line of t.logs) {
      const m = /Copy-on-write saved (\d+) of/.exec(line);
      if (m) copied += Number(m[1]);
    }
    // The hook really had to step in: transfers changed A or B mid-walk.
    expect(copied).toBeGreaterThan(0);
    expect(transfers).toBeGreaterThan(1000);
    const a = Number(await c.call('GET', 'A'));
    const b = Number(await c.call('GET', 'B'));
    expect(a + b).toBe(TOTAL);
  }, 120_000);
});
