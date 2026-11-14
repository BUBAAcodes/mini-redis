/**
 * The Server (spec 6.1): every piece of global state on one object, the TCP listener, and
 * the read path from socket bytes to dispatched commands (spec 9.1, steps 1–3).
 *
 * Key design choice: no module-level state anywhere; everything hangs off this object and is
 * passed explicitly, so a test process can run several servers side by side (spec 4). A
 * client's input is parsed and executed synchronously in its `data` callback, while replies
 * only leave in beforeSleep, so all commands that arrive in one loop turn are answered with
 * one write per client.
 *
 * Startup follows spec 9.9: create `dir` and delete jobs' leftover temp files; then, with
 * `appendonly yes`, replay the AOF and open it for appending, or else load `dump.mrdb`. With
 * `appendonly yes`, no AOF and a snapshot, the snapshot is loaded and a rewrite turns it into
 * the AOF (aof-rewrite.ts). All of it happens before the listener opens, so no client ever sees
 * a half-loaded dataset. A damaged AOF or snapshot makes start() reject; it never starts empty
 * over good data.
 *
 * Mirrors Redis server.c (initServer, the redisServer struct) and networking.c
 * (acceptTcpHandler, readQueryFromClient, processInputBuffer, freeClient).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import type { Socket } from 'node:net';
import { Waiters } from '../blocking/waiters.js';
import { dispatch } from '../commands/dispatch.js';
import type { CommandTable } from '../commands/command.js';
import { buildCommandTable } from '../commands/registry.js';
import { Config } from '../config.js';
import type { DictOptions } from '../datastructures/dict.js';
import { Aof, aofPath, loadAof } from '../persistence/aof.js';
import { startAppendOnly, stopAppendOnly } from '../persistence/aof-rewrite.js';
import { removeLeftoverTemps } from '../persistence/files.js';
import { loadSnapshotFile, snapshotPath } from '../persistence/snapshot-format.js';
import type { SnapshotJob } from '../persistence/snapshot-job.js';
import { ProtocolError } from '../protocol/errors.js';
import { PubSubHub } from '../pubsub/hub.js';
import { Db } from '../storage/database.js';
import { unwatchAllKeys } from '../storage/watch.js';
import { Logger } from '../utils/logger.js';
import { Random } from '../utils/random.js';
import { Client } from './client.js';
import { Cron, lruClockNow } from './cron.js';
import { EventLoop } from './event-loop.js';
import { Propagator } from './propagate.js';

export interface ServerOptions {
  config?: Config;
  /** Where log lines go; stdout by default. Tests capture them. */
  log?: (line: string) => void;
  /** Seed for every random choice, so a test can replay a run. */
  seed?: number;
  /**
   * Called after a fatal error is logged, when the server can't keep its promises (an AOF
   * write failing under `appendfsync always`). Exits the process by default; tests observe it.
   */
  fatal?: (message: string) => void;
}

export interface Stats {
  totalConnectionsReceived: number;
  totalCommandsProcessed: number;
  rejectedConnections: number;
  expiredKeys: number;
  evictedKeys: number;
  keyspaceHits: number;
  keyspaceMisses: number;
}

const newStats = (): Stats => ({
  totalConnectionsReceived: 0,
  totalCommandsProcessed: 0,
  rejectedConnections: 0,
  expiredKeys: 0,
  evictedKeys: 0,
  keyspaceHits: 0,
  keyspaceMisses: 0,
});

export interface CommandStats {
  calls: number;
  usec: number;
}

export class Server {
  readonly config: Config;
  readonly log: Logger;
  readonly rng: Random;
  readonly dictOptions: DictOptions;
  readonly dbs: Db[];
  readonly clients = new Map<number, Client>();
  readonly commands: CommandTable = buildCommandTable();
  readonly eventLoop = new EventLoop(
    () => this.processUnblockedClients(),
    () => this.aof?.flush(),
  );
  readonly propagator = new Propagator(() => this.eventLoop.scheduleBeforeSleep());
  readonly cron: Cron;
  /** Channels and patterns (spec 9.11); a frame goes onto the client's output queue. */
  readonly pubsub = new PubSubHub<Client>((client, frame) => {
    client.reply.push(frame);
    this.queueReply(client);
  });
  /** Clients blocked by BLPOP, BRPOP and BLMOVE (spec 9.12). */
  readonly waiters = new Waiters(this);
  /** 40 hex characters, new on every start (spec 7.7). */
  readonly runId = randomBytes(20).toString('hex');
  readonly startTime = Date.now();
  stats = newStats();
  /** Per command name ('config|get'), for INFO commandstats and /metrics (step 23). */
  readonly commandStats = new Map<string, CommandStats>();
  /** Changes since the last save; signalModifiedKey increments it. */
  dirty = 0;
  /** Unix seconds of the last successful save (LASTSAVE); startup counts, as in Redis. */
  lastSave = Math.floor(Date.now() / 1000);
  lruClock = lruClockNow();
  /** The clock reading for the running command (spec 7.5). */
  cmdTime = Date.now();
  /** The port actually listened on: differs from the config when it's 0 (tests). */
  port = 0;
  /** Off after DEBUG SET-ACTIVE-EXPIRE 0: expired keys then go only when touched. */
  activeExpireEnabled = true;
  /** The db the next active-expiry cycle starts at (spec 9.3: resume where it stopped). */
  activeExpireDb = 0;
  /** The open AOF while `appendonly yes`, else null (also while waiting for the first rewrite). */
  aof: Aof | null = null;
  /**
   * Redis's aof_state: `wait-rewrite` while the AOF is being turned on, when no AOF is written
   * until a rewrite has produced one holding the whole dataset.
   */
  aofState: 'off' | 'on' | 'wait-rewrite' = 'off';
  /** A BGREWRITEAOF that had to wait for another job (or an EXEC); serverCron starts it. */
  aofRewriteScheduled = false;
  /** INFO's aof_last_bgrewrite_status. */
  aofLastRewriteStatus: 'ok' | 'err' = 'ok';
  /** Rewrites started since startup (INFO's aof_rewrites). */
  aofRewrites = 0;
  /** Unix ms of the last rewrite attempt: after a failure, serverCron waits 5 s. */
  lastAofRewriteTry = 0;
  /** True while the AOF is replayed: nothing expires, propagates or counts in the stats. */
  loading = false;
  /** The one running snapshot job (BGSAVE or AOF rewrite; full sync later), or null (9.8). */
  snapshotJob: SnapshotJob | null = null;
  /** Bumped by each job; an object stamped with the running job's epoch is already saved. */
  snapshotEpoch = 0;
  /** Numbers the temp files, `temp-<pid>-<n>.mrdb`. */
  snapshotSeq = 0;
  /** INFO's rdb_last_bgsave_status; SAVE sets it too, as in Redis. */
  lastBgsaveStatus: 'ok' | 'err' = 'ok';
  /** Unix ms of the last BGSAVE attempt: after a failure, save points wait 5 s. */
  lastBgsaveTry = 0;
  /** A BGSAVE asked for inside EXEC, started by serverCron once the transaction is over. */
  bgsaveScheduled = false;

  /** Served or timed out this turn: their buffered input runs in the next beforeSleep. */
  private readonly unblockedClients = new Set<Client>();
  private nextClientId = 1;
  private listener: net.Server | null = null;
  private shuttingDown = false;
  private detachAof: (() => void) | null = null;
  private readonly onFatal: (message: string) => void;

  constructor(options: ServerOptions = {}) {
    this.config = options.config ?? new Config();
    this.log = new Logger({
      level: () => this.config.get('loglevel'),
      role: () => 'M',
      ...(options.log ? { write: options.log } : {}),
    });
    this.onFatal = options.fatal ?? (() => process.exit(1));
    this.rng = new Random(options.seed);
    this.dictOptions = { seed: this.rng.uint32(), rng: this.rng };
    this.dbs = Array.from({ length: this.config.get('databases') }, (_, i) => new Db(i, this));
    this.cron = new Cron(this);
    this.config.onChange((names) => {
      if (names.includes('hz') && this.cron.running) this.cron.start();
      if (names.includes('appendonly')) {
        // As Redis's updateAppendonly: act only when the state really changes.
        const on = this.config.get('appendonly');
        if (on && this.aofState === 'off') startAppendOnly(this);
        else if (!on && this.aofState !== 'off') stopAppendOnly(this);
      }
    });
  }

  /**
   * Loads the data, listens, and starts serverCron. Resolves once connections are accepted;
   * rejects with AofLoadError or SnapshotLoadError (already logged) if the file is damaged.
   */
  async start(): Promise<void> {
    const dir = this.config.get('dir');
    mkdirSync(dir, { recursive: true });
    for (const name of removeLeftoverTemps(dir)) {
      this.log.notice(`Removed leftover temp file ${name}`);
    }
    if (!this.config.get('appendonly')) loadSnapshotFile(this, snapshotPath(this));
    else if (!existsSync(aofPath(this)) && loadSnapshotFile(this, snapshotPath(this)) !== null) {
      // Spec 9.9 step 2: the snapshot's data must reach the AOF before an AOF exists.
      startAppendOnly(this);
    } else this.openAof();
    const listener = net.createServer((socket) => this.accept(socket));
    this.listener = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen({ port: this.config.get('port'), host: this.config.get('bind') }, () => {
        listener.off('error', reject);
        resolve();
      });
    });
    const address = listener.address();
    this.port = typeof address === 'object' && address !== null ? address.port : 0;
    listener.on('error', (e) => this.log.warning(`Listener error: ${e.message}`));
    this.cron.start();
    this.log.notice(`Running mode=standalone, port=${this.port}.`);
    this.log.notice('Server initialized');
    this.log.notice('Ready to accept connections tcp');
  }

  /**
   * Stops accepting, aborts a running snapshot job (deleting its temp file), flushes queued
   * replies, closes every connection and resolves when all are gone. Saving at shutdown
   * (spec 9.14 step 3) joins in step 23.
   */
  async close(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.cron.stop();
    this.snapshotJob?.abort('shutdown');
    const listening = this.listener;
    const listenerClosed = new Promise<void>((resolve) => {
      if (listening === null) resolve();
      else listening.close(() => resolve());
    });
    // Writes the AOF buffer, then the replies; then the AOF is fsynced (spec 9.14 step 2).
    this.eventLoop.beforeSleep();
    this.closeAof();
    const sockets = [...this.clients.values()].map(
      (client) =>
        new Promise<void>((resolve) => {
          const socket = client.socket!;
          socket.once('close', () => resolve());
          if (socket.destroyed) resolve();
          client.closed = true;
          socket.end(() => socket.destroy());
        }),
    );
    await Promise.all([listenerClosed, ...sockets]);
  }

  /** Logs why the server can't go on, then exits (or tells the test that it would have). */
  fatal(message: string): void {
    this.log.warning(message);
    this.onFatal(message);
  }

  /** Replays the AOF if there is one, then opens it for appending as a propagation sink. */
  private openAof(): void {
    const path = aofPath(this);
    loadAof(this, path);
    this.setAof(new Aof(this, path));
    this.aofState = 'on';
  }

  /** Makes `aof` the open AOF and a propagation sink, or leaves none. The old one isn't closed. */
  setAof(aof: Aof | null): void {
    this.detachAof?.();
    this.detachAof = null;
    this.aof = aof;
    if (aof !== null) this.detachAof = this.propagator.attach(aof);
  }

  /** Detaches the AOF, then writes, fsyncs and closes it (spec 9.14 step 2). */
  closeAof(): void {
    const aof = this.aof;
    this.setAof(null);
    aof?.close();
  }

  /** Queues a client for the next beforeSleep: it has replies (or a close) waiting. */
  queueReply(client: Client): void {
    this.eventLoop.queueClient(client);
  }

  /**
   * A client just left the blocked state with a reply queued. Its later pipelined commands
   * run from beforeSleep rather than here, so they never run nested inside the command (or
   * timer) that unblocked it.
   */
  queueUnblocked(client: Client): void {
    this.unblockedClients.add(client);
    this.queueReply(client);
  }

  resetStats(): void {
    this.stats = newStats();
    this.commandStats.clear();
  }

  recordCommandStats(name: string, usec: number): void {
    const entry = this.commandStats.get(name);
    if (entry === undefined) this.commandStats.set(name, { calls: 1, usec });
    else {
      entry.calls++;
      entry.usec += usec;
    }
  }

  private accept(socket: Socket): void {
    if (this.shuttingDown) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const keepalive = this.config.get('tcp-keepalive');
    if (keepalive > 0) socket.setKeepAlive(true, keepalive * 1000);
    const client: Client = new Client(this.nextClientId++, socket, {
      maxBulkLen: () => this.config.get('proto-max-bulk-len'),
      authRequired: (): boolean => !client.authenticated,
    });
    this.clients.set(client.id, client);
    this.stats.totalConnectionsReceived++;
    socket.on('data', (chunk: Buffer) => this.onData(client, chunk));
    // A reset or a write to a closed peer; 'close' follows and cleans up.
    socket.on('error', (e) => this.log.verbose(`Client ${client.describe()} error: ${e.message}`));
    socket.on('close', () => this.freeClient(client));
  }

  private onData(client: Client, chunk: Buffer): void {
    if (client.closeAfterReply || client.closed || this.shuttingDown) return;
    client.lastInteraction = Date.now();
    client.parser.feed(chunk);
    this.processInput(client);
  }

  /** Runs every complete command in the client's input, in order (spec 9.1, step 2). */
  private processInput(client: Client): void {
    try {
      // A blocked client stops here too, leaving its later input in the parser (spec 9.2).
      while (!client.closeAfterReply && !client.blocked) {
        const cmd = client.parser.next();
        if (cmd === null) break;
        if (cmd.argv.length > 0) dispatch(this, client, cmd.argv);
      }
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      this.log.verbose(`Protocol error (${e.message}) from client: ${client.describe()}`);
      client.reply.error(e.message);
      client.closeAfterReply = true;
    }
    const limit = this.config.get('client-query-buffer-limit');
    if (client.parser.bufferedBytes > limit) {
      this.log.warning(
        `Closing client that reached max query buffer length: ${client.describe()} ` +
          `qbuf=${client.parser.bufferedBytes}`,
      );
      // No reply, as in Redis: the client gets nothing more.
      this.freeClient(client);
      client.socket!.destroy();
      return;
    }
    if (client.reply.pendingBytes > 0 || client.closeAfterReply) this.queueReply(client);
  }

  /** Runs what unblocked clients pipelined; running it may unblock more, so loop. */
  private processUnblockedClients(): void {
    while (this.unblockedClients.size > 0) {
      const client = this.unblockedClients.values().next().value!;
      this.unblockedClients.delete(client);
      if (!client.closed && !client.blocked) this.processInput(client);
    }
  }

  private freeClient(client: Client): void {
    client.closed = true;
    this.clients.delete(client.id);
    this.eventLoop.forget(client);
    // A gone client must not stay in any db's WATCH registry, in the pub/sub hub, or blocked
    // on a key with a live timer.
    unwatchAllKeys(client);
    this.pubsub.unsubscribeAll(client);
    this.waiters.unblock(client);
    this.unblockedClients.delete(client);
  }
}
