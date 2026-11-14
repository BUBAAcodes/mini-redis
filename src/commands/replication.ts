/**
 * Replication commands, the primary side (spec 8.10): PSYNC, REPLCONF, WAIT and ROLE.
 * REPLICAOF and SLAVEOF arrive with the replica side in step 21.
 *
 * Key design choice: these handlers only parse and check their arguments, then hand over to
 * replication/primary.ts, which owns the replicas' sockets and the stream (commands never touch
 * sockets, spec 4). Replies and error strings are Redis 7.4's, checked against the reference;
 * REPLCONF ACK and GETACK never reply, since a replica must never get one.
 *
 * Mirrors Redis replication.c (syncCommand, replconfCommand, waitCommand, roleCommand).
 */
import { ERR, ReplyError } from '../protocol/errors.js';
import { parseInt64 } from '../utils/numbers.js';
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';

const LLONG_MAX = 2n ** 63n - 1n;

/** `PSYNC replid offset`; the offset is checked before anything else, as in Redis. */
export function psyncCommand(ctx: CommandContext): void {
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
        // A replica answers it with an ACK (step 21); on a primary it means nothing.
        return;
      default:
        throw new ReplyError(`ERR Unrecognized REPLCONF option: ${option}`);
    }
  }
  ctx.reply.ok();
}

/** `WAIT numreplicas timeout`, the timeout in milliseconds (0 = forever). */
export function waitCommand(ctx: CommandContext): void {
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

export const replicationCommands: CommandSpec[] = [
  command('psync', -3, ['admin', 'nomulti'], [0, 0, 0], psyncCommand),
  command('replconf', -1, ['admin', 'stale'], [0, 0, 0], replconfCommand),
  command('wait', 3, ['blocking'], [0, 0, 0], waitCommand),
  command('role', 1, ['stale'], [0, 0, 0], roleCommand),
];
