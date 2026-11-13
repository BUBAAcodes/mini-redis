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
 * Mirrors Redis server.c (initServer, the redisServer struct) and networking.c
 * (acceptTcpHandler, readQueryFromClient, processInputBuffer, freeClient).
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import type { Socket } from 'node:net';
import { dispatch } from '../commands/dispatch.js';
import type { CommandTable } from '../commands/command.js';
import { buildCommandTable } from '../commands/registry.js';
import { Config } from '../config.js';
import type { DictOptions } from '../datastructures/dict.js';
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
  readonly eventLoop = new EventLoop();
  readonly propagator = new Propagator(() => this.eventLoop.scheduleBeforeSleep());
  readonly cron: Cron;
  /** Channels and patterns (spec 9.11); a frame goes onto the client's output queue. */
  readonly pubsub = new PubSubHub<Client>((client, frame) => {
    client.reply.push(frame);
    this.queueReply(client);
  });
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

  private nextClientId = 1;
  private listener: net.Server | null = null;
  private shuttingDown = false;

  constructor(options: ServerOptions = {}) {
    this.config = options.config ?? new Config();
    this.log = new Logger({
      level: () => this.config.get('loglevel'),
      role: () => 'M',
      ...(options.log ? { write: options.log } : {}),
    });
    this.rng = new Random(options.seed);
    this.dictOptions = { seed: this.rng.uint32(), rng: this.rng };
    this.dbs = Array.from({ length: this.config.get('databases') }, (_, i) => new Db(i, this));
    this.cron = new Cron(this);
    this.config.onChange((names) => {
      if (names.includes('hz') && this.cron.running) this.cron.start();
    });
  }

  /** Listens and starts serverCron. Resolves once connections are accepted. */
  async start(): Promise<void> {
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
   * Stops accepting, flushes queued replies, closes every connection and resolves when all are
   * gone. The SHUTDOWN steps that save data (spec 9.14) join in steps 12, 13 and 23.
   */
  async close(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.cron.stop();
    const listening = this.listener;
    const listenerClosed = new Promise<void>((resolve) => {
      if (listening === null) resolve();
      else listening.close(() => resolve());
    });
    this.eventLoop.beforeSleep();
    const sockets = [...this.clients.values()].map(
      (client) =>
        new Promise<void>((resolve) => {
          client.socket.once('close', () => resolve());
          if (client.socket.destroyed) resolve();
          client.closed = true;
          client.socket.end(() => client.socket.destroy());
        }),
    );
    await Promise.all([listenerClosed, ...sockets]);
  }

  /** Queues a client for the next beforeSleep: it has replies (or a close) waiting. */
  queueReply(client: Client): void {
    this.eventLoop.queueClient(client);
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
      // Blocked clients (step 18) also stop here, leaving later input in the parser.
      while (!client.closeAfterReply) {
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
      client.socket.destroy();
      return;
    }
    if (client.reply.pendingBytes > 0 || client.closeAfterReply) this.queueReply(client);
  }

  private freeClient(client: Client): void {
    client.closed = true;
    this.clients.delete(client.id);
    this.eventLoop.forget(client);
    // A gone client must not stay in any db's WATCH registry or in the pub/sub hub.
    unwatchAllKeys(client);
    this.pubsub.unsubscribeAll(client);
  }
}
