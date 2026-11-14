/**
 * The replica side of replication (spec 9.13): following a primary (REPLICAOF), the handshake,
 * loading the full-sync payload, applying the stream with byte-exact offsets, ACKs, timeouts,
 * reconnecting with PSYNC, and promotion (REPLICAOF NO ONE).
 *
 * Key design choice: the link is a plain socket while it shakes hands and receives the payload,
 * read line by line (skipping the primary's keepalive newlines) and then byte by byte. Once
 * streaming, the same socket becomes a client of our own, flagged `primaryLink`, whose commands
 * go through the normal dispatcher. They are obeyed without the checks a user gets, and every
 * reply is thrown away; REPLCONF GETACK writes its ACK straight to the socket.
 *
 * The offset counts exactly the bytes applied (rule 13). The raw bytes received are kept until
 * the commands they hold have run. Only then do they go, unchanged, into our backlog and
 * `masterReplOffset` (spec 9.5), which is the offset we ACK and PSYNC from. A transaction
 * commits at its EXEC, as in Redis: if the link drops between MULTI and EXEC, the queued
 * commands are dropped with the client, and the next PSYNC asks again from the MULTI.
 *
 * All the history lives in the Replication object (primary.ts): the primary's replid, our
 * offset and our backlog. So a replica that lost its link offers that history in its PSYNC,
 * and so does a primary that is told to follow another server (Redis's
 * replicationCacheMasterUsingMyself). A promoted replica serves partial syncs from it.
 *
 * A lost streaming link is retried at once, as Redis 7 does, so little of the backlog moves
 * on in between. A failed handshake or payload waits for the next once-a-second retry.
 *
 * Mirrors Redis replication.c (replicaofCommand, replicationSetMaster, replicationUnsetMaster,
 * connectWithMaster, syncWithMaster, readSyncBulkPayload, replicationCreateMasterClient,
 * replicationSendAck, replicationCron, replicationHandleMasterDisconnection, roleCommand) and
 * networking.c (processInputBuffer and commandProcessed for the master client).
 */
import { constants as bufferConstants } from 'node:buffer';
import net from 'node:net';
import type { Socket } from 'node:net';
import type { CommandContext } from '../commands/command.js';
import { dispatch } from '../commands/dispatch.js';
import { encodeCommand } from '../persistence/aof.js';
import { startAppendOnly, stopAppendOnly } from '../persistence/aof-rewrite.js';
import {
  SnapshotLoadError,
  installSnapshot,
  readSnapshot,
} from '../persistence/snapshot-format.js';
import type { LoadedSnapshot } from '../persistence/snapshot-format.js';
import { ProtocolError } from '../protocol/errors.js';
import type { Client } from '../server/client.js';
import type { Server } from '../server/server.js';
import { parseInt64 } from '../utils/numbers.js';

/** ROLE's names for the link's states (Redis's repl_state, every handshake step `handshake`). */
export type LinkState = 'none' | 'connect' | 'connecting' | 'handshake' | 'sync' | 'connected';

/** The reply the handshake waits for next. */
type HandshakeStep = 'ping' | 'auth' | 'port' | 'capa' | 'psync';

/** A full sync under way: +FULLRESYNC's ID and offset, then the payload as it arrives. */
interface FullSync {
  readonly replid: string;
  readonly offset: number;
  /** From the `$<len>` line; -1 until it arrives. */
  size: number;
  chunks: Buffer[];
  received: number;
}

/** The longest handshake line we wait for (rule 11); real ones are under 100 bytes. */
const MAX_LINE = 64 * 1024;

const LF = 0x0a;
const EMPTY = Buffer.alloc(0);

/**
 * The primary's commands have no bulk limit (spec 9.13, steady state 2), but no bulk can be
 * longer than the longest string V8 can make, so a bigger length is still a protocol error.
 */
const PRIMARY_LIMITS = {
  maxBulkLen: () => bufferConstants.MAX_STRING_LENGTH,
  authRequired: () => false,
};

/** Replies to PING that still let the handshake go on: AUTH comes next (Redis's syncWithMaster). */
const PING_ERRORS_ALLOWED = /^-(NOAUTH|NOPERM|ERR operation not permitted)/;

export class PrimaryLink {
  /** The primary we follow; '' and 0 while we're a primary. */
  host = '';
  port = 0;
  state: LinkState = 'none';

  private socket: Socket | null = null;
  private step: HandshakeStep = 'ping';
  /** Handshake bytes not yet read as lines. */
  private input: Buffer = EMPTY;
  private sync: FullSync | null = null;
  /** The primary's connection as a client, once streaming. */
  private client: Client | null = null;
  /** Stream bytes received and not yet applied (latin1), from `rawPos` on. */
  private raw = '';
  private rawPos = 0;
  /** Bytes of commands run since the last commit: a transaction's, until its EXEC. */
  private uncommitted = 0;
  /**
   * The db the stream was in when the link was lost. A partial resync resends no SELECT, so the
   * new link client starts there, as Redis keeps its cached master client.
   */
  private streamDb = 0;
  /** Unix ms of the last bytes from the primary during the handshake and the payload. */
  private lastIo = 0;
  /** Unix ms the streaming link was lost; 0 if it has never been up. */
  private downSince = 0;
  private lastCron = 0;
  private stopped = false;

  constructor(private readonly server: Server) {}

  get connected(): boolean {
    return this.state === 'connected';
  }

  // --- REPLICAOF ------------------------------------------------------------------------

  /** REPLICAOF host port, or `replicaof` at startup: follow this primary from now on. */
  setPrimary(host: string, port: number): void {
    const server = this.server;
    const wasPrimary = server.role === 'primary';
    this.dropLink();
    // A primary continues its own history: its stream's db is where that history left off.
    if (wasPrimary) this.streamDb = server.repl.streamDb;
    server.role = 'replica';
    this.host = host;
    this.port = port;
    this.downSince = 0;
    server.config.setInternal('replicaof', { host, port });
    // Spec 9.13 Promotion, step 3: our replicas must sync again, from the primary we follow.
    if (server.snapshotJob?.kind === 'fullsync') {
      server.snapshotJob.abort('this server is becoming a replica');
    }
    server.repl.disconnectReplicas();
    if (wasPrimary && server.repl.backlog !== null) {
      server.log.notice(
        'Before turning into a replica, using my own master parameters to synthesize a cached master: I may be able to synchronize with the new master with just a partial transfer.',
      );
    }
    this.connect();
  }

  /**
   * REPLICAOF NO ONE (spec 9.13 Promotion, step 1): close the link, keep the data, and become a
   * primary whose history continues the one shared with the old primary's other replicas.
   */
  unsetPrimary(): void {
    const server = this.server;
    if (server.role !== 'replica') return;
    this.dropLink();
    this.state = 'none';
    this.host = '';
    this.port = 0;
    server.role = 'primary';
    server.config.setInternal('replicaof', null);
    server.repl.shiftReplid();
  }

  /** Shutdown: close the link and never reconnect. */
  stop(): void {
    this.stopped = true;
    this.dropLink();
  }

  // --- the connection -------------------------------------------------------------------

  private connect(): void {
    const server = this.server;
    server.log.notice(`Connecting to MASTER ${this.host}:${this.port}`);
    const socket = net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    this.state = 'connecting';
    this.input = EMPTY;
    this.lastIo = Date.now();
    socket.setNoDelay(true);
    const keepalive = server.config.get('tcp-keepalive');
    if (keepalive > 0) socket.setKeepAlive(true, keepalive * 1000);
    server.log.notice('MASTER <-> REPLICA sync started');
    socket.on('connect', () => {
      if (this.socket !== socket) return;
      server.log.notice('Non blocking connect for SYNC fired the event.');
      this.state = 'handshake';
      this.lastIo = Date.now();
      this.send(['PING'], 'ping');
    });
    socket.on('data', (chunk: Buffer) => {
      if (this.socket === socket) this.onData(chunk);
    });
    let errored = false;
    socket.on('error', (e) => {
      if (this.socket !== socket) return;
      errored = true;
      server.log.warning(`Error condition on socket for SYNC: ${e.message}`);
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      const client = this.client;
      // Streaming: the client goes the way every client goes, and linkLost reconnects.
      if (client !== null) server.killClient(client);
      else this.fail(errored ? null : 'Master closed the connection before the sync finished');
    });
  }

  /** Closes whatever connection there is to the primary, with no reconnect. */
  private dropLink(): void {
    const client = this.client;
    const socket = this.socket;
    this.client = null;
    this.socket = null;
    this.sync = null;
    this.input = EMPTY;
    this.raw = '';
    this.rawPos = 0;
    this.uncommitted = 0;
    // linkLost ignores the client: it's no longer ours.
    if (client !== null) this.server.killClient(client);
    else socket?.destroy();
  }

  /** The handshake or the payload failed: drop it, and serverCron retries within a second. */
  private fail(message: string | null): void {
    if (message !== null) this.server.log.warning(message);
    this.dropLink();
    this.state = this.server.role === 'replica' && !this.stopped ? 'connect' : 'none';
  }

  /**
   * The primary-link client is gone (the socket closed, CLIENT KILL, a timeout, a protocol
   * error). What we applied stays ours, so we reconnect at once and PSYNC from it.
   */
  linkLost(client: Client): void {
    if (this.client !== client) return;
    this.client = null;
    this.streamDb = client.db;
    this.dropLink();
    this.downSince = Date.now();
    const log = this.server.log;
    log.notice('Connection with master lost.');
    log.notice('Caching the disconnected master state.');
    if (this.stopped || this.server.role !== 'replica') {
      this.state = 'none';
      return;
    }
    log.notice(`Reconnecting to MASTER ${this.host}:${this.port}`);
    this.connect();
  }

  private send(argv: readonly string[], next: HandshakeStep): void {
    this.step = next;
    this.socket!.write(Buffer.from(encodeCommand(argv), 'latin1'));
  }

  private onData(chunk: Buffer): void {
    this.lastIo = Date.now();
    if (this.client !== null) {
      this.applyStream(chunk);
      return;
    }
    if (this.sync !== null && this.sync.size >= 0) {
      this.readPayload(chunk);
      return;
    }
    this.input = this.input.length === 0 ? chunk : Buffer.concat([this.input, chunk]);
    this.readLines();
  }

  /** Handshake replies and the `$<len>` line, one at a time; what follows them is passed on. */
  private readLines(): void {
    while (this.socket !== null && this.client === null) {
      if (this.sync !== null && this.sync.size >= 0) {
        const rest = this.input;
        this.input = EMPTY;
        if (rest.length > 0) this.readPayload(rest);
        return;
      }
      const input = this.input;
      // Keepalive newlines (spec 9.13 Full sync, step 1) come on their own, before a line.
      let start = 0;
      while (start < input.length && input[start] === LF) start++;
      const end = input.indexOf('\r\n', start, 'latin1');
      if (end === -1) {
        this.input = input.subarray(start);
        if (this.input.length > MAX_LINE) this.fail('Bad protocol from MASTER: line too long');
        return;
      }
      this.input = input.subarray(end + 2);
      this.onLine(input.toString('latin1', start, end));
    }
  }

  // --- the handshake (spec 9.13 Handshake) ------------------------------------------------

  private onLine(line: string): void {
    if (this.sync !== null) {
      this.onPayloadHeader(line);
      return;
    }
    const config = this.server.config;
    const log = this.server.log;
    switch (this.step) {
      case 'ping':
        if (line.startsWith('-') && !PING_ERRORS_ALLOWED.test(line)) {
          this.fail(`Error reply to PING from master: '${line}'`);
          return;
        }
        log.notice('Master replied to PING, replication can continue...');
        if (config.get('masterauth') !== '') this.send(['AUTH', config.get('masterauth')], 'auth');
        else this.sendListeningPort();
        return;
      case 'auth':
        if (line.startsWith('-')) {
          this.fail(`Unable to AUTH to MASTER: ${line}`);
          return;
        }
        this.sendListeningPort();
        return;
      case 'port':
        if (line.startsWith('-')) {
          log.notice(`(Non critical) Master does not understand REPLCONF listening-port: ${line}`);
        }
        this.send(['REPLCONF', 'capa', 'psync2'], 'capa');
        return;
      case 'capa':
        if (line.startsWith('-')) {
          log.notice(`(Non critical) Master does not understand REPLCONF capa: ${line}`);
        }
        this.sendPsync();
        return;
      case 'psync':
        this.onPsyncReply(line);
        return;
    }
  }

  private sendListeningPort(): void {
    this.send(['REPLCONF', 'listening-port', String(this.server.port)], 'port');
  }

  private sendPsync(): void {
    const [replid, offset] = this.server.repl.psyncArgs();
    if (replid === '?') {
      this.server.log.notice('Partial resynchronization not possible (no cached master)');
    } else {
      this.server.log.notice(`Trying a partial resynchronization (request ${replid}:${offset}).`);
    }
    this.send(['PSYNC', replid, offset], 'psync');
  }

  private onPsyncReply(line: string): void {
    const server = this.server;
    const log = server.log;
    if (line.startsWith('+FULLRESYNC')) {
      const [, replid, offsetArg] = line.split(' ');
      const offset = offsetArg === undefined ? null : parseInt64(offsetArg);
      if (replid === undefined || replid.length !== 40 || offset === null || offset < 0n) {
        this.fail('Master replied with wrong +FULLRESYNC syntax.');
        return;
      }
      log.notice(`Full resync from master: ${replid}:${offset}`);
      this.sync = { replid, offset: Number(offset), size: -1, chunks: [], received: 0 };
      this.state = 'sync';
      return;
    }
    if (line.startsWith('+CONTINUE')) {
      // Spec 9.13 Partial sync: a new ID means the primary was promoted; ours becomes replid2.
      const replid = line.slice('+CONTINUE'.length).trim();
      log.notice('Successful partial resynchronization with master.');
      if (replid.length === 40 && replid !== server.repl.replid) {
        log.notice(`Master replication ID changed to ${replid}`);
        server.repl.shiftReplid(replid);
      }
      log.notice('MASTER <-> REPLICA sync: Master accepted a Partial Resynchronization.');
      this.startStreaming(this.takeInput(), this.streamDb);
      return;
    }
    if (line.startsWith('-NOMASTERLINK') || line.startsWith('-LOADING')) {
      this.fail(`Master is currently unable to PSYNC but should be in the future: ${line}`);
      return;
    }
    this.fail(`Unexpected reply to PSYNC from master: ${line}`);
  }

  // --- full sync (spec 9.13 Full sync, step 3) ------------------------------------------

  private onPayloadHeader(line: string): void {
    if (line.startsWith('-')) {
      this.fail(`MASTER aborted replication with an error: ${line.slice(1)}`);
      return;
    }
    if (!line.startsWith('$')) {
      this.fail(
        `Bad protocol from MASTER, the first byte is not '$' (we received '${line}'), are you sure the host and port are right?`,
      );
      return;
    }
    // We never send `capa eof`, so a primary must not send the diskless `$EOF:` form.
    const size = parseInt64(line.slice(1));
    if (size === null || size < 0n || size > BigInt(bufferConstants.MAX_LENGTH)) {
      this.fail(`Bad protocol from MASTER, invalid payload length: '${line}'`);
      return;
    }
    this.server.log.notice(
      `MASTER <-> REPLICA sync: receiving ${size} bytes from master to memory`,
    );
    this.sync!.size = Number(size);
  }

  /** Collects the payload as it arrives (never allocated up front: rule 11), then loads it. */
  private readPayload(chunk: Buffer): void {
    const sync = this.sync!;
    const need = sync.size - sync.received;
    const part = chunk.length <= need ? chunk : chunk.subarray(0, need);
    sync.chunks.push(part);
    sync.received += part.length;
    if (sync.received < sync.size) return;
    this.loadPayload(sync, Buffer.concat(sync.chunks, sync.size), chunk.subarray(part.length));
  }

  /**
   * Checks the payload and loads it into fresh databases, swaps them in, and takes the primary's
   * history from `+FULLRESYNC`. A bad payload changes nothing: the link drops and syncs again.
   */
  private loadPayload(sync: FullSync, payload: Buffer, rest: Buffer): void {
    const server = this.server;
    const log = server.log;
    this.sync = null;
    log.notice('MASTER <-> REPLICA sync: Loading DB in memory');
    let loaded: LoadedSnapshot;
    try {
      // Expired keys too: the primary sends their DELs (spec 9.3).
      loaded = readSnapshot(server, payload, { now: null });
    } catch (e) {
      if (!(e instanceof SnapshotLoadError)) throw e;
      this.fail(`Failed trying to load the MASTER synchronization DB from socket: ${e.message}`);
      return;
    }
    // A job's point in time is about to be replaced (spec 9.8, Lifecycle step 4).
    server.snapshotJob?.abort('a full sync from the primary');
    // The AOF holds the old dataset: as Redis's restartAOFAfterSYNC, rewrite it from the new one.
    const aofOn = server.aofState !== 'off';
    if (aofOn) stopAppendOnly(server);
    installSnapshot(server, loaded);
    server.repl.setPrimaryHistory(sync.replid, sync.offset);
    if (aofOn) startAppendOnly(server);
    log.notice(
      `Done loading snapshot, keys loaded: ${loaded.keys}, keys expired: ${loaded.expired}.`,
    );
    log.notice('MASTER <-> REPLICA sync: Finished with success');
    // The stream after +FULLRESYNC starts with a SELECT.
    this.startStreaming(rest, 0);
  }

  private takeInput(): Buffer {
    const rest = this.input;
    this.input = EMPTY;
    return rest;
  }

  // --- the stream (spec 9.13 Steady state) ------------------------------------------------

  /** The socket becomes the primary-link client, in `db`; `rest` is the stream's first bytes. */
  private startStreaming(rest: Buffer, db: number): void {
    const client = this.server.registerClient(this.socket!, PRIMARY_LIMITS);
    client.primaryLink = true;
    client.db = db;
    this.client = client;
    this.state = 'connected';
    this.raw = '';
    this.rawPos = 0;
    this.uncommitted = 0;
    if (rest.length > 0) this.applyStream(rest);
  }

  /** Runs every complete command, then commits its bytes to the offset and the backlog. */
  private applyStream(chunk: Buffer): void {
    const server = this.server;
    const client = this.client!;
    client.lastInteraction = Date.now();
    client.parser.feed(chunk);
    this.raw += chunk.toString('latin1');
    try {
      while (this.client === client) {
        const cmd = client.parser.next();
        if (cmd === null) break;
        this.uncommitted += cmd.bytes;
        if (cmd.argv.length > 0) dispatch(server, client, cmd.argv);
        // The primary never gets a reply (GETACK's ACK is written straight to the socket).
        client.reply.take();
        // A transaction counts once its EXEC has run.
        if (!client.multi) this.commit();
      }
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      server.log.warning(`Protocol error (${e.message}) from MASTER: ${client.describe()}`);
      server.killClient(client);
      return;
    }
    if (this.client === client && this.rawPos > 0) {
      this.raw = this.raw.slice(this.rawPos);
      this.rawPos = 0;
    }
  }

  /** The bytes of the commands just applied, unchanged, into our offset and backlog (spec 9.5). */
  private commit(): void {
    const n = this.uncommitted;
    if (n === 0) return;
    this.uncommitted = 0;
    const bytes = this.raw.slice(this.rawPos, this.rawPos + n);
    this.rawPos += n;
    this.server.repl.feedFromPrimary(bytes);
  }

  /** `REPLCONF ACK <offset>`: the offset of the last byte applied (spec 9.13 Steady state 3). */
  sendAck(): void {
    const client = this.client;
    if (client === null || client.closed) return;
    const offset = String(this.server.repl.masterReplOffset);
    client.socket!.write(Buffer.from(encodeCommand(['REPLCONF', 'ACK', offset]), 'latin1'));
  }

  // --- chores ---------------------------------------------------------------------------

  /** serverCron, once a second: retry the link, time it out, ACK (spec 9.13 Steady state 3–4). */
  cron(now: number = Date.now()): void {
    if (this.server.role !== 'replica' || this.stopped) return;
    if (now - this.lastCron < 1000) return;
    this.lastCron = now;
    const timeoutMs = this.server.config.get('repl-timeout') * 1000;
    switch (this.state) {
      case 'connect':
        this.connect();
        return;
      case 'connecting':
      case 'handshake':
        if (now - this.lastIo > timeoutMs) this.fail('Timeout connecting to the MASTER...');
        return;
      case 'sync':
        if (now - this.lastIo > timeoutMs) {
          this.fail(
            "Timeout receiving bulk data from MASTER... If the problem persists try to set the 'repl-timeout' parameter in miniredis.conf to a larger value.",
          );
        }
        return;
      case 'connected': {
        const client = this.client!;
        if (now - client.lastInteraction > timeoutMs) {
          this.server.log.warning('MASTER timeout: no data nor PING received...');
          this.server.killClient(client);
          return;
        }
        this.sendAck();
        return;
      }
      case 'none':
        return;
    }
  }

  // --- reporting --------------------------------------------------------------------------

  /** INFO's replica fields, after `role:slave` (spec 13.1). */
  infoFields(now: number): Array<[string, string | number]> {
    const up = this.state === 'connected';
    const offset = this.server.repl.masterReplOffset;
    const fields: Array<[string, string | number]> = [
      ['master_host', this.host],
      ['master_port', this.port],
      ['master_link_status', up ? 'up' : 'down'],
      [
        'master_last_io_seconds_ago',
        up ? Math.floor((now - this.client!.lastInteraction) / 1000) : -1,
      ],
      ['master_sync_in_progress', this.state === 'sync' ? 1 : 0],
      // Read includes what arrived but hasn't run yet (an open transaction).
      ['slave_read_repl_offset', offset + (up ? this.raw.length - this.rawPos : 0)],
      ['slave_repl_offset', offset],
    ];
    const sync = this.sync;
    if (this.state === 'sync' && sync !== null && sync.size >= 0) {
      fields.push(
        ['master_sync_total_bytes', sync.size],
        ['master_sync_read_bytes', sync.received],
        ['master_sync_left_bytes', sync.size - sync.received],
        ['master_sync_perc', ((sync.received * 100) / Math.max(sync.size, 1)).toFixed(2)],
        ['master_sync_last_io_seconds_ago', Math.floor((now - this.lastIo) / 1000)],
      );
    }
    if (!up) {
      fields.push([
        'master_link_down_since_seconds',
        this.downSince === 0 ? -1 : Math.floor((now - this.downSince) / 1000),
      ]);
    }
    fields.push(['slave_read_only', this.server.config.get('replica-read-only') ? 1 : 0]);
    return fields;
  }

  /** ROLE on a replica: `slave`, the primary, the link's state, and the offset while up. */
  roleReply(ctx: CommandContext): void {
    const reply = ctx.reply;
    reply.arrayLen(5);
    reply.bulk('slave');
    reply.bulk(this.host);
    reply.integer(this.port);
    reply.bulk(this.state);
    reply.integer(this.connected ? this.server.repl.masterReplOffset : -1);
  }
}
