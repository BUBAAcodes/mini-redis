// Step 14: the AOF rewrite end to end (spec 9.7, 9.9, 11.1): BGREWRITEAOF and its scheduling
// with Redis 7.4's replies (checked against the reference), the swap, auto-rewrite, turning
// the AOF on and off at runtime, and rewrites staying point-in-time under load.
import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RespParser } from '../../src/protocol/parser.js';
import { createStringObject } from '../../src/storage/redis-object.js';
import { Generator } from '../differential/generator.js';
import { TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let dir: string;
const open: Array<TestServer | TestClient> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'miniredis-rewrite-it-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const thing of open.splice(0).reverse()) {
    if (thing instanceof TestClient) thing.socket.destroy();
    else await thing.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

const aofPath = () => join(dir, 'appendonly.aof');
const dumpPath = () => join(dir, 'dump.mrdb');
const temps = () => readdirSync(dir).filter((n) => n.startsWith('temp-'));

async function boot(directives: Record<string, string> = {}): Promise<[TestServer, TestClient]> {
  const t = await startServer({ dir, appendonly: 'yes', save: '', ...directives });
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

/** Enough keys that a rewrite takes many slices. Not propagated: only the rewrite sees them. */
function fillDirect(t: TestServer, n: number): void {
  const db = t.server.dbs[0]!;
  for (let i = 0; i < n; i++) db.add(`fill:${i}`, createStringObject('v'));
}

const info = async (c: TestClient, field: string): Promise<string> => {
  const text = (await c.call('INFO', 'persistence')) as string;
  return new RegExp(`\\r\\n${field}:([^\\r]*)\\r\\n`).exec(text)![1]!;
};

const waitForJob = (t: TestServer) =>
  vi.waitFor(() => expect(t.server.snapshotJob).toBeNull(), { timeout: 15_000, interval: 1 });

/** Waits until no job runs and none is scheduled. */
const waitForIdle = (t: TestServer) =>
  vi.waitFor(
    () => {
      expect(t.server.snapshotJob).toBeNull();
      expect(t.server.aofRewriteScheduled).toBe(false);
      expect(t.server.bgsaveScheduled).toBe(false);
    },
    { timeout: 15_000, interval: 5 },
  );

function aofCommands(): string[][] {
  const parser = new RespParser(
    { maxBulkLen: () => 1 << 30, authRequired: () => false },
    { multibulkOnly: true },
  );
  parser.feed(readFileSync(aofPath()));
  const out: string[][] = [];
  for (let cmd = parser.next(); cmd !== null; cmd = parser.next()) out.push(cmd.argv);
  return out;
}

describe('BGREWRITEAOF', () => {
  it('replies as Redis 7.4 does, alone, during a rewrite and during a BGSAVE', async () => {
    const [t, c] = await boot();
    await c.call('SET', 'k', 'v');
    expect(await c.raw('BGREWRITEAOF')).toBe('+Background append only file rewriting started\r\n');
    await waitForJob(t);
    expect(await c.raw('BGREWRITEAOF', 'x')).toBe(
      "-ERR wrong number of arguments for 'bgrewriteaof' command\r\n",
    );

    fillDirect(t, 200_000);
    // Pipelined, so all of them run in the turn the rewrite starts.
    c.send('BGREWRITEAOF');
    c.send('BGREWRITEAOF');
    c.send('BGSAVE');
    c.send('BGSAVE', 'SCHEDULE');
    c.send('SAVE');
    c.send('INFO', 'persistence');
    expect(await c.readRaw()).toBe('+Background append only file rewriting started\r\n');
    expect(await c.readRaw()).toBe(
      '-ERR Background append only file rewriting already in progress\r\n',
    );
    expect(await c.readRaw()).toBe(
      "-ERR Another child process is active (AOF?): can't BGSAVE right now. Use BGSAVE SCHEDULE in order to schedule a BGSAVE whenever possible.\r\n",
    );
    expect(await c.readRaw()).toBe('+Background saving scheduled\r\n');
    // SAVE runs beside an AOF rewrite, as in Redis.
    expect(await c.readRaw()).toBe('+OK\r\n');
    const text = (await c.read()) as string;
    expect(text).toContain('\r\naof_enabled:1\r\n');
    expect(text).toContain('\r\naof_rewrite_in_progress:1\r\n');
    expect(text).toContain('\r\nrdb_bgsave_in_progress:0\r\n');
    // The scheduled BGSAVE runs once the rewrite is done.
    await waitForIdle(t);
    expect(t.logs.some((l) => l.includes('Background saving terminated with success'))).toBe(true);
    expect(await info(c, 'aof_last_bgrewrite_status')).toBe('ok');
    expect(await info(c, 'aof_rewrites')).toBe('2');
  });

  it('is scheduled during a BGSAVE and inside EXEC, and runs afterwards', async () => {
    const [t, c] = await boot();
    fillDirect(t, 200_000);
    c.send('BGSAVE');
    c.send('BGREWRITEAOF');
    c.send('INFO', 'persistence');
    expect(await c.read()).toBe('Background saving started');
    expect(await c.readRaw()).toBe('+Background append only file rewriting scheduled\r\n');
    const text = (await c.read()) as string;
    expect(text).toContain('\r\naof_rewrite_scheduled:1\r\n');
    expect(text).toContain('\r\naof_rewrite_in_progress:0\r\n');
    await waitForIdle(t);
    expect(await info(c, 'aof_rewrites')).toBe('1');

    await c.call('MULTI');
    await c.call('INCR', 'n');
    await c.call('BGREWRITEAOF');
    expect(await c.call('EXEC')).toEqual([1, 'Background append only file rewriting scheduled']);
    await waitForIdle(t);
    expect(await info(c, 'aof_rewrites')).toBe('2');
  });

  it('after 100,000 INCRs leaves an AOF of a few commands, and a restart keeps the value', async () => {
    const [t, c] = await boot();
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 10_000; i++) c.send('INCR', 'counter');
      for (let i = 0; i < 10_000; i++) await c.read();
    }
    const before = statSync(aofPath()).size;
    expect(before).toBeGreaterThan(2_000_000);
    expect(await c.call('BGREWRITEAOF')).toBe('Background append only file rewriting started');
    await waitForJob(t);
    expect(aofCommands()).toEqual([
      ['SELECT', '0'],
      ['SET', 'counter', '100000'],
    ]);
    expect(Number(await info(c, 'aof_base_size'))).toBe(statSync(aofPath()).size);
    expect(temps()).toEqual([]);
    // The new file is the live AOF: later writes land in it.
    await c.call('INCR', 'counter');
    expect(aofCommands().at(-1)).toEqual(['INCR', 'counter']);
    await stop(t, c);
    const [, c2] = await boot();
    expect(await c2.call('GET', 'counter')).toBe('100001');
  });

  it('keeps every type, TTLs, binary data and every db, with writes made during the rewrite', async () => {
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
    fillDirect(t, 100_000);
    await c.call('SET', 'ttl', 'v', 'EX', '1000');
    expect(await c.call('BGREWRITEAOF')).toBe('Background append only file rewriting started');
    // Written while the rewrite walks: these reach the new file through the rewrite buffer.
    const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
    await c.call('SET', binary, binary);
    await c.call('DEL', 'fill:5');
    await c.call('SELECT', '9');
    await c.call('RPUSH', 'late', 'a', 'b');
    await c.call('SELECT', '0');
    expect(t.server.snapshotJob).not.toBeNull();
    await waitForJob(t);
    expect(await info(c, 'aof_last_bgrewrite_status')).toBe('ok');
    const digest = await c.call('DEBUG', 'DIGEST');
    expect(await c.call('DEBUG', 'LOADAOF')).toBe('OK');
    expect(await c.call('DEBUG', 'DIGEST')).toBe(digest);
    await stop(t, c);
    const [, c2] = await boot();
    expect(await c2.call('DEBUG', 'DIGEST')).toBe(digest);
    expect(await c2.call('GET', binary)).toBe(binary);
    expect(Number(await c2.call('TTL', 'ttl'))).toBeGreaterThan(990);
  });

  it('a failing rename keeps the old AOF, which goes on taking writes', async () => {
    const [t, c] = await boot();
    await c.call('SET', 'a', '1');
    const old = readFileSync(aofPath(), 'latin1');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    expect(await c.call('BGREWRITEAOF')).toBe('Background append only file rewriting started');
    await waitForJob(t);
    expect(await info(c, 'aof_last_bgrewrite_status')).toBe('err');
    expect(temps()).toEqual([]);
    expect(readFileSync(aofPath(), 'latin1')).toBe(old);
    await c.call('SET', 'b', '2');
    expect(aofCommands().at(-1)).toEqual(['SET', 'b', '2']);
    expect(t.logs.some((l) => l.includes('Background AOF rewrite terminated with error'))).toBe(
      true,
    );
  });

  it('a flush while walking aborts the rewrite, which starts again and keeps the flush', async () => {
    const [t, c] = await boot();
    await c.call('SET', 'keep', 'old');
    fillDirect(t, 200_000);
    expect(await c.call('BGREWRITEAOF')).toBe('Background append only file rewriting started');
    await c.call('FLUSHALL');
    await c.call('SET', 'after', '1');
    await waitForIdle(t);
    expect(await info(c, 'aof_rewrites')).toBe('2');
    expect(temps()).toEqual([]);
    await stop(t, c);
    const [, c2] = await boot();
    expect(await c2.call('DBSIZE')).toBe(1);
    expect(await c2.call('GET', 'after')).toBe('1');
  });
});

describe('auto-rewrite', () => {
  it('starts when the AOF has doubled over its base and passed the minimum size', async () => {
    const [t, c] = await boot({
      hz: '50',
      'auto-aof-rewrite-min-size': '64kb',
      'auto-aof-rewrite-percentage': '100',
    });
    for (let i = 0; i < 5_000; i++) c.send('SET', 'k', String(i));
    for (let i = 0; i < 5_000; i++) await c.read();
    await vi.waitFor(async () => expect(Number(await info(c, 'aof_rewrites'))).toBeGreaterThan(0), {
      timeout: 5_000,
    });
    await waitForIdle(t);
    // Cron may have started it while the SETs were still arriving: the later ones then follow
    // the rewritten key. Either way most of the history is gone, and the value is kept.
    const sets = aofCommands().filter((argv) => argv[0] === 'SET');
    expect(sets.length).toBeLessThan(5_000);
    expect(sets.at(-1)).toEqual(['SET', 'k', '4999']);
    expect(await c.call('DEBUG', 'LOADAOF')).toBe('OK');
    expect(await c.call('GET', 'k')).toBe('4999');
    const started = t.logs
      .map((l) => /Starting automatic rewriting of AOF on (\d+)% growth/.exec(l))
      .filter((m) => m !== null);
    expect(started.length).toBeGreaterThan(0);
    for (const m of started) expect(Number(m[1])).toBeGreaterThanOrEqual(100);
  });
});

describe('appendonly at runtime', () => {
  it('CONFIG SET appendonly yes writes a file that restores the whole dataset', async () => {
    // A stale AOF from an earlier life must be replaced, never loaded or appended to.
    writeFileSync(aofPath(), '*3\r\n$3\r\nSET\r\n$5\r\nstale\r\n$1\r\n1\r\n');
    const [t, c] = await boot({ appendonly: 'no' });
    const gen = new Generator(99, new Set(t.server.commands.keys()));
    for (let round = 0; round < 5; round++) {
      const batch: string[][] = [];
      for (let i = 0; i < 300; i++) batch.push(gen.next());
      batch.push(...gen.drain());
      for (const argv of batch) c.send(...argv);
      for (let i = 0; i < batch.length; i++) await c.read();
    }
    await c.call('SELECT', '0');
    fillDirect(t, 100_000);
    expect(await c.call('CONFIG', 'SET', 'appendonly', 'yes')).toBe('OK');
    expect(await info(c, 'aof_enabled')).toBe('1');
    expect(await info(c, 'aof_rewrite_in_progress')).toBe('1');
    // While the AOF is being turned on, writes wait in the rewrite buffer.
    await c.call('SET', 'during', 'x');
    await waitForJob(t);
    expect(await info(c, 'aof_last_bgrewrite_status')).toBe('ok');
    await c.call('SET', 'after', 'y');
    const digest = await c.call('DEBUG', 'DIGEST');
    await stop(t, c);
    const [, c2] = await boot();
    expect(await c2.call('DEBUG', 'DIGEST')).toBe(digest);
    expect(await c2.call('EXISTS', 'stale')).toBe(0);
    expect(await c2.call('GET', 'during')).toBe('x');
    expect(await c2.call('GET', 'after')).toBe('y');
  });

  it('CONFIG SET appendonly no stops writing the AOF and aborts a rewrite', async () => {
    const [t, c] = await boot();
    await c.call('SET', 'a', '1');
    fillDirect(t, 200_000);
    c.send('BGREWRITEAOF');
    c.send('CONFIG', 'SET', 'appendonly', 'no');
    expect(await c.read()).toBe('Background append only file rewriting started');
    expect(await c.read()).toBe('OK');
    expect(t.server.snapshotJob).toBeNull();
    expect(t.server.aof).toBeNull();
    const size = statSync(aofPath()).size;
    await c.call('SET', 'b', '2');
    expect(statSync(aofPath()).size).toBe(size);
    await vi.waitFor(() => expect(temps()).toEqual([]));
    expect(await info(c, 'aof_enabled')).toBe('0');
    expect(await info(c, 'aof_rewrite_scheduled')).toBe('0');
    // On again: a fresh rewrite holds both keys.
    expect(await c.call('CONFIG', 'SET', 'appendonly', 'yes')).toBe('OK');
    await waitForJob(t);
    // In dict order, not the order they were written.
    const keys = aofCommands()
      .filter((argv) => argv[0] === 'SET' && !argv[1]!.startsWith('fill'))
      .sort((x, y) => (x[1]! < y[1]! ? -1 : 1));
    expect(keys).toEqual([
      ['SET', 'a', '1'],
      ['SET', 'b', '2'],
    ]);
  });

  it('with no AOF but a snapshot, startup loads the snapshot and rewrites the AOF from it', async () => {
    let [t, c] = await boot({ appendonly: 'no' });
    await c.call('SET', 'a', '1');
    await c.call('RPUSH', 'l', 'x', 'y');
    await c.call('SAVE');
    await stop(t, c);
    expect(existsSync(aofPath())).toBe(false);
    [t, c] = await boot();
    expect(await c.call('GET', 'a')).toBe('1');
    await waitForJob(t);
    expect(existsSync(aofPath())).toBe(true);
    await stop(t, c);
    rmSync(dumpPath());
    [, c] = await boot();
    expect(await c.call('GET', 'a')).toBe('1');
    expect(await c.call('LRANGE', 'l', '0', '-1')).toEqual(['x', 'y']);
  });
});

describe('rewrites under load', () => {
  it('rewrites taken while 50 clients run the transfer transaction keep A + B after a restart', async () => {
    let [t, c] = await boot();
    const TOTAL = 2_000_000;
    await c.call('SET', 'A', String(TOTAL / 2));
    await c.call('SET', 'B', String(TOTAL / 2));
    for (let i = 0; i < 20_000; i++) c.send('SET', `fill:${i}`, 'v');
    for (let i = 0; i < 20_000; i++) await c.read();
    let stopLoad = false;
    let transfers = 0;
    const workers = await Promise.all(Array.from({ length: 50 }, () => TestClient.connect(t.port)));
    open.push(...workers);
    const loops = workers.map(async (w, i) => {
      while (!stopLoad) {
        const n = String(1 + ((i * 7 + transfers) % 100));
        w.send('MULTI');
        w.send('DECRBY', 'A', n);
        w.send('INCRBY', 'B', n);
        w.send('EXEC');
        for (let k = 0; k < 4; k++) await w.read();
        transfers++;
      }
    });
    for (let i = 0; i < 20; i++) {
      expect(await c.call('BGREWRITEAOF')).toBe('Background append only file rewriting started');
      await waitForJob(t);
      expect(t.server.aofLastRewriteStatus).toBe('ok');
    }
    stopLoad = true;
    await Promise.all(loops);
    for (const w of workers) {
      w.socket.destroy();
      open.splice(open.indexOf(w), 1);
    }
    expect(transfers).toBeGreaterThan(500);
    const a = await c.call('GET', 'A');
    const b = await c.call('GET', 'B');
    expect(Number(a) + Number(b)).toBe(TOTAL);
    await stop(t, c);
    [t, c] = await boot();
    expect(await c.call('GET', 'A')).toBe(a);
    expect(await c.call('GET', 'B')).toBe(b);
  }, 120_000);
});
