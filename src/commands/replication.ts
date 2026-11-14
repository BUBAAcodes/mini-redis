/**
 * Replication commands (spec 8.10): PSYNC, REPLCONF, WAIT and ROLE for the primary side, and
 * REPLICAOF (alias SLAVEOF) for the replica side.
 *
 * Key design choice: these handlers only parse and check their arguments, then hand over to
 * replication/primary.ts, which owns the replicas' sockets and the stream, or to
 * replication/replica.ts, which owns the link to our primary (commands never touch sockets,
 * spec 4). Replies and error strings are Redis 7.4's, checked against the reference; REPLCONF
 * ACK and GETACK never reply, since neither side of a link may get one. A replica refuses
 * PSYNC: chained replicas are out of scope (docs/DIFFERENCES.md).
 *
 * Mirrors Redis replication.c (syncCommand, replconfCommand, waitCommand, roleCommand,
 * replicaofCommand).
 */
import { ERR, ReplyError } from '../protocol/errors.js';
import { parseInt64 } from '../utils/numbers.js';
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';

const LLONG_MAX = 2n ** 63n - 1n;

const WAIT_ON_REPLICA =
  'ERR WAIT cannot be used with replica instances. Please also note that since Redis 4.0 if a replica is configured to be writable (which is not the default) writes to replicas are just local and are not propagated.';

/** `PSYNC replid offset`; on a primary the offset is checked first, as in Redis. */
export function psyncCommand(ctx: CommandContext): void {
  const server = ctx.server;
  if (server.role === 'replica') {
    if (!server.primaryLink.connected) {
      throw new ReplyError("NOMASTERLINK Can't SYNC while not connected with my master");
    }
    throw new ReplyError(
      'ERR MiniRedis does not support chained replication: connect to the primary instead',
    );
  }
  const offset = parseInt64(ctx.argv[2]!);
  if (offset === null) throw new ReplyError(ERR.NOT_INTEGER);
  ctx.server.repl.psync(ctx.client, ctx.argv[1]!, Number(offset));
}

/** `REPLCONF <option> <value> …`, options applied in order until one fails. */
export function replconfCommand(ctx: CommandContext): void {
  const { argv, client, server } = ctx;
  if (argv.length % 2 === 0) throw new ReplyError(ERR.SYNTAX);
  for (let i = 1; i < argv.length; i += 2) {
    const option = argv[i]!;
    const value = argv[i + 1]!;
    switch (option.toLowerCase()) {
      case 'listening-port': {
        const port = parseInt64(value);
        if (port === null) throw new ReplyError(ERR.NOT_INTEGER);
        client.replListeningPort = Number(port);
        break;
      }
      case 'capa':
        // psync2: the replica understands `+CONTINUE <replid>`. Others (eof) we don't use.
        if (value.toLowerCase() === 'psync2') client.replCapaPsync2 = true;
        break;
      case 'ack': {
        // Only from a replica, and never answered, even when the offset is garbage.
        const offset = parseInt64(value);
        if (offset !== null) server.repl.ack(client, Number(offset));
        return;
      }
      case 'getack':
        // A replica ACKs on its link to the primary, whoever asked, as Redis does; a primary
        // has nothing to say.
        if (server.role === 'replica') server.primaryLink.sendAck();
        return;
      default:
        throw new ReplyError(`ERR Unrecognized REPLCONF option: ${option}`);
    }
  }
  ctx.reply.ok();
}

/** `WAIT numreplicas timeout`, the timeout in milliseconds (0 = forever). */
export function waitCommand(ctx: CommandContext): void {
  if (ctx.server.role === 'replica') throw new ReplyError(WAIT_ON_REPLICA);
  const numreplicas = parseInt64(ctx.argv[1]!);
  if (numreplicas === null) throw new ReplyError(ERR.NOT_INTEGER);
  const timeout = parseInt64(ctx.argv[2]!);
  if (timeout === null) throw new ReplyError('ERR timeout is not an integer or out of range');
  if (timeout < 0n) throw new ReplyError(ERR.TIMEOUT_NEGATIVE);
  if (timeout > 0n && timeout > LLONG_MAX - BigInt(ctx.server.cmdTime)) {
    throw new ReplyError(ERR.TIMEOUT_OUT_OF_RANGE);
  }
  ctx.server.repl.wait(ctx, Number(numreplicas), Number(timeout));
}

export function roleCommand(ctx: CommandContext): void {
  ctx.server.repl.roleReply(ctx);
}

/**
 * `REPLICAOF host port` follows a primary; `REPLICAOF NO ONE` promotes this server (spec 9.13).
 * The work is in replication/replica.ts; this checks the arguments and logs who asked.
 */
export function replicaofCommand(ctx: CommandContext): void {
  const { argv, client, server } = ctx;
  const host = argv[1]!;
  const portArg = argv[2]!;
  const link = server.primaryLink;
  if (host.toLowerCase() === 'no' && portArg.toLowerCase() === 'one') {
    if (server.role === 'replica') {
      link.unsetPrimary();
      server.log.notice(`MASTER MODE enabled (user request from '${client.describe()}')`);
    }
    ctx.reply.ok();
    return;
  }
  // It would disconnect every replica, the caller included.
  if (client.repl !== null) {
    throw new ReplyError('ERR Command is not valid when client is a replica.');
  }
  const port = parseInt64(portArg);
  if (port === null || port < 0n || port > 65535n) throw new ReplyError('ERR Invalid master port');
  if (
    server.role === 'replica' &&
    link.host.toLowerCase() === host.toLowerCase() &&
    link.port === Number(port)
  ) {
    server.log.notice(
      'REPLICAOF would result into synchronization with the master we are already connected with. No operation performed.',
    );
    ctx.reply.simple('OK Already connected to specified master');
    return;
  }
  link.setPrimary(host, Number(port));
  server.log.notice(
    `REPLICAOF ${host}:${Number(port)} enabled (user request from '${client.describe()}')`,
  );
  ctx.reply.ok();
}

/** SLAVEOF, the old name (spec 7.6). */
export function slaveofCommand(ctx: CommandContext): void {
  replicaofCommand(ctx);
}

export const replicationCommands: CommandSpec[] = [
  command('replicaof', 3, ['admin', 'stale'], [0, 0, 0], replicaofCommand),
  command('slaveof', 3, ['admin', 'stale'], [0, 0, 0], slaveofCommand),
  command('psync', -3, ['admin', 'nomulti'], [0, 0, 0], psyncCommand),
  command('replconf', -1, ['admin', 'stale'], [0, 0, 0], replconfCommand),
  command('wait', 3, ['blocking'], [0, 0, 0], waitCommand),
  command('role', 1, ['stale'], [0, 0, 0], roleCommand),
];
