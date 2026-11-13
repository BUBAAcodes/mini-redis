/**
 * The append-only file (spec 9.6, 11.1): the propagation sink that writes every change to disk
 * before its reply goes out (rule 8), and the loader that replays it at startup and for
 * DEBUG LOADAOF.
 *
 * Key design choice: the sink only buffers. propagate() appends each record, encoded as RESP
 * and preceded by SELECT when the db changes. Once per event-loop turn, beforeSleep hands the
 * whole buffer to the OS in one writeSync, before any reply is written. Under `always` one
 * fsyncSync follows, so every command of the turn shares one fsync (group commit). Under
 * `everysec`, serverCron starts an async fs.fsync on libuv's thread pool, as Redis hands it to
 * a bio thread. Its callback only updates this object's flags, never the keyspace (rule 1).
 *
 * A failed write keeps its buffer, so nothing is lost, and is retried every turn and every cron
 * tick. Until a write succeeds, the dispatcher answers writes with -MISCONF. A short write is
 * cut back with ftruncate, so the file never ends in half a command that the next startup
 * would have to throw away. Under `always` a failed write or fsync is fatal: the promise that
 * every acknowledged write is on disk can no longer be kept.
 *
 * Loading streams the file through the request parser in multibulk-only mode and runs each
 * command on a socketless client, with propagation paused and expiry off, through the normal
 * dispatcher, so MULTI … EXEC replays atomically through the same code that wrote it. A tail
 * cut off mid-command, or a MULTI with no EXEC, is truncated away (`aof-load-truncated yes`).
 * Anything else malformed stops the load at its byte offset rather than guessing.
 *
 * Imported as `fs` (the module object) so tests can spy on writeSync and fsyncSync.
 *
 * Mirrors Redis aof.c (feedAppendOnlyFile, catAppendOnlyGenericCommand, flushAppendOnlyFile,
 * loadSingleAppendOnlyFile, createAOFClient) and debug.c (DEBUG LOADAOF).
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { arityOk, lookupSubcommand } from '../commands/command.js';
import { discardTransaction, dispatch } from '../commands/dispatch.js';
import { ProtocolError } from '../protocol/errors.js';
import { RespParser } from '../protocol/parser.js';
import { Client } from '../server/client.js';
import type { PropagationRecord, PropagationSink } from '../server/propagate.js';
import type { Server } from '../server/server.js';
import { strerror } from '../utils/errno.js';

/** How often a failing write is logged while it keeps failing (Redis's AOF_WRITE_LOG_ERROR_RATE). */
const ERROR_LOG_EVERY_MS = 30_000;
/** Bytes read per chunk while loading. */
const LOAD_CHUNK = 1024 * 1024;

/** One command as a RESP array of bulk strings: the AOF's only record format (spec 11.1). */
export function encodeCommand(argv: readonly string[]): string {
  let out = `*${argv.length}\r\n`;
  for (const arg of argv) out += `$${arg.length}\r\n${arg}\r\n`;
  return out;
}

/** Where the AOF lives: `dir/appendfilename`. */
export const aofPath = (server: Server): string =>
  join(server.config.get('dir'), server.config.get('appendfilename'));

export class Aof implements PropagationSink {
  /** Bytes in the file, as far as this process has written them. */
  size: number;
  private readonly fd: number;
  /** Records waiting for the next flush, as latin1 bytes. */
  private buf = '';
  /** The db the file's last record ran in; -1 makes the next record carry a SELECT. */
  private lastDb = -1;
  private fsyncedSize: number;
  private lastFsync = 0;
  private inFlight = false;
  private writeError: string | null = null;
  private fsyncError: string | null = null;
  private lastErrorLog = -Infinity;
  private closed = false;

  /** Opens (or creates) the file for appending. */
  constructor(
    private readonly server: Server,
    readonly path: string,
  ) {
    this.fd = fs.openSync(path, 'a');
    this.size = fs.fstatSync(this.fd).size;
    this.fsyncedSize = this.size;
  }

  /** Why writes must be refused (the -MISCONF reason), or null when the AOF is healthy. */
  get error(): string | null {
    return this.writeError ?? this.fsyncError;
  }

  get fsyncInFlight(): boolean {
    return this.inFlight;
  }

  get pendingBytes(): number {
    return this.buf.length;
  }

  append(record: PropagationRecord): void {
    // PUBLISH goes to replicas only: the AOF stores data, not messages (spec 9.5).
    if (record.replicasOnly) return;
    if (record.db !== this.lastDb) {
      this.buf += encodeCommand(['SELECT', String(record.db)]);
      this.lastDb = record.db;
    }
    this.buf += encodeCommand(record.argv);
  }

  /** beforeSleep: hands the buffer to the OS, then fsyncs it under `always`, before any reply. */
  flush(): void {
    if (this.closed || this.buf.length === 0) return;
    const data = Buffer.from(this.buf, 'latin1');
    let written = 0;
    try {
      while (written < data.length) written += fs.writeSync(this.fd, data, written);
    } catch (e) {
      this.writeFailed(e, written, data.length);
      return;
    }
    this.buf = '';
    this.size += data.length;
    if (this.writeError !== null) {
      this.server.log.warning('AOF write error looks solved, MiniRedis can write again.');
      this.writeError = null;
      this.lastErrorLog = -Infinity;
    }
    if (this.server.config.get('appendfsync') === 'always') {
      try {
        fs.fsyncSync(this.fd);
      } catch (e) {
        this.server.fatal(
          `Can't persist AOF for fsync error when the AOF fsync policy is 'always': ${strerror(e)}. Exiting...`,
        );
        return;
      }
      this.fsyncedSize = this.size;
      this.lastFsync = Date.now();
    }
  }

  /**
   * serverCron: retries a failed write even when no command comes to trigger one, and starts
   * the `everysec` background fsync once a second has passed since the last one.
   */
  cron(now: number = Date.now()): void {
    if (this.closed) return;
    if (this.writeError !== null) this.flush();
    if (
      this.server.config.get('appendfsync') === 'everysec' &&
      !this.inFlight &&
      this.size > this.fsyncedSize &&
      now - this.lastFsync >= 1000
    ) {
      this.backgroundFsync(now);
    }
  }

  /**
   * The file was truncated under us (DEBUG LOADAOF dropping a cut-off tail): re-read its size,
   * and make the next record carry a SELECT, since the record that set the db may be gone.
   */
  afterTruncate(): void {
    this.size = fs.fstatSync(this.fd).size;
    this.fsyncedSize = Math.min(this.fsyncedSize, this.size);
    this.lastDb = -1;
  }

  /**
   * Shutdown (spec 9.14 step 2): write what's buffered, fsync whatever the policy, close. A
   * background fsync still running just finds the descriptor gone; its result is ignored.
   */
  close(): void {
    if (this.closed) return;
    this.flush();
    try {
      fs.fsyncSync(this.fd);
    } catch (e) {
      this.server.log.warning(`Error fsyncing the AOF file at shutdown: ${strerror(e)}`);
    }
    this.closed = true;
    fs.closeSync(this.fd);
  }

  private writeFailed(e: unknown, written: number, expected: number): void {
    const reason = strerror(e);
    const log = this.server.log;
    const now = Date.now();
    const shouldLog = now - this.lastErrorLog >= ERROR_LOG_EVERY_MS;
    if (written > 0) {
      if (shouldLog) {
        log.warning(
          `Short write while writing to the AOF file: (nwritten=${written}, expected=${expected})`,
        );
      }
      try {
        fs.ftruncateSync(this.fd, this.size);
      } catch (te) {
        log.warning(
          `Could not remove short write from the append-only file. MiniRedis may refuse to ` +
            `load the AOF the next time it starts. ftruncate: ${strerror(te)}`,
        );
        // The prefix stays in the file: count it, and keep only the rest, so nothing is
        // written twice.
        this.size += written;
        this.buf = this.buf.slice(written);
      }
    } else if (shouldLog) {
      log.warning(`Error writing to the AOF file: ${reason}`);
    }
    if (shouldLog) this.lastErrorLog = now;
    this.writeError = reason;
    if (this.server.config.get('appendfsync') === 'always') {
      this.server.fatal(
        "Can't recover from AOF write error when the AOF fsync policy is 'always'. Exiting...",
      );
    }
  }

  private backgroundFsync(now: number): void {
    this.inFlight = true;
    this.lastFsync = now;
    const target = this.size;
    fs.fsync(this.fd, (err) => {
      this.inFlight = false;
      if (this.closed) return;
      if (err) {
        this.server.log.warning(`Fail to fsync the AOF file: ${strerror(err)}`);
        this.fsyncError = strerror(err);
        return;
      }
      this.fsyncError = null;
      this.fsyncedSize = Math.max(this.fsyncedSize, target);
    });
  }
}

/** The AOF can't be loaded; the message (already logged) names the file and the byte offset. */
export class AofLoadError extends Error {
  override readonly name = 'AofLoadError';
}

export interface LoadResult {
  /** False when there was no file to load: nothing changed. */
  exists: boolean;
  commands: number;
  /** A cut-off tail was dropped from the file (aof-load-truncated). */
  truncated: boolean;
}

/**
 * Replays the file at `path` into the server's databases (spec 9.6, Loading). Throws
 * AofLoadError, after logging why, when the file is damaged anywhere but its tail or when
 * `aof-load-truncated` is off. Commands that ran before the damage stay applied, as in Redis.
 */
export function loadAof(server: Server, path: string): LoadResult {
  let fd: number;
  try {
    fd = fs.openSync(path, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, commands: 0, truncated: false };
    }
    fail(server, `Fatal error: can't open the append log file ${path} for reading: ${strerror(e)}`);
  }
  const started = Date.now();
  const limits = {
    maxBulkLen: () => server.config.get('proto-max-bulk-len'),
    authRequired: () => false,
  };
  const parser = new RespParser(limits, { multibulkOnly: true });
  const client = new Client(0, null, limits);
  let offset = 0; // end of the last complete command
  let beforeMulti = 0; // where the open MULTI started, for a revert
  let commands = 0;
  let truncated = false;

  server.loading = true;
  server.propagator.paused = true;
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(LOAD_CHUNK);
      const n = fs.readSync(fd, chunk, 0, LOAD_CHUNK, null);
      if (n === 0) break;
      // A fresh buffer per chunk: the parser keeps references to the bytes it hasn't used.
      parser.feed(n === LOAD_CHUNK ? chunk : chunk.subarray(0, n));
      for (;;) {
        let cmd;
        try {
          cmd = parser.next();
        } catch (e) {
          if (!(e instanceof ProtocolError)) throw e;
          fail(server, badFormat(path, offset, e.message.replace(/^ERR Protocol error: /, '')));
        }
        if (cmd === null) break;
        const start = offset;
        offset += cmd.bytes;
        checkCommand(server, cmd.argv, path, start);
        if (!client.multi && cmd.argv[0]!.toLowerCase() === 'multi') beforeMulti = start;
        dispatch(server, client, cmd.argv);
        client.reply.take();
        commands++;
      }
    }
    if (parser.pending || client.multi) {
      truncateTail(server, path, client.multi ? beforeMulti : offset, client.multi);
      truncated = true;
    }
  } finally {
    fs.closeSync(fd);
    server.loading = false;
    server.propagator.paused = false;
    // A hand-edited file could have watched or subscribed: leave nothing registered.
    discardTransaction(client);
    server.pubsub.unsubscribeAll(client);
    server.waiters.unblock(client);
  }
  // What was just loaded is already on disk.
  server.dirty = 0;
  const seconds = ((Date.now() - started) / 1000).toFixed(3);
  server.log.notice(`DB loaded from append only file: ${seconds} seconds`);
  return { exists: true, commands, truncated };
}

/**
 * DEBUG LOADAOF: write out what's buffered, empty every db, and load the file again. Returns
 * false if the file is missing or damaged; the data is then whatever loaded before the damage.
 */
export function reloadAof(server: Server): boolean {
  server.aof?.flush();
  for (const db of server.dbs) db.flush();
  const path = aofPath(server);
  try {
    const result = loadAof(server, path);
    if (result.truncated) server.aof?.afterTruncate();
    if (!result.exists) server.log.warning(`The append only file ${path} doesn't exist`);
    return result.exists;
  } catch (e) {
    if (e instanceof AofLoadError) return false;
    throw e;
  }
}

function fail(server: Server, message: string): never {
  server.log.warning(message);
  throw new AofLoadError(message);
}

const badFormat = (path: string, offset: number, detail: string): string =>
  `Bad file format reading the append only file ${path} at offset ${offset} (${detail}): ` +
  `make a backup of your AOF file, then remove or repair the record at that offset`;

/** The command must exist and have a valid argument count; anything else is damage. */
function checkCommand(server: Server, argv: readonly string[], path: string, start: number): void {
  const top = server.commands.get(argv[0]!.toLowerCase());
  if (top === undefined) {
    fail(
      server,
      `Unknown command '${argv[0]}' reading the append only file ${path} at offset ${start}`,
    );
  }
  let spec = top;
  if (arityOk(top.arity, argv.length) && top.subcommands && argv.length >= 2) {
    const sub = lookupSubcommand(top, argv[1]!);
    if (sub === undefined) {
      fail(
        server,
        `Unknown command '${argv[0]} ${argv[1]}' reading the append only file ${path} at offset ${start}`,
      );
    }
    spec = sub;
  }
  if (!arityOk(top.arity, argv.length) || !arityOk(spec.arity, argv.length)) {
    fail(server, badFormat(path, start, `wrong number of arguments for '${spec.name}' command`));
  }
}

/** The file ends mid-command or inside a MULTI: drop the tail if allowed, else refuse. */
function truncateTail(server: Server, path: string, at: number, inMulti: boolean): void {
  const log = server.log;
  if (inMulti) log.warning(`Revert incomplete MULTI/EXEC transaction in AOF file ${path}`);
  if (!server.config.get('aof-load-truncated')) {
    fail(
      server,
      `Unexpected end of file reading the append only file ${path} at offset ${at}. You can: ` +
        `1) Make a backup of your AOF file, then truncate it at that offset. ` +
        `2) Alternatively you can set the 'aof-load-truncated' configuration option to yes and ` +
        `restart the server.`,
    );
  }
  log.warning(`!!! Warning: short read while loading the AOF file ${path}!!!`);
  log.warning(`!!! Truncating the AOF ${path} at offset ${at} !!!`);
  try {
    fs.truncateSync(path, at);
  } catch (e) {
    fail(server, `Error truncating the AOF file ${path}: ${strerror(e)}`);
  }
  log.warning(`AOF ${path} loaded anyway because aof-load-truncated is enabled`);
}
