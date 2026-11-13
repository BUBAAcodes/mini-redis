/**
 * Connection commands: PING, ECHO, QUIT, SELECT and CLIENT (ID, SETNAME, GETNAME, SETINFO).
 * HELLO, AUTH and the rest of CLIENT arrive in steps 22 and 23.
 *
 * Key design choice: these only touch the calling client's own state, never the keyspace, so
 * none is a write and none propagates. QUIT doesn't close the socket itself: it sets
 * closeAfterReply, so its +OK goes out in the same beforeSleep write as every reply before it.
 *
 * Mirrors Redis server.c (pingCommand, echoCommand), db.c (selectCommand) and networking.c
 * (clientCommand, clientSetNameOrReply, clientSetinfoCommand).
 */
import { ERR, ReplyError, wrongArity } from '../protocol/errors.js';
import { parseInt64 } from '../utils/numbers.js';
import { command, containerOnly } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';

export function pingCommand(ctx: CommandContext): void {
  // Arity is -1 so that subscriber mode (step 17) can accept PING; more than one arg is still
  // an arity error.
  if (ctx.argv.length > 2) throw new ReplyError(wrongArity('ping'));
  if (ctx.argv.length === 1) ctx.reply.simple('PONG');
  else ctx.reply.bulk(ctx.argv[1]!);
}

export function echoCommand(ctx: CommandContext): void {
  ctx.reply.bulk(ctx.argv[1]!);
}

export function quitCommand(ctx: CommandContext): void {
  ctx.reply.ok();
  ctx.client.closeAfterReply = true;
}

export function selectCommand(ctx: CommandContext): void {
  const n = parseInt64(ctx.argv[1]!);
  if (n === null) throw new ReplyError(ERR.NOT_INTEGER);
  if (n < -(2n ** 31n) || n >= 2n ** 31n) throw new ReplyError(ERR.NOT_INT32);
  if (n < 0n || n >= BigInt(ctx.server.dbs.length)) throw new ReplyError(ERR.DB_INDEX_OUT_OF_RANGE);
  ctx.client.db = Number(n);
  ctx.reply.ok();
}

/**
 * Redis allows only '!' to '~' in client names and library info, so CLIENT LIST stays one
 * space-separated line. Like Redis's C loop, checking stops at a NUL byte.
 */
const validClientAttr = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return true;
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
};

export function clientIdCommand(ctx: CommandContext): void {
  ctx.reply.integer(ctx.client.id);
}

export function clientSetnameCommand(ctx: CommandContext): void {
  const name = ctx.argv[2]!;
  if (!validClientAttr(name))
    throw new ReplyError('ERR Client names cannot contain spaces, newlines or special characters.');
  ctx.client.name = name;
  ctx.reply.ok();
}

export function clientGetnameCommand(ctx: CommandContext): void {
  if (ctx.client.name === '') ctx.reply.nullBulk();
  else ctx.reply.bulk(ctx.client.name);
}

/** Client libraries send this on connect: CLIENT SETINFO LIB-NAME ioredis. */
export function clientSetinfoCommand(ctx: CommandContext): void {
  const attr = ctx.argv[2]!;
  const value = ctx.argv[3]!;
  const which = attr.toLowerCase();
  if (which !== 'lib-name' && which !== 'lib-ver')
    throw new ReplyError(`ERR Unrecognized option '${attr}'`);
  if (!validClientAttr(value))
    throw new ReplyError(`ERR ${attr} cannot contain spaces, newlines or special characters.`);
  if (which === 'lib-name') ctx.client.libName = value;
  else ctx.client.libVer = value;
  ctx.reply.ok();
}

export const connectionCommands: CommandSpec[] = [
  command('ping', -1, [], [0, 0, 0], pingCommand),
  command('echo', 2, [], [0, 0, 0], echoCommand),
  command('quit', -1, ['noauth'], [0, 0, 0], quitCommand),
  command('select', 2, ['stale'], [0, 0, 0], selectCommand),
  command('client', -2, [], [0, 0, 0], containerOnly, [
    command('client|id', 2, ['stale'], [0, 0, 0], clientIdCommand),
    command('client|setname', 3, ['stale'], [0, 0, 0], clientSetnameCommand),
    command('client|getname', 2, ['stale'], [0, 0, 0], clientGetnameCommand),
    command('client|setinfo', 4, ['stale'], [0, 0, 0], clientSetinfoCommand),
  ]),
];
