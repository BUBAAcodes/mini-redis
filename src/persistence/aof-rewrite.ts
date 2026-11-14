/**
 * The AOF rewrite (spec 9.7): replaces a long AOF with the fewest commands that rebuild the
 * same data, in the background, while every write still reaches the old file. Also turning the
 * AOF on and off at runtime, and auto-rewrite.
 *
 * Key design choice: the rewrite is the copy-on-write engine (snapshot-job.ts) with a command
 * encoder, so the new file holds every key exactly as it was when the job started (rule 9).
 * Writes made after the start still go to the old AOF, so durability never pauses, and also
 * into a rewrite buffer, a propagation sink attached at the same moment the job starts. When
 * the walk is done and the temp file is fsynced, one synchronous step appends the buffer,
 * fsyncs, closes the old AOF, renames, fsyncs the directory and reopens the new file. No
 * record can land in between, so the new file is the snapshot plus every write since, in order.
 *
 * Turning the AOF on (CONFIG SET appendonly yes, or a start with a snapshot but no AOF) waits
 * for a rewrite before any AOF file is written: an AOF that held only the newest writes would
 * win over the snapshot at the next start and lose everything else. A stale file left by an
 * earlier run is never appended to; the swap replaces it.
 *
 * A rewrite stopped by a flush, DEBUG RELOAD or DEBUG LOADAOF schedules itself again; a failed
 * one is retried by serverCron after 5 seconds, as Redis does.
 *
 * Mirrors Redis 6's aof.c (rewriteAppendOnlyFileBackground, rewriteAppendOnlyFileRio,
 * rewriteListObject and friends, aofRewriteBufferAppend, backgroundRewriteDoneHandler,
 * startAppendOnly, stopAppendOnly, bgrewriteaofCommand) and server.c (serverCron's
 * auto-rewrite). Redis 7 swaps manifest files of a multi-part AOF instead (ADR 0009, 0012).
 */
import fs from 'node:fs';
import type { PropagationRecord, PropagationSink } from '../server/propagate.js';
import type { Server } from '../server/server.js';
import type { RObj } from '../storage/redis-object.js';
import { strerror } from '../utils/errno.js';
import { formatDouble } from '../utils/numbers.js';
import { Aof, aofPath, encodeCommand, encodeRecord } from './aof.js';
import { fsyncDirSync, tempRewritePath, writeAllSync } from './files.js';
import { BGSAVE_RETRY_MS, FileSnapshotSink, SnapshotJob } from './snapshot-job.js';
import type { SinkEncoder } from './snapshot-job.js';

/** Items per rebuilding command, as Redis's AOF_REWRITE_ITEMS_PER_CMD (pairs for HSET, ZADD). */
export const REWRITE_ITEMS_PER_CMD = 64;

/** Text collected before it becomes a Buffer: one conversion per chunk, not per command. */
const CHUNK_CHARS = 64 * 1024;

/**
 * Turns keys into commands: SET, RPUSH, SADD, HSET or ZADD with at most 64 items each, then
 * PEXPIREAT for a TTL, and SELECT whenever the db changes (hook records arrive in any order).
 */
export class AofCommandWriter implements SinkEncoder {
  private text = '';
  private out: Buffer[] = [];
  private outBytes = 0;
  private lastDb = -1;

  get pendingBytes(): number {
    return this.outBytes + this.text.length;
  }

  writeKey(db: number, key: string, obj: RObj, expireAt: number): void {
    if (db !== this.lastDb) {
      this.emit(['SELECT', String(db)]);
      this.lastDb = db;
    }
    switch (obj.type) {
      case 'string':
        this.emit(['SET', key, obj.value]);
        break;
      case 'list': {
        const batch = this.batcher('RPUSH', key);
        obj.value.forEach((item) => batch.add(item));
        batch.done();
        break;
      }
      case 'set': {
        const batch = this.batcher('SADD', key);
        obj.value.forEach((member) => batch.add(member));
        batch.done();
        break;
      }
      case 'hash': {
        const batch = this.batcher('HSET', key);
        obj.value.forEach((field, value) => batch.add(field, value));
        batch.done();
        break;
      }
      case 'zset': {
        const batch = this.batcher('ZADD', key);
        for (let n = obj.value.zsl.first; n !== null; n = n.next) {
          batch.add(formatDouble(n.score), n.member);
        }
        batch.done();
        break;
      }
      default: {
        const unknown: never = obj;
        throw new Error(`AofCommandWriter: no command for type ${(unknown as RObj).type}`);
      }
    }
    if (expireAt !== -1) this.emit(['PEXPIREAT', key, String(expireAt)]);
  }

  /** Commands need no end marker. */
  end(): void {}

  take(): Buffer[] {
    this.cut();
    const out = this.out;
    this.out = [];
    this.outBytes = 0;
    return out;
  }

  /** Collects one key's items into commands of at most 64 items (one item = 1 or 2 args). */
  private batcher(name: string, key: string) {
    let args: string[] = [];
    let items = 0;
    const flush = (): void => {
      if (items === 0) return;
      this.emit([name, key, ...args]);
      args = [];
      items = 0;
    };
    return {
      add: (...item: string[]): void => {
        args.push(...item);
        if (++items === REWRITE_ITEMS_PER_CMD) flush();
      },
      done: flush,
    };
  }

  private emit(argv: readonly string[]): void {
    this.text += encodeCommand(argv);
    if (this.text.length >= CHUNK_CHARS) this.cut();
  }

  private cut(): void {
    if (this.text.length === 0) return;
    const chunk = Buffer.from(this.text, 'latin1');
    this.text = '';
    this.out.push(chunk);
    this.outBytes += chunk.length;
  }
}

/**
 * Every write made while a rewrite runs (spec 9.7 step 3), appended to the new file at the
 * swap. It starts with no db selected, so its first record carries a SELECT.
 */
export class RewriteBuffer implements PropagationSink {
  private text = '';
  private lastDb = -1;

  append(record: PropagationRecord): void {
    // The AOF stores data, not messages (spec 9.5).
    if (record.replicasOnly) return;
    this.text += encodeRecord(record, this.lastDb);
    this.lastDb = record.db;
  }

  /** What was buffered, as bytes; the buffer is then empty. */
  take(): Buffer {
    const data = Buffer.from(this.text, 'latin1');
    this.text = '';
    return data;
  }
}

/**
 * Redis's rule (serverCron): rewrite once the file is over `minSize` and has grown by at least
 * `percentage` over its base size. A percentage of 0 turns it off; a base of 0 counts as 1.
 */
export function needsAutoRewrite(
  size: number,
  baseSize: number,
  percentage: number,
  minSize: number,
): boolean {
  if (percentage <= 0 || size <= minSize) return false;
  const base = Math.max(baseSize, 1);
  return (size * 100) / base - 100 >= percentage;
}

/**
 * Starts a rewrite job (spec 9.7 step 2). False, after logging why, if the temp file can't be
 * created. The caller checks that no job is running and that no EXEC is.
 */
export function startAofRewrite(server: Server): boolean {
  server.lastAofRewriteTry = Date.now();
  const dir = server.config.get('dir');
  const temp = tempRewritePath(dir);
  const buffer = new RewriteBuffer();
  let detach = (): void => {};
  let sink: FileSnapshotSink;
  try {
    sink = new FileSnapshotSink(temp, new AofCommandWriter(), {
      beforeClose(fd) {
        // From here to the reopen everything is synchronous: no record can slip in between.
        detach();
        writeAllSync(fd, buffer.take());
        fs.fsyncSync(fd);
      },
      commit(done) {
        swapAof(server, temp, dir);
        done(null);
      },
    });
  } catch (e) {
    server.aofLastRewriteStatus = 'err';
    server.log.warning(`Can't rewrite append only file in background: ${strerror(e)}`);
    return false;
  }
  detach = server.propagator.attach(buffer);
  new SnapshotJob(
    server,
    'rewrite',
    sink,
    (err) => {
      detach();
      rewriteDone(server, err);
    },
    {
      onAbort: () => {
        detach();
        // Stopped by a flush or a reload: start over. Not if the AOF was turned off.
        if (server.aofState !== 'off') server.aofRewriteScheduled = true;
      },
    },
  );
  server.aofRewrites++;
  server.log.notice('Background append only file rewriting started');
  return true;
}

/**
 * Spec 9.7 step 4, after the temp file got the buffer and was fsynced and closed: close the old
 * AOF, rename, fsync the directory, reopen. If the rename fails the old file is reopened, so the
 * server goes on appending to it; the error then fails the job, which deletes the temp file.
 */
function swapAof(server: Server, temp: string, dir: string): void {
  const path = aofPath(server);
  const old = server.aof;
  if (old !== null) {
    server.setAof(null);
    // Writes what it still buffers to the old file: those records are in the new one too.
    old.close();
  }
  let renamed = false;
  try {
    fs.renameSync(temp, path);
    renamed = true;
    fsyncDirSync(dir);
  } catch (e) {
    // The file at `path` is complete either way: the old one, or the new one if only the
    // directory fsync failed.
    if (old !== null || (renamed && server.aofState !== 'off')) reopen(server, path, renamed);
    throw e;
  }
  // A rewrite asked for with the AOF off (BGREWRITEAOF) only writes the file, as in Redis.
  if (server.aofState === 'off') return;
  reopen(server, path, true);
}

function reopen(server: Server, path: string, rewritten: boolean): void {
  server.setAof(new Aof(server, path));
  if (rewritten) server.aofState = 'on';
}

/** Redis's backgroundRewriteDoneHandler. */
function rewriteDone(server: Server, err: Error | null): void {
  if (err !== null) {
    server.aofLastRewriteStatus = 'err';
    server.log.warning(`Background AOF rewrite terminated with error: ${strerror(err)}`);
    // Still waiting to turn the AOF on: try again (after the 5-second pause).
    if (server.aofState === 'wait-rewrite') server.aofRewriteScheduled = true;
    return;
  }
  server.aofLastRewriteStatus = 'ok';
  server.log.notice('Background AOF rewrite terminated with success');
  server.log.notice('Background AOF rewrite finished successfully');
}

/**
 * CONFIG SET appendonly yes, and a start with a snapshot but no AOF (spec 9.9 step 2): no AOF
 * is written until a rewrite has produced one holding the whole dataset.
 */
export function startAppendOnly(server: Server): void {
  server.aofState = 'wait-rewrite';
  // A rewrite asked for while the AOF was off doesn't make the swap reopen anything: restart it.
  if (server.snapshotJob?.kind === 'rewrite') {
    server.snapshotJob.abort('the AOF was turned on');
  }
  if (server.snapshotJob !== null) {
    server.aofRewriteScheduled = true;
    server.log.notice(
      'AOF was enabled but there is already another background operation. An AOF background was scheduled to start when possible.',
    );
    return;
  }
  // Starting now, so the 5-second pause after a failure doesn't apply.
  if (startAofRewrite(server)) server.aofRewriteScheduled = false;
  else server.aofRewriteScheduled = true;
}

/** CONFIG SET appendonly no: write and fsync what's buffered, close, stop a running rewrite. */
export function stopAppendOnly(server: Server): void {
  server.aofState = 'off';
  server.aofRewriteScheduled = false;
  if (server.snapshotJob?.kind === 'rewrite') {
    server.snapshotJob.abort('the AOF was turned off');
  }
  server.closeAof();
}

/**
 * serverCron's share (spec 9.7 step 1): a rewrite that was scheduled, or one the AOF's growth
 * asks for. After a failure, wait BGSAVE_RETRY_MS before trying again, as Redis does.
 */
export function aofRewriteCron(server: Server, now: number = Date.now()): void {
  if (server.snapshotJob !== null) return;
  const mayTry =
    server.aofLastRewriteStatus === 'ok' || now - server.lastAofRewriteTry >= BGSAVE_RETRY_MS;
  if (!mayTry) return;
  if (server.aofRewriteScheduled) {
    if (startAofRewrite(server)) server.aofRewriteScheduled = false;
    return;
  }
  const aof = server.aof;
  if (server.aofState !== 'on' || aof === null) return;
  const percentage = server.config.get('auto-aof-rewrite-percentage');
  if (
    needsAutoRewrite(
      aof.size,
      aof.baseSize,
      percentage,
      server.config.get('auto-aof-rewrite-min-size'),
    )
  ) {
    const growth = Math.floor((aof.size * 100) / Math.max(aof.baseSize, 1) - 100);
    server.log.notice(`Starting automatic rewriting of AOF on ${growth}% growth`);
    startAofRewrite(server);
  }
}
