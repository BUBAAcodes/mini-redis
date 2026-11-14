/**
 * The copy-on-write snapshot engine (spec 9.8, ADR 0010): one job at a time walks the keyspace
 * in small time slices while clients keep writing, and still produces the dataset exactly as it
 * was when the job started (rule 9). BGSAVE and save points drive it here; the AOF rewrite
 * (step 14) and a replica's full sync (step 20) plug in their own sinks.
 *
 * Key design choice: Node can't fork(), so the point-in-time copy is made in code. Each job has
 * an epoch. Db calls `save()` before it changes or removes a key, and a key whose object isn't
 * stamped with the epoch yet is written out right then, old value and old TTL, and stamped.
 * Objects inserted during the job are stamped at once, so they're never written. The walk
 * visits every db with a SCAN cursor, writing whatever isn't stamped. SCAN returns every key
 * that exists for the whole walk; every other key was saved by the hook before it changed or
 * went. So every key is written exactly once, with its starting value, while rehashing and
 * resizing carry on underneath.
 *
 * A slice runs for at most 2 ms from setImmediate, so a BGSAVE of millions of keys never holds
 * the event loop for long (rule 10). The file sink writes on libuv's thread pool; its callbacks
 * only move its own bytes and flags, never the keyspace (rule 1). Its rename runs on this
 * thread, after checking the job wasn't aborted, so nothing that runs later (a SAVE, a
 * FLUSHALL's save) can be overtaken by an old job's file.
 *
 * Mirrors Redis rdb.c (rdbSaveBackground, bgsaveCommand, saveCommand, backgroundSaveDoneHandler,
 * killRDBChild), server.c (serverCron's save points) and, for what fork() does for free,
 * the kernel's copy-on-write.
 */
import fs from 'node:fs';
import { dirname } from 'node:path';
import type { Server } from '../server/server.js';
import type { Db } from '../storage/database.js';
import type { RObj } from '../storage/redis-object.js';
import { strerror } from '../utils/errno.js';
import { fsyncDir, tempSnapshotPath, unlinkQuiet } from './files.js';
import { SnapshotWriter, snapshotAux, snapshotPath } from './snapshot-format.js';

/** Longest a slice may run (spec 9.8). */
const SLICE_MS = 2;
/** Output a file sink may have waiting before the walk pauses for it (spec 9.8). */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
/** How soon a paused walk looks again. */
const BACKLOG_RETRY_MS = 1;
/** After a failed BGSAVE, save points wait this long before trying again (spec 9.8). */
export const BGSAVE_RETRY_MS = 5000;

/** Where a job's keys go: a file, a command file (step 14), or memory (step 20). */
export interface SnapshotSink {
  /** One key as it was when the job started; `expireAt` is -1 for none. */
  write(db: number, key: string, obj: RObj, expireAt: number): void;
  /** After each slice: let buffered output move on (a file sink starts a write). */
  flush(): void;
  /** True while too much output waits: the walk pauses until it drains. */
  readonly backlogged: boolean;
  /** Set when the output failed; the job then fails. */
  readonly error: Error | null;
  /** The walk is over: write the end, finish the output, then call `done`. */
  end(done: (err: Error | null) => void): void;
  /** Throw the output away (a temp file is deleted). */
  abort(): void;
}

export type SnapshotJobKind = 'bgsave' | 'rewrite' | 'fullsync';

const KIND_LABEL: Record<SnapshotJobKind, string> = {
  bgsave: 'Background saving',
  rewrite: 'Background append only file rewriting',
  fullsync: 'Replica full sync',
};

export interface SnapshotJobOptions {
  /** Slice length in ms; tests use 0 for one bucket per slice. */
  sliceMs?: number;
}

type State = 'walking' | 'finishing' | 'done' | 'aborted';

export class SnapshotJob {
  readonly epoch: number;
  readonly startedAt = Date.now();
  /** `server.dirty` at the start: a BGSAVE that succeeds saved these changes (spec 9.8). */
  readonly dirtyAtStart: number;
  /** Keys written so far, by the walk and by the hook. */
  keysWritten = 0;
  /** Of those, keys the hook saved just before they changed. */
  savedByHook = 0;

  private state: State = 'walking';
  private dbIndex = 0;
  private cursor = 0;
  private cancel: (() => void) | null = null;
  private readonly sliceMs: number;
  /** The scan callback, made once: writes every unstamped key of `walkDb`. */
  private walkDb: Db | null = null;
  private readonly visit = (key: string, obj: RObj): void => {
    if (obj.savedEpoch === this.epoch) return;
    const db = this.walkDb!;
    this.sink.write(db.id, key, obj, db.getExpire(key));
    obj.savedEpoch = this.epoch;
    this.keysWritten++;
  };

  /**
   * Starts a job (spec 9.8, Lifecycle step 1) and makes it the server's one running job.
   * `onDone` gets null once the sink has finished, or the error that stopped it; it isn't
   * called after abort().
   */
  constructor(
    private readonly server: Server,
    readonly kind: SnapshotJobKind,
    readonly sink: SnapshotSink,
    private readonly onDone: (err: Error | null, job: SnapshotJob) => void,
    options: SnapshotJobOptions = {},
  ) {
    if (server.snapshotJob !== null) throw new Error('SnapshotJob: another job is running');
    this.epoch = ++server.snapshotEpoch;
    this.dirtyAtStart = server.dirty;
    this.sliceMs = options.sliceMs ?? SLICE_MS;
    server.snapshotJob = this;
    this.schedule(false);
  }

  /** Still walking: the hook and the stamping apply. Afterwards every key is already saved. */
  get walking(): boolean {
    return this.state === 'walking';
  }

  /** The hook (spec 9.8): Db calls it before it changes or removes `obj`, stored under `key`. */
  save(db: Db, key: string, obj: RObj): void {
    if (this.state !== 'walking' || obj.savedEpoch === this.epoch) return;
    this.sink.write(db.id, key, obj, db.getExpire(key));
    obj.savedEpoch = this.epoch;
    this.keysWritten++;
    this.savedByHook++;
  }

  /** Db.add and Db.setKey: an object born during the walk isn't part of this snapshot. */
  stamp(obj: RObj): void {
    if (this.state === 'walking') obj.savedEpoch = this.epoch;
  }

  /**
   * Stops the job and throws its output away (spec 9.8, Lifecycle step 4): FLUSHDB, FLUSHALL,
   * DEBUG RELOAD, shutdown. Like Redis's killRDBChild, it isn't a failure: the last save's
   * status stays as it was.
   */
  abort(reason: string): void {
    if (this.state === 'done' || this.state === 'aborted') return;
    this.state = 'aborted';
    this.cancel?.();
    this.cancel = null;
    this.sink.abort();
    this.release();
    this.server.log.notice(`${KIND_LABEL[this.kind]} aborted: ${reason}`);
  }

  /** One slice: walk until the time is up, the sink is backlogged, or every db is done. */
  private slice(): void {
    this.cancel = null;
    if (this.state !== 'walking') return;
    if (this.sink.error !== null) {
      this.fail(this.sink.error);
      return;
    }
    if (this.sink.backlogged) {
      this.sink.flush();
      this.schedule(true);
      return;
    }
    const deadline = performance.now() + this.sliceMs;
    const dbs = this.server.dbs;
    while (this.dbIndex < dbs.length) {
      const db = dbs[this.dbIndex]!;
      this.walkDb = db;
      this.cursor = db.scanStep(this.cursor, this.visit);
      if (this.cursor === 0) this.dbIndex++;
      if (performance.now() >= deadline || this.sink.backlogged) break;
    }
    this.walkDb = null;
    this.sink.flush();
    if (this.dbIndex < dbs.length) {
      this.schedule(false);
      return;
    }
    // Lifecycle step 3: every key is written; the sink finishes its output.
    this.state = 'finishing';
    this.sink.end((err) => {
      if (this.state !== 'finishing') return;
      this.state = 'done';
      this.release();
      this.onDone(err, this);
    });
  }

  private schedule(backlogged: boolean): void {
    if (backlogged) {
      const t = setTimeout(() => this.slice(), BACKLOG_RETRY_MS);
      this.cancel = () => clearTimeout(t);
    } else {
      const t = setImmediate(() => this.slice());
      this.cancel = () => clearImmediate(t);
    }
  }

  private fail(err: Error): void {
    this.state = 'aborted';
    this.sink.abort();
    this.release();
    this.onDone(err, this);
  }

  private release(): void {
    if (this.server.snapshotJob === this) this.server.snapshotJob = null;
  }
}

/** The bytes after the first `n` of `buffers`. */
function skipBytes(buffers: readonly Buffer[], n: number): Buffer[] {
  let i = 0;
  while (i < buffers.length && n >= buffers[i]!.length) n -= buffers[i++]!.length;
  if (i === buffers.length) return [];
  return [buffers[i]!.subarray(n), ...buffers.slice(i + 1)];
}

/**
 * BGSAVE's sink: the binary format into `temp-<pid>-<n>.mrdb`, written asynchronously, then
 * fsync → rename over `dump.mrdb` → fsync the directory (rule 8).
 */
export class FileSnapshotSink implements SnapshotSink {
  error: Error | null = null;
  private readonly writer: SnapshotWriter;
  private readonly fd: number;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  /** A write or the final fsync is on the thread pool: the descriptor must stay open. */
  private busy = false;
  private closed = false;
  private aborted = false;
  private ending: ((err: Error | null) => void) | null = null;

  /** Throws if the temp file can't be created. */
  constructor(
    readonly tempPath: string,
    readonly path: string,
    aux: ReadonlyArray<readonly [string, string]>,
  ) {
    this.fd = fs.openSync(tempPath, 'w');
    this.writer = new SnapshotWriter(aux);
  }

  get backlogged(): boolean {
    return this.queuedBytes + this.writer.pendingBytes > MAX_PENDING_BYTES;
  }

  write(db: number, key: string, obj: RObj, expireAt: number): void {
    this.writer.writeKey(db, key, obj, expireAt);
  }

  flush(): void {
    for (const chunk of this.writer.take()) {
      this.queue.push(chunk);
      this.queuedBytes += chunk.length;
    }
    this.pump();
  }

  end(done: (err: Error | null) => void): void {
    this.writer.end();
    this.ending = done;
    if (this.error !== null) {
      done(this.error);
      return;
    }
    this.flush();
  }

  abort(): void {
    this.aborted = true;
    // With an operation in flight, its callback cleans up; closing now could hand the
    // descriptor's number to another file while the thread pool still writes to it.
    if (!this.busy) this.cleanup();
  }

  private pump(): void {
    if (this.busy || this.aborted || this.error !== null) return;
    if (this.queue.length === 0) {
      if (this.ending !== null) this.finish();
      return;
    }
    const buffers = this.queue;
    this.queue = [];
    this.busy = true;
    fs.writev(this.fd, buffers, (err, written) => {
      this.busy = false;
      if (this.aborted) {
        this.cleanup();
        return;
      }
      if (err) {
        this.failed(err);
        return;
      }
      this.queuedBytes -= written;
      // A short write leaves the rest at the front of the queue.
      this.queue = [...skipBytes(buffers, written), ...this.queue];
      this.pump();
    });
  }

  private finish(): void {
    this.busy = true;
    fs.fsync(this.fd, (err) => {
      this.busy = false;
      if (this.aborted) {
        this.cleanup();
        return;
      }
      if (err) {
        this.failed(err);
        return;
      }
      try {
        fs.closeSync(this.fd);
        this.closed = true;
        fs.renameSync(this.tempPath, this.path);
      } catch (e) {
        this.failed(e as Error);
        return;
      }
      fsyncDir(dirname(this.path), (dirErr) => this.ending!(dirErr));
    });
  }

  private failed(err: Error): void {
    this.error = err;
    this.cleanup();
    this.ending?.(err);
  }

  private cleanup(): void {
    if (!this.closed) {
      this.closed = true;
      try {
        fs.closeSync(this.fd);
      } catch {
        // Already unusable; the temp file goes anyway.
      }
    }
    unlinkQuiet(this.tempPath);
  }
}

/** The binary format into memory: tests now, a replica's full sync in step 20. */
export class MemorySnapshotSink implements SnapshotSink {
  readonly error = null;
  readonly backlogged = false;
  private readonly writer: SnapshotWriter;
  private chunks: Buffer[] = [];

  constructor(aux: ReadonlyArray<readonly [string, string]>) {
    this.writer = new SnapshotWriter(aux);
  }

  write(db: number, key: string, obj: RObj, expireAt: number): void {
    this.writer.writeKey(db, key, obj, expireAt);
  }

  flush(): void {
    for (const chunk of this.writer.take()) this.chunks.push(chunk);
  }

  end(done: (err: Error | null) => void): void {
    this.writer.end();
    this.flush();
    done(null);
  }

  abort(): void {
    this.chunks = [];
  }

  /** The whole snapshot, once end() has run. */
  result(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * BGSAVE (Redis's rdbSaveBackground): starts a job writing `dump.mrdb`. False, after logging
 * why, if the temp file can't even be created. The caller checks that no job is running.
 */
export function startBgsave(server: Server): boolean {
  server.lastBgsaveTry = Date.now();
  const temp = tempSnapshotPath(server.config.get('dir'), ++server.snapshotSeq);
  let sink: FileSnapshotSink;
  try {
    sink = new FileSnapshotSink(temp, snapshotPath(server), snapshotAux());
  } catch (e) {
    server.lastBgsaveStatus = 'err';
    server.log.warning(`Can't save in background: ${strerror(e)}`);
    return false;
  }
  new SnapshotJob(server, 'bgsave', sink, (err, job) => bgsaveDone(server, err, job));
  server.log.notice('Background saving started');
  return true;
}

/** Redis's backgroundSaveDoneHandler. Only server counters change here, never the keyspace. */
function bgsaveDone(server: Server, err: Error | null, job: SnapshotJob): void {
  if (err !== null) {
    server.lastBgsaveStatus = 'err';
    server.log.warning(`Background saving error: ${strerror(err)}`);
    return;
  }
  // Changes made while the job ran aren't in the file: only the ones before it count as saved.
  server.dirty = Math.max(0, server.dirty - job.dirtyAtStart);
  server.lastSave = Math.floor(Date.now() / 1000);
  server.lastBgsaveStatus = 'ok';
  server.log.notice('DB saved on disk');
  // What fork()'s CoW report is to Redis: how much the hook had to copy.
  server.log.notice(`Copy-on-write saved ${job.savedByHook} of ${job.keysWritten} keys`);
  server.log.notice('Background saving terminated with success');
}

/**
 * serverCron's share (spec 9.8, Save points): a BGSAVE that was scheduled, or one that a save
 * point asks for. After a failure, wait BGSAVE_RETRY_MS before trying again.
 */
export function snapshotCron(server: Server, now: number = Date.now()): void {
  if (server.snapshotJob !== null) return;
  const mayTry = server.lastBgsaveStatus === 'ok' || now - server.lastBgsaveTry >= BGSAVE_RETRY_MS;
  if (!mayTry) return;
  if (server.bgsaveScheduled) {
    if (startBgsave(server)) server.bgsaveScheduled = false;
    return;
  }
  const elapsed = now / 1000 - server.lastSave;
  for (const { seconds, changes } of server.config.get('save')) {
    if (server.dirty >= changes && elapsed >= seconds) {
      server.log.notice(`${changes} changes in ${seconds} seconds. Saving...`);
      startBgsave(server);
      return;
    }
  }
}
