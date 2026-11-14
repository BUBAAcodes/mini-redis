/**
 * Per-connection state (spec 6.1 Client): identity, selected db, protocol version, its own
 * request parser, and its output queue.
 *
 * Key design choice: the output queue is the client's `Reply`. Handlers append to it, and only
 * beforeSleep turns it into socket writes, once per event-loop turn. So a pipeline of a
 * thousand commands that arrived in one chunk leaves in one write, and replies stay in the
 * order the commands came in (rule 12). A replica (step 20) is a client that sent PSYNC: its
 * `repl` link holds its state and its own output queue, since it never gets ordinary replies.
 *
 * The AOF loader runs its commands on a client with no socket (Redis's fake client,
 * CLIENT_ID_AOF): it is never registered with the server, its replies are thrown away, and it
 * can never block. On a replica, the link to the primary is a client too (`primaryLink`,
 * Redis's CLIENT_MASTER): obeyed like the AOF loader, never answered, never blocked.
 *
 * Mirrors Redis networking.c (createClient, freeClient) and the client struct in server.h.
 */
import type { Socket } from 'node:net';
import type { BlockState } from '../blocking/waiters.js';
import type { CommandSpec } from '../commands/command.js';
import { Reply } from '../protocol/encoder.js';
import type { RespVersion } from '../protocol/encoder.js';
import { RespParser } from '../protocol/parser.js';
import type { ParserLimits } from '../protocol/parser.js';
import type { ReplicaLink, WaitState } from '../replication/primary.js';
import type { WatchedKey } from '../storage/watch.js';

/** A command waiting for EXEC: already looked up and checked, so EXEC only has to run it. */
export interface QueuedCommand {
  readonly spec: CommandSpec;
  readonly argv: readonly string[];
}

export class Client {
  readonly addr: string;
  readonly laddr: string;
  readonly parser: RespParser;
  /** The output queue: replies waiting for beforeSleep. */
  readonly reply = new Reply(2);
  /** CLIENT SETNAME; '' means no name. */
  name = '';
  libName = '';
  libVer = '';
  /** Index of the selected database. */
  db = 0;
  /**
   * False from connecting until AUTH (or HELLO ... AUTH) succeeds, while `requirepass` is set;
   * Server.accept sets it. Clients with no socket and the primary link are always trusted.
   */
  authenticated = true;
  /** Set by QUIT and protocol errors: send what's queued, then close; read nothing more. */
  closeAfterReply = false;
  /** The socket is gone; nothing more is written. */
  closed = false;
  readonly createdAt = Date.now();
  lastInteraction = this.createdAt;
  /** Full name of the last command run, e.g. 'client|setname', for CLIENT LIST. */
  lastCommand = '';

  /** Between MULTI and EXEC or DISCARD (and while EXEC runs the queue, as in Redis). */
  multi = false;
  /** A watched key changed: EXEC must reply with a null array. */
  dirtyCas = false;
  /** A command failed its checks while queueing: EXEC must reply with EXECABORT. */
  dirtyExec = false;
  queued: QueuedCommand[] = [];
  /** This client's WATCH entries; the other half of the registry is in each Db. */
  watchedKeys: WatchedKey[] = [];

  /** Channels and patterns this client subscribes to; the hub holds the other half. */
  readonly channels = new Set<string>();
  readonly patterns = new Set<string>();

  /** What a blocked BLPOP, BRPOP or BLMOVE waits for; the keys' FIFOs are in its Db. */
  bstate: BlockState | null = null;
  /** What a blocked WAIT waits for (spec 9.13). */
  bwait: WaitState | null = null;

  /** The replication offset after this client's last command that propagated, for WAIT. */
  woff = 0;
  /** REPLCONF listening-port and capa psync2, sent before PSYNC. */
  replListeningPort = 0;
  replCapaPsync2 = false;
  /** Set by PSYNC: this connection is a replica (spec 9.2). */
  repl: ReplicaLink | null = null;
  /**
   * On a replica, the connection to its primary once the handshake is done (Redis's
   * CLIENT_MASTER): its commands are obeyed without the checks a user gets, and never answered.
   */
  primaryLink = false;
  /** When its output first passed its class's soft limit; 0 while under it. */
  softLimitSince = 0;

  /** `socket` is null only for the AOF loader's client. */
  constructor(
    readonly id: number,
    readonly socket: Socket | null,
    limits: ParserLimits,
  ) {
    this.addr = socket === null ? '' : `${socket.remoteAddress}:${socket.remotePort}`;
    this.laddr = socket === null ? '' : `${socket.localAddress}:${socket.localPort}`;
    this.parser = new RespParser(limits);
  }

  /** The AOF loader's client. */
  get isAofClient(): boolean {
    return this.socket === null;
  }

  /**
   * Obeyed without the checks a user gets (OOM, MISCONF, READONLY, subscriber mode): the AOF
   * loader and a replica's primary link, whose commands already ran on the primary.
   */
  get obeyed(): boolean {
    return this.socket === null || this.primaryLink;
  }

  /**
   * A blocking command must answer at once instead of waiting: inside a transaction, and for
   * the AOF loader and the primary link, where a wait could never end (CLIENT_DENY_BLOCKING).
   */
  get denyBlocking(): boolean {
    return this.multi || this.obeyed;
  }

  get resp(): RespVersion {
    return this.reply.resp;
  }

  /** Parked by a blocking command or WAIT: its later input waits in the parser (spec 9.2). */
  get blocked(): boolean {
    return this.bstate !== null || this.bwait !== null;
  }

  /** For log lines about one client, like Redis's catClientInfoString (shortened). */
  describe(): string {
    return `id=${this.id} addr=${this.addr} laddr=${this.laddr} name=${this.name}`;
  }
}
