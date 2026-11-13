/**
 * Per-connection state (spec 6.1 Client): identity, selected db, protocol version, its own
 * request parser, and its output queue.
 *
 * Key design choice: the output queue is the client's `Reply`. Handlers append to it, and only
 * beforeSleep turns it into socket writes, once per event-loop turn. So a pipeline of a
 * thousand commands that arrived in one chunk leaves in one write, and replies stay in the
 * order the commands came in (rule 12). Later steps add the MULTI, pub/sub, blocking, monitor
 * and replica fields here.
 *
 * Mirrors Redis networking.c (createClient, freeClient) and the client struct in server.h.
 */
import type { Socket } from 'node:net';
import { Reply } from '../protocol/encoder.js';
import type { RespVersion } from '../protocol/encoder.js';
import { RespParser } from '../protocol/parser.js';
import type { ParserLimits } from '../protocol/parser.js';

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
  /** AUTH arrives in step 22; until then every client counts as authenticated. */
  authenticated = true;
  /** Set by QUIT and protocol errors: send what's queued, then close; read nothing more. */
  closeAfterReply = false;
  /** The socket is gone; nothing more is written. */
  closed = false;
  readonly createdAt = Date.now();
  lastInteraction = this.createdAt;
  /** Full name of the last command run, e.g. 'client|setname', for CLIENT LIST. */
  lastCommand = '';

  constructor(
    readonly id: number,
    readonly socket: Socket,
    limits: ParserLimits,
  ) {
    this.addr = `${socket.remoteAddress}:${socket.remotePort}`;
    this.laddr = `${socket.localAddress}:${socket.localPort}`;
    this.parser = new RespParser(limits);
  }

  get resp(): RespVersion {
    return this.reply.resp;
  }

  /** For log lines about one client, like Redis's catClientInfoString (shortened). */
  describe(): string {
    return `id=${this.id} addr=${this.addr} laddr=${this.laddr} name=${this.name}`;
  }
}
