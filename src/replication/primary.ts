/**
 * The primary side of replication (spec 9.13): the replication stream, the backlog, the
 * replicas and their states, PSYNC (full sync through the snapshot engine, partial sync from the
 * backlog), ACKs, WAIT, and the once-a-second chores: heartbeat PINGs, keepalive newlines,
 * timeouts and the replica output limit.
 *
 * Key design choice: the stream is one more propagation sink, attached when the backlog is
 * created, so it sees every change exactly once and in order, as the AOF does (rule 6). Each
 * record is encoded once, with SELECT when its db differs from the stream's last one; it goes
 * into the backlog and grows `masterReplOffset` at once (so WAIT's offsets are exact), and its
 * bytes collect for the turn. beforeSleep hands the turn's bytes to every online replica, or to
 * the queue of a replica waiting for its snapshot, after the AOF write (rule 8). Anything that
 * changes which replicas get the stream (PSYNC, a full sync starting) first flushes the turn's
 * bytes, so a replica never gets bytes from before its offset, or misses one after it.
 *
 * A full sync is a snapshot job with the memory sink (spec 9.8). Every replica waiting when it
 * starts gets `+FULLRESYNC <replid> <offset>` with the offset at that instant, and from then on
 * the stream is queued for it; when the job ends it gets `$<len>\r\n`, the snapshot and the
 * queue, and is online. One job at a time: a replica arriving during another job waits for the
 * next one, getting a bare `\n` every second meanwhile.
 *
 * Replicas never get replies: PSYNC's answers and the stream are written from their own queue
 * of Buffers, and a replica whose command produced a reply is disconnected, as Redis does.
 *
 * Mirrors Redis replication.c (replicationFeedSlaves, syncCommand,
 * masterTryPartialResynchronization, addReplyReplicationBacklog, startBgsaveForReplication,
 * updateSlavesWaitingBgsave, replconfCommand, waitCommand, processClientsWaitingReplicas,
 * replicationCron, roleCommand) and networking.c (checkClientOutputBufferLimits).
 */
import { randomBytes } from 'node:crypto';
import { encodeCommand } from '../persistence/aof.js';
import { snapshotAux } from '../persistence/snapshot-format.js';
import { MemorySnapshotSink, SnapshotJob } from '../persistence/snapshot-job.js';
import { timerDelay } from '../blocking/waiters.js';
import type { CommandContext } from '../commands/command.js';
import type { Client } from '../server/client.js';
import type { PropagationRecord, PropagationSink } from '../server/propagate.js';
import type { Server } from '../server/server.js';
import { ReplicationBacklog } from './backlog.js';

/** 40 random hex characters (spec 7.7). */
export const newReplid = (): string => randomBytes(20).toString('hex');

const NO_REPLID = '0'.repeat(40);

/** INFO's names for the states (Redis's replstateToString). */
export type ReplicaState = 'wait_bgsave_start' | 'wait_bgsave_end' | 'online';

/** What a client becomes when it sends PSYNC (spec 6.1 Client: the replica fields). */
export interface ReplicaLink {
  state: ReplicaState;
  /** The last offset it acknowledged, and when (ms). */
  ackOffset: number;
  ackTime: number;
  /** Bytes for its socket, written in beforeSleep. */
  out: Buffer[];
  outBytes: number;
  /** While its snapshot is made: the stream since +FULLRESYNC, sent after the snapshot. */
  pending: Buffer[];
  pendingBytes: number;
  /** The full-sync job making its snapshot. */
  job: SnapshotJob | null;
}

/** What a client blocked in WAIT waits for. */
export interface WaitState {
  readonly numreplicas: number;
  /** Its `woff` when WAIT ran. */
  readonly offset: number;
  /** Unix ms; 0 = forever. */
  readonly deadline: number;
  timer: NodeJS.Timeout | null;
}

const NEWLINE = Buffer.from('\n');

const linkOf = (client: Client): ReplicaLink => client.repl!;

/** `ip:listening-port`, as Redis's replicationGetSlaveName. */
export function replicaName(client: Client): string {
  const ip = client.socket?.remoteAddress ?? '?';
  return `${ip}:${client.replListeningPort > 0 ? client.replListeningPort : '<unknown-replica-port>'}`;
}

export class Replication implements PropagationSink {
  replid = newReplid();
  replid2 = NO_REPLID;
  /** The first offset replid2 can't vouch for; -1 without one. */
  secondReplidOffset = -1;
  /** Bytes of stream produced so far: the offset of its last byte. */
  masterReplOffset = 0;
  backlog: ReplicationBacklog | null = null;
  /** Every client that sent PSYNC, in every state, in arrival order. */
  readonly replicas = new Set<Client>();

  private readonly waiting = new Set<Client>();
  /** The db the stream's last record ran in; -1 makes the next one carry a SELECT. */
  private seldb = -1;
  /** This turn's stream bytes, not yet handed to the replicas. */
  private turn = '';
  /** A WAIT blocked this turn: beforeSleep asks every replica for an ACK. */
  private getackRequested = false;
  private lastPing = 0;
  private lastCron = 0;

  constructor(private readonly server: Server) {}

  /** For tests and INFO: clients blocked in WAIT. */
  get waitingCount(): number {
    return this.waiting.size;
  }

  // --- the stream -------------------------------------------------------------------------

  /** The propagation sink: every record goes into the stream once, PUBLISH included. */
  append(record: PropagationRecord): void {
    let bytes = encodeCommand(record.argv);
    if (record.db !== this.seldb) {
      bytes = encodeCommand(['SELECT', String(record.db)]) + bytes;
      this.seldb = record.db;
    }
    this.feed(bytes);
  }

  /** PING and REPLCONF GETACK: into the stream with no SELECT, as Redis feeds them. */
  feedRaw(argv: readonly string[]): void {
    this.feed(encodeCommand(argv));
    this.server.eventLoop.scheduleBeforeSleep();
  }

  private feed(bytes: string): void {
    this.backlog!.append(bytes);
    this.masterReplOffset += bytes.length;
    this.turn += bytes;
  }

  /** Hands this turn's bytes to the replicas that get the stream now. */
  private flushStream(): void {
    if (this.turn === '') return;
    const data = Buffer.from(this.turn, 'latin1');
    this.turn = '';
    for (const client of this.replicas) {
      const link = linkOf(client);
      if (link.state === 'online') this.enqueue(client, data);
      else if (link.state === 'wait_bgsave_end') {
        link.pending.push(data);
        link.pendingBytes += data.length;
      }
    }
  }

  /** beforeSleep, first: a WAIT that blocked this turn asks every replica where it is. */
  requestAcks(): void {
    if (!this.getackRequested) return;
    this.getackRequested = false;
    if (this.replicas.size > 0) this.feedRaw(['REPLCONF', 'GETACK', '*']);
  }

  /** beforeSleep, after the AOF write: the stream and PSYNC's replies leave, then the limits. */
  writeReplicas(): void {
    this.flushStream();
    const now = Date.now();
    for (const client of [...this.replicas]) {
      const link = linkOf(client);
      const socket = client.socket;
      if (link.out.length > 0 && socket !== null && !client.closed) {
        socket.cork();
        for (const chunk of link.out) socket.write(chunk);
        socket.uncork();
        link.out = [];
        link.outBytes = 0;
      }
      this.checkOutputLimits(client, now);
    }
  }

  private enqueue(client: Client, data: Buffer): void {
    const link = linkOf(client);
    link.out.push(data);
    link.outBytes += data.length;
    this.server.eventLoop.scheduleBeforeSleep();
  }

  // --- PSYNC ------------------------------------------------------------------------------

  /** PSYNC replid offset, `offset` being the first byte the replica doesn't have. */
  psync(client: Client, replid: string, offset: number): void {
    if (client.repl !== null) return; // already a replica: ignored, as in Redis
    const server = this.server;
    const name = replicaName(client);
    server.log.notice(`Replica ${name} asks for synchronization`);
    // Bytes produced before this moment go to the others; this one gets the backlog instead.
    this.flushStream();
    if (this.tryPartialResync(client, replid, offset)) {
      server.stats.syncPartialOk++;
      return;
    }
    if (replid !== '?') server.stats.syncPartialErr++;
    server.stats.syncFull++;
    server.log.notice(`Full resync requested by replica ${name}`);
    client.repl = newLink('wait_bgsave_start');
    this.replicas.add(client);
    if (this.backlog === null) this.createBacklog();
    this.startFullSync();
  }

  /** Spec 9.13 Partial sync, step 1: the replid must match and the offset must be held. */
  private tryPartialResync(client: Client, replid: string, offset: number): boolean {
    const log = this.server.log;
    const name = replicaName(client);
    if (replid !== this.replid && (replid !== this.replid2 || offset > this.secondReplidOffset)) {
      if (replid === '?') return false;
      if (replid !== this.replid2) {
        log.notice(
          `Partial resynchronization not accepted: Replication ID mismatch (Replica asked for '${replid}', my replication IDs are '${this.replid}' and '${this.replid2}')`,
        );
      } else {
        log.notice(
          `Partial resynchronization not accepted: Requested offset for second ID was ${offset}, but I can reply up to ${this.secondReplidOffset}`,
        );
      }
      return false;
    }
    const backlog = this.backlog;
    if (backlog === null || !backlog.contains(offset)) {
      log.notice(
        `Unable to partial resync with replica ${name} for lack of backlog (Replica request was: ${offset}).`,
      );
      if (backlog !== null && offset > backlog.endOffset + 1) {
        log.warning(
          `Warning: replica ${name} tried to PSYNC with an offset that is greater than the master replication offset.`,
        );
      }
      return false;
    }
    const link = newLink('online');
    client.repl = link;
    this.replicas.add(client);
    // A replica that can't take a new replid (no capa psync2) gets the old, bare reply.
    const line = client.replCapaPsync2 ? `+CONTINUE ${this.replid}\r\n` : '+CONTINUE\r\n';
    this.enqueue(client, Buffer.from(line, 'latin1'));
    const missed = backlog.readFrom(offset);
    if (missed.length > 0) this.enqueue(client, missed);
    log.notice(
      `Partial resynchronization request from ${name} accepted. Sending ${missed.length} bytes of backlog starting from offset ${offset}.`,
    );
    return true;
  }

  /**
   * The first replica's backlog. As Redis does, a new backlog comes with a new replid: no
   * replica can hold history from before it, so none may continue across it.
   */
  private createBacklog(): void {
    this.replid = newReplid();
    this.replid2 = NO_REPLID;
    this.secondReplidOffset = -1;
    this.backlog = new ReplicationBacklog(
      this.server.config.get('repl-backlog-size'),
      this.masterReplOffset,
    );
    this.seldb = -1;
    this.lastPing = Date.now();
    this.server.propagator.attach(this);
    this.server.log.notice(
      `Replication backlog created, my new replication IDs are '${this.replid}' and '${this.replid2}'`,
    );
  }

  /** CONFIG SET repl-backlog-size. */
  resizeBacklog(): void {
    this.backlog?.resize(this.server.config.get('repl-backlog-size'));
  }

  /**
   * Starts one full-sync job for every replica waiting for one, unless another job runs
   * (spec 9.8 Lifecycle step 5); serverCron tries again every tick.
   */
  startFullSync(): void {
    const server = this.server;
    if (server.snapshotJob !== null) return;
    const waiting = [...this.replicas].filter((c) => linkOf(c).state === 'wait_bgsave_start');
    if (waiting.length === 0) return;
    // Bytes from before the snapshot's instant aren't theirs; the next record says its db.
    this.flushStream();
    this.seldb = -1;
    const sink = new MemorySnapshotSink(snapshotAux());
    const job: SnapshotJob = new SnapshotJob(
      server,
      'fullsync',
      sink,
      (err) => this.fullSyncDone(job, sink, err),
      { onAbort: () => this.dropSyncing(job) },
    );
    server.log.notice('Starting full sync job for replicas');
    const line = Buffer.from(`+FULLRESYNC ${this.replid} ${job.replOffset}\r\n`, 'latin1');
    for (const client of waiting) {
      const link = linkOf(client);
      link.state = 'wait_bgsave_end';
      link.job = job;
      this.enqueue(client, line);
    }
  }

  /** Spec 9.13 Full sync, step 2: the snapshot, then what was queued; the replica is online. */
  private fullSyncDone(job: SnapshotJob, sink: MemorySnapshotSink, err: Error | null): void {
    if (err !== null) {
      this.server.log.warning(`Full sync failed: ${err.message}`);
      this.dropSyncing(job);
      return;
    }
    const payload = sink.result();
    this.server.log.notice(`Copy-on-write saved ${job.savedByHook} of ${job.keysWritten} keys`);
    const header = Buffer.from(`$${payload.length}\r\n`, 'latin1');
    const now = Date.now();
    for (const client of [...this.replicas]) {
      const link = linkOf(client);
      if (link.job !== job) continue;
      this.enqueue(client, header);
      this.enqueue(client, payload);
      for (const chunk of link.pending) this.enqueue(client, chunk);
      link.pending = [];
      link.pendingBytes = 0;
      link.job = null;
      link.state = 'online';
      link.ackTime = now;
      this.server.log.notice(`Synchronization with replica ${replicaName(client)} succeeded`);
    }
    // Replicas that asked while this job ran.
    this.startFullSync();
  }

  /** Spec 9.8 Lifecycle step 4: replicas waiting on an aborted job are dropped and retry. */
  private dropSyncing(job: SnapshotJob): void {
    for (const client of [...this.replicas]) {
      if (linkOf(client).job === job) this.server.killClient(client);
    }
  }

  // --- ACKs and WAIT ----------------------------------------------------------------------

  /** REPLCONF ACK <offset>: no reply; re-checks the clients in WAIT (spec 9.13 WAIT step 2). */
  ack(client: Client, offset: number): void {
    const link = client.repl;
    if (link === null) return;
    if (offset > link.ackOffset) link.ackOffset = offset;
    link.ackTime = Date.now();
    for (const waiter of [...this.waiting]) {
      const state = waiter.bwait!;
      const acked = this.countAcks(state.offset);
      if (acked >= state.numreplicas) this.finishWait(waiter, acked);
    }
  }

  /** Online replicas that acknowledged at least `offset`. */
  countAcks(offset: number): number {
    let n = 0;
    for (const client of this.replicas) {
      const link = linkOf(client);
      if (link.state === 'online' && link.ackOffset >= offset) n++;
    }
    return n;
  }

  /** WAIT numreplicas timeout (spec 9.13 WAIT step 1). The arguments are already checked. */
  wait(ctx: CommandContext, numreplicas: number, timeoutMs: number): void {
    const client = ctx.client;
    const acked = this.countAcks(client.woff);
    // Inside MULTI it can't block (Redis's CLIENT_DENY_BLOCKING): the count now.
    if (acked >= numreplicas || client.denyBlocking) {
      ctx.reply.integer(acked);
      return;
    }
    const deadline = timeoutMs === 0 ? 0 : this.server.cmdTime + timeoutMs;
    const state: WaitState = { numreplicas, offset: client.woff, deadline, timer: null };
    client.bwait = state;
    this.waiting.add(client);
    if (deadline !== 0) this.arm(client, state);
    this.getackRequested = true;
    this.server.eventLoop.scheduleBeforeSleep();
  }

  private arm(client: Client, state: WaitState): void {
    state.timer = setTimeout(
      () => {
        if (client.bwait !== state) return;
        if (Date.now() < state.deadline) this.arm(client, state);
        else this.finishWait(client, this.countAcks(state.offset));
      },
      timerDelay(state.deadline, Date.now()),
    );
    state.timer.unref();
  }

  /** WAIT returns: the count, then the client's buffered input runs (rule 12). */
  private finishWait(client: Client, acked: number): void {
    this.unblockWait(client);
    client.reply.integer(acked);
    // Not counted when it blocked; its one call is counted now, as BLPOP's is.
    this.server.recordCommandStats('wait', 0);
    this.server.queueUnblocked(client);
  }

  private unblockWait(client: Client): void {
    const state = client.bwait;
    if (state === null) return;
    if (state.timer !== null) clearTimeout(state.timer);
    client.bwait = null;
    this.waiting.delete(client);
  }

  // --- chores -----------------------------------------------------------------------------

  /**
   * serverCron: a waiting full sync starts as soon as no job runs; once a second, the
   * heartbeat PING, keepalive newlines, replica timeouts and soft output limits.
   */
  cron(now: number = Date.now()): void {
    this.startFullSync();
    if (now - this.lastCron < 1000) return;
    this.lastCron = now;
    if (this.replicas.size === 0) return;
    const config = this.server.config;
    if (now - this.lastPing >= config.get('repl-ping-replica-period') * 1000) {
      this.lastPing = now;
      this.feedRaw(['PING']);
    }
    const timeoutMs = config.get('repl-timeout') * 1000;
    for (const client of [...this.replicas]) {
      const link = linkOf(client);
      if (link.state !== 'online') {
        // Spec 9.13 Full sync, step 1: the link mustn't time out while the snapshot is made.
        this.enqueue(client, NEWLINE);
      } else if (now - link.ackTime > timeoutMs) {
        this.server.log.warning(
          `Disconnecting timedout replica (streaming sync): ${replicaName(client)}`,
        );
        this.server.killClient(client);
        continue;
      }
      this.checkOutputLimits(client, now);
    }
  }

  /** What's waiting to reach a replica: our queues plus what the socket still buffers. */
  outputBytes(client: Client): number {
    const link = linkOf(client);
    return link.outBytes + link.pendingBytes + (client.socket?.writableLength ?? 0);
  }

  /**
   * The `replica` class of client-output-buffer-limit (step 22 adds the other classes): past
   * the hard limit at once, past the soft one for longer than its seconds. True if it closed.
   */
  private checkOutputLimits(client: Client, now: number): boolean {
    const limit = this.server.config.get('client-output-buffer-limit').replica;
    const used = this.outputBytes(client);
    const hard = limit.hard > 0 && used >= limit.hard;
    let soft = limit.soft > 0 && used >= limit.soft;
    if (!soft) client.softLimitSince = 0;
    else if (client.softLimitSince === 0) {
      client.softLimitSince = now;
      soft = false;
    } else if (now - client.softLimitSince <= limit.softSeconds * 1000) soft = false;
    if (!hard && !soft) return false;
    this.server.log.warning(
      `Client ${client.describe()} scheduled to be closed ASAP for overcoming of output buffer limits.`,
    );
    this.server.killClient(client);
    return true;
  }

  /** The client is gone: forget it as a replica and as a WAIT client. */
  freeClient(client: Client): void {
    this.unblockWait(client);
    if (client.repl === null) return;
    this.replicas.delete(client);
    this.server.log.notice(`Connection with replica ${replicaName(client)} lost.`);
  }

  // --- reporting --------------------------------------------------------------------------

  /** INFO's `# Replication` fields on a primary (spec 13.1). */
  infoFields(): Array<[string, string | number]> {
    const now = Date.now();
    const fields: Array<[string, string | number]> = [
      ['role', 'master'],
      ['connected_slaves', this.replicas.size],
    ];
    let i = 0;
    for (const client of this.replicas) {
      const link = linkOf(client);
      const state = link.state === 'online' ? 'online' : 'wait_bgsave';
      const lag = Math.floor((now - link.ackTime) / 1000);
      fields.push([
        `slave${i++}`,
        `ip=${client.socket?.remoteAddress ?? '?'},port=${client.replListeningPort},state=${state},offset=${link.ackOffset},lag=${lag}`,
      ]);
    }
    const backlog = this.backlog;
    fields.push(
      ['master_replid', this.replid],
      ['master_replid2', this.replid2],
      ['master_repl_offset', this.masterReplOffset],
      ['second_repl_offset', this.secondReplidOffset],
      ['repl_backlog_active', backlog === null ? 0 : 1],
      ['repl_backlog_size', this.server.config.get('repl-backlog-size')],
      ['repl_backlog_first_byte_offset', backlog === null ? 0 : backlog.firstByteOffset],
      ['repl_backlog_histlen', backlog === null ? 0 : backlog.histlen],
    );
    return fields;
  }

  /** ROLE on a primary: its online replicas' address, listening port and ACK offset. */
  roleReply(ctx: CommandContext): void {
    const online = [...this.replicas].filter((c) => linkOf(c).state === 'online');
    const reply = ctx.reply;
    reply.arrayLen(3);
    reply.bulk('master');
    reply.integer(this.masterReplOffset);
    reply.arrayLen(online.length);
    for (const client of online) {
      reply.arrayLen(3);
      reply.bulk(client.socket?.remoteAddress ?? '');
      reply.bulk(String(client.replListeningPort));
      reply.bulk(String(linkOf(client).ackOffset));
    }
  }
}

function newLink(state: ReplicaState): ReplicaLink {
  return {
    state,
    ackOffset: 0,
    ackTime: Date.now(),
    out: [],
    outBytes: 0,
    pending: [],
    pendingBytes: 0,
    job: null,
  };
}
