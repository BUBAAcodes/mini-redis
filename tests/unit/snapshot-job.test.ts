// The copy-on-write snapshot engine (spec 9.8), driven on a server that never listens: random
// changes of every kind land between the walk's slices, and the snapshot must still be the
// dataset exactly as it was when the job started.
import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { datasetDigest } from '../../src/commands/debug.js';
import { dispatch } from '../../src/commands/dispatch.js';
import { Config } from '../../src/config.js';
import { installSnapshot, readSnapshot } from '../../src/persistence/snapshot-format.js';
import {
  BGSAVE_RETRY_MS,
  MemorySnapshotSink,
  SnapshotJob,
  snapshotCron,
  startBgsave,
} from '../../src/persistence/snapshot-job.js';
import type { SnapshotSink } from '../../src/persistence/snapshot-job.js';
import { Client } from '../../src/server/client.js';
import { Server } from '../../src/server/server.js';
import { createStringObject } from '../../src/storage/redis-object.js';
import type { RObj } from '../../src/storage/redis-object.js';
import { Random } from '../../src/utils/random.js';
import { Generator } from '../differential/generator.js';

let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'miniredis-snapjob-'));
  logs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const newServer = (directives: Record<string, string> = {}, seed = 1): Server => {
  const config = Config.fromDirectives(
    Object.entries({ dir, ...directives }).map(([name, value]) => ({
      args: [name, value],
      where: 'in a test',
      line: `${name} ${value}`,
    })),
  );
  return new Server({ config, log: (line) => logs.push(line), seed });
};

/** A socketless client: the dispatcher obeys it, as it does the AOF loader's. */
const fakeClient = (server: Server) =>
  new Client(0, null, {
    maxBulkLen: () => server.config.get('proto-max-bulk-len'),
    authRequired: () => false,
  });

function run(server: Server, client: Client, argv: string[]): void {
  dispatch(server, client, argv);
  client.reply.take();
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Runs a job to its end; resolves with the error it finished with (null for success). */
function runJob(server: Server, sink: SnapshotSink, sliceMs = 0) {
  let finished: Error | null | undefined;
  const job = new SnapshotJob(server, 'bgsave', sink, (err) => (finished = err), { sliceMs });
  return {
    job,
    get finished() {
      return finished;
    },
  };
}

/** What a snapshot loads to, digested as of `now`. */
function loadedDigest(data: Buffer, now: number): string {
  const target = newServer({}, 99);
  installSnapshot(target, readSnapshot(target, data, { now }));
  target.cmdTime = now;
  return datasetDigest(target);
}

describe('the copy-on-write engine', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'saves the dataset as it was at the start while random writes land mid-walk (seed %i)',
    async (seed) => {
      const server = newServer({}, seed);
      const client = fakeClient(server);
      const registered = new Set(server.commands.keys());
      // A flush aborts the job by design; it has its own test.
      registered.delete('flushdb');
      registered.delete('flushall');
      const gen = new Generator(seed, registered);
      for (let i = 0; i < 3000; i++) run(server, client, gen.next());
      for (const argv of gen.drain()) run(server, client, argv);
      // Keys that expire while the walk runs, found lazily or by the active cycle.
      for (let i = 0; i < 50; i++) run(server, client, ['SET', `short:${i}`, 'v', 'PX', '15']);
      const rng = new Random(seed);
      for (let i = 0; i < 2000; i++) {
        run(server, client, ['SELECT', String(rng.int(3))]);
        run(server, client, ['SET', `filler:${i}`, `v${i}`]);
      }

      const t0 = Date.now();
      server.cmdTime = t0;
      const before = datasetDigest(server);
      const keysAtStart = server.dbs.reduce((n, db) => n + db.size, 0);
      const sink = new MemorySnapshotSink([]);
      const handle = runJob(server, sink);
      let rounds = 0;
      while (handle.finished === undefined) {
        await tick();
        if (handle.finished !== undefined) break;
        for (let i = 0; i < 5; i++) run(server, client, gen.next());
        for (const argv of gen.drain()) run(server, client, argv);
        run(server, client, ['GET', `short:${rng.int(50)}`]);
        if (rounds++ % 10 === 0) server.dbs[0]!.activeExpireSample(20, Date.now());
      }
      expect(handle.finished).toBeNull();
      expect(server.snapshotJob).toBeNull();
      // A key saved twice would fail the load as a duplicate; one missed would change the digest.
      expect(loadedDigest(sink.result(), t0)).toBe(before);
      expect(handle.job.keysWritten).toBe(keysAtStart);
      expect(handle.job.savedByHook).toBeGreaterThan(0);
      expect(rounds).toBeGreaterThan(50);
    },
  );

  it('leaves out keys born during the walk and keeps keys deleted during it', async () => {
    const server = newServer();
    const db = server.dbs[0]!;
    for (let i = 0; i < 500; i++) db.add(`k${i}`, createStringObject(`v${i}`));
    const sink = new MemorySnapshotSink([]);
    const handle = runJob(server, sink);
    await tick();
    for (let i = 0; i < 500; i++) db.delete(`k${i}`);
    db.add('born', createStringObject('late'));
    db.setKey('k0', createStringObject('replaced'));
    while (handle.finished === undefined) await tick();
    const loaded = readSnapshot(newServer(), sink.result(), { now: null });
    expect(loaded.dbs[0]!.size).toBe(500);
    expect(loaded.dbs[0]!.hasEntry('born')).toBe(false);
    expect(loaded.dbs[0]!.peek('k0')!.value).toBe('v0');
    expect(handle.job.savedByHook).toBeGreaterThan(400);
  });

  it('saves a key and its TTL as they were before a rename, an expire or a persist', async () => {
    const server = newServer();
    const db = server.dbs[0]!;
    for (let i = 0; i < 200; i++) db.add(`pad${i}`, createStringObject('x'));
    db.add('from', createStringObject('f'));
    db.setExpire('from', Date.now() + 100_000);
    db.add('to', createStringObject('t'));
    db.add('ttl', createStringObject('v'));
    db.add('persist', createStringObject('p'));
    db.setExpire('persist', Date.now() + 200_000);
    const before = datasetDigest(server);
    const sink = new MemorySnapshotSink([]);
    const handle = runJob(server, sink);
    db.rename('from', 'to');
    db.setExpire('ttl', Date.now() + 5000);
    db.removeExpire('persist');
    while (handle.finished === undefined) await tick();
    expect(loadedDigest(sink.result(), server.cmdTime)).toBe(before);
  });

  it('pauses the walk while the sink is backlogged', async () => {
    const server = newServer();
    for (let i = 0; i < 100; i++) server.dbs[0]!.add(`k${i}`, createStringObject('v'));
    let writes = 0;
    let backlogged = true;
    const sink: SnapshotSink = {
      write: () => void writes++,
      flush: () => {},
      get backlogged() {
        return backlogged;
      },
      error: null,
      end: (done) => done(null),
      abort: () => {},
    };
    const handle = runJob(server, sink);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes).toBe(0);
    backlogged = false;
    await vi.waitFor(() => expect(handle.finished).toBeNull());
    expect(writes).toBe(100);
  });

  it('is aborted by a flush while walking, and the hook stops at once', async () => {
    const server = newServer();
    const db = server.dbs[0]!;
    for (let i = 0; i < 300; i++) db.add(`k${i}`, createStringObject('v'));
    const writes: string[] = [];
    let aborted = false;
    const sink: SnapshotSink = {
      write: (_db, key) => void writes.push(key),
      flush: () => {},
      backlogged: false,
      error: null,
      end: (done) => done(null),
      abort: () => void (aborted = true),
    };
    const handle = runJob(server, sink);
    await tick();
    db.flush();
    expect(aborted).toBe(true);
    expect(server.snapshotJob).toBeNull();
    const count = writes.length;
    db.add('after', createStringObject('v'));
    db.delete('after');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes.length).toBe(count);
    expect(handle.finished).toBeUndefined();
    expect(logs.some((l) => l.includes('Background saving aborted: the dataset was flushed'))).toBe(
      true,
    );
  });

  it('refuses a second job while one runs', () => {
    const server = newServer();
    runJob(server, new MemorySnapshotSink([]));
    expect(() => runJob(server, new MemorySnapshotSink([]))).toThrow(/another job/);
  });

  it('a sink error fails the job', async () => {
    const server = newServer();
    for (let i = 0; i < 300; i++) server.dbs[0]!.add(`k${i}`, createStringObject('v'));
    const failure = new Error('disk on fire');
    let error: Error | null = null;
    let aborted = false;
    const sink: SnapshotSink = {
      write: () => {},
      flush: () => {},
      backlogged: false,
      get error() {
        return error;
      },
      end: (done) => done(null),
      abort: () => void (aborted = true),
    };
    const handle = runJob(server, sink);
    await tick();
    error = failure;
    await vi.waitFor(() => expect(handle.finished).toBe(failure));
    expect(aborted).toBe(true);
    expect(server.snapshotJob).toBeNull();
  });
});

describe('BGSAVE to a file', () => {
  const dump = () => join(dir, 'dump.mrdb');
  const temps = () => fs.readdirSync(dir).filter((n) => n.startsWith('temp-'));

  it('writes dump.mrdb through a temp file, and subtracts only the changes it saved', async () => {
    const server = newServer();
    const db = server.dbs[0]!;
    for (let i = 0; i < 5; i++) {
      db.add(`k${i}`, createStringObject('v'));
      db.signalModifiedKey(`k${i}`);
    }
    expect(startBgsave(server)).toBe(true);
    expect(temps()).toHaveLength(1);
    db.add('during', createStringObject('v'));
    db.signalModifiedKey('during');
    await vi.waitFor(() => expect(server.snapshotJob).toBeNull());
    expect(temps()).toHaveLength(0);
    expect(server.dirty).toBe(1);
    expect(server.lastBgsaveStatus).toBe('ok');
    const loaded = readSnapshot(newServer(), readFileSync(dump()), { now: null });
    expect(loaded.keys).toBe(5);
    expect(logs.some((l) => l.includes('Background saving terminated with success'))).toBe(true);
  });

  it('a failing write fails the save, deletes the temp file and keeps the old dump', async () => {
    const server = newServer();
    writeFileSync(dump(), 'old');
    for (let i = 0; i < 100; i++) server.dbs[0]!.add(`k${i}`, createStringObject('v'));
    vi.spyOn(fs, 'writev').mockImplementation(((
      _fd: number,
      _buffers: unknown,
      cb: (err: NodeJS.ErrnoException | null, n: number) => void,
    ) => {
      setImmediate(() => cb(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }), 0));
    }) as unknown as typeof fs.writev);
    startBgsave(server);
    await vi.waitFor(() => expect(server.snapshotJob).toBeNull());
    expect(server.lastBgsaveStatus).toBe('err');
    expect(readFileSync(dump(), 'latin1')).toBe('old');
    expect(temps()).toHaveLength(0);
    expect(logs.some((l) => l.includes('Background saving error: No space left on device'))).toBe(
      true,
    );
  });

  it('a failing rename keeps the old dump', async () => {
    const server = newServer();
    writeFileSync(dump(), 'old');
    server.dbs[0]!.add('k', createStringObject('v'));
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    startBgsave(server);
    await vi.waitFor(() => expect(server.snapshotJob).toBeNull());
    expect(server.lastBgsaveStatus).toBe('err');
    expect(readFileSync(dump(), 'latin1')).toBe('old');
    expect(temps()).toHaveLength(0);
  });

  it('an abort deletes the temp file, even with a write in flight, and never renames', async () => {
    const server = newServer();
    const big = 'x'.repeat(1 << 20);
    for (let i = 0; i < 20; i++) server.dbs[0]!.add(`k${i}`, createStringObject(big));
    const rename = vi.spyOn(fs, 'renameSync');
    startBgsave(server);
    await tick();
    await tick();
    server.snapshotJob!.abort('test');
    await vi.waitFor(() => expect(temps()).toHaveLength(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rename).not.toHaveBeenCalled();
    expect(existsSync(dump())).toBe(false);
    expect(server.lastBgsaveStatus).toBe('ok');
  });

  it('save points start a BGSAVE, and wait 5 seconds after a failure', () => {
    const server = newServer({ save: '10 2' });
    const now = Date.now();
    server.lastSave = Math.floor(now / 1000) - 11;
    server.dirty = 1;
    snapshotCron(server, now);
    expect(server.snapshotJob).toBeNull();
    server.dirty = 2;
    server.lastSave = Math.floor(now / 1000) - 5;
    snapshotCron(server, now);
    expect(server.snapshotJob).toBeNull();
    server.lastSave = Math.floor(now / 1000) - 10;
    server.lastBgsaveStatus = 'err';
    server.lastBgsaveTry = now - BGSAVE_RETRY_MS + 100;
    snapshotCron(server, now);
    expect(server.snapshotJob).toBeNull();
    snapshotCron(server, now + 100);
    expect(server.snapshotJob).not.toBeNull();
    expect(logs.some((l) => l.includes('2 changes in 10 seconds. Saving...'))).toBe(true);
    server.snapshotJob!.abort('test');
  });

  it('a scheduled BGSAVE starts from serverCron', () => {
    const server = newServer({ save: '' });
    server.bgsaveScheduled = true;
    snapshotCron(server);
    expect(server.snapshotJob?.kind).toBe('bgsave');
    expect(server.bgsaveScheduled).toBe(false);
    server.snapshotJob!.abort('test');
  });
});

describe('the Db hook', () => {
  it('fires once per object, and not for objects created during the walk', () => {
    const server = newServer();
    const db = server.dbs[0]!;
    db.add('a', createStringObject('1'));
    const saved: Array<[string, RObj]> = [];
    const sink: SnapshotSink = {
      write: (_db, key, obj) => void saved.push([key, obj]),
      flush: () => {},
      backlogged: false,
      error: null,
      end: (done) => done(null),
      abort: () => {},
    };
    runJob(server, sink);
    db.lookupWrite('a');
    db.lookupWrite('a');
    db.setKey('b', createStringObject('2'));
    db.lookupWrite('b');
    db.delete('b');
    expect(saved.map(([k]) => k)).toEqual(['a']);
    server.snapshotJob!.abort('test');
  });
});
