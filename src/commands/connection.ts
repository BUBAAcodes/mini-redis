/**
 * Connection commands: PING, ECHO, QUIT, SELECT and CLIENT (ID, SETNAME, GETNAME, SETINFO,
 * KILL). HELLO, AUTH and the rest of CLIENT arrive in steps 22 and 23.
 *
 * Key design choice: these only touch the calling client's own state, never the keyspace, so
 * none is a write and none propagates. QUIT doesn't close the socket itself: it sets
 * closeAfterReply, so its +OK goes out in the same beforeSleep write as every reply before it.
 *
 * CLIENT KILL is the exception: it closes other connections, through Server.killClient. A
 * client killing itself still gets its reply first (closeAfterReply), as in Redis.
 *
 * Mirrors Redis server.c (pingCommand, echoCommand), db.c (selectCommand) and networking.c
 * (clientCommand, clientSetNameOrReply, clientSetinfoCommand, clientKillCommand,
 * getClientType, getClientTypeByName).
 */
import { ERR, ReplyError, wrongArity } from '../protocol/errors.js';
import { parseInt64 } from '../utils/numbers.js';
import { inSubscriberMode } from '../pubsub/hub.js';
import type { Client } from '../server/client.js';
import { command, containerOnly } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';

export function pingCommand(ctx: CommandContext): void {
  // Arity is -1 so that subscriber mode can accept PING; more than one arg is still an arity
  // error.
  if (ctx.argv.length > 2) throw new ReplyError(wrongArity('ping'));
  // A RESP2 subscriber can't tell a +PONG from a message, so it gets an array (spec 9.11).
  if (inSubscriberMode(ctx.client)) ctx.reply.array(['pong', ctx.argv[1] ?? '']);
  else if (ctx.argv.length === 1) ctx.reply.simple('PONG');
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

/** The class a client counts as, for CLIENT KILL TYPE and the output limits (step 22). */
export type ClientType = 'normal' | 'replica' | 'pubsub' | 'master';

/** Redis's getClientType; `master` (the link to our primary) arrives with step 21. */
export function clientType(client: Client): ClientType {
  if (client.repl !== null) return 'replica';
  if (client.channels.size + client.patterns.size > 0) return 'pubsub';
  return 'normal';
}

const CLIENT_TYPES: Readonly<Record<string, ClientType>> = {
  normal: 'normal',
  replica: 'replica',
  slave: 'replica',
  pubsub: 'pubsub',
  master: 'master',
};

/** Closes `target`; the caller itself gets its reply first. */
function kill(ctx: CommandContext, target: Client): void {
  if (target === ctx.client) target.closeAfterReply = true;
  else ctx.server.killClient(target);
}

/**
 * `CLIENT KILL ip:port` (the old form: +OK or an error), or `CLIENT KILL <filter> <value> …`
 * with ID, ADDR, LADDR, TYPE and SKIPME (the caller is skipped unless SKIPME no): the number
 * killed. Every filter is checked before any client is touched (rule 4).
 */
export function clientKillCommand(ctx: CommandContext): void {
  const { argv, server } = ctx;
  if (argv.length === 3) {
    const target = [...server.clients.values()].find((c) => c.addr === argv[2]);
    if (target === undefined) throw new ReplyError('ERR No such client');
    kill(ctx, target);
    ctx.reply.ok();
    return;
  }
  if (argv.length % 2 !== 0) throw new ReplyError(ERR.SYNTAX);
  let id: number | null = null;
  let type: ClientType | null = null;
  let addr: string | null = null;
  let laddr: string | null = null;
  let skipme = true;
  for (let i = 2; i < argv.length; i += 2) {
    const value = argv[i + 1]!;
    switch (argv[i]!.toLowerCase()) {
      case 'id': {
        const n = parseInt64(value);
        if (n === null || n <= 0n) throw new ReplyError('ERR client-id should be greater than 0');
        id = Number(n);
        break;
      }
      case 'type': {
        const t = Object.hasOwn(CLIENT_TYPES, value.toLowerCase())
          ? CLIENT_TYPES[value.toLowerCase()]!
          : undefined;
        if (t === undefined) throw new ReplyError(`ERR Unknown client type '${value}'`);
        type = t;
        break;
      }
      case 'addr':
        addr = value;
        break;
      case 'laddr':
        laddr = value;
        break;
      case 'skipme': {
        const v = value.toLowerCase();
        if (v !== 'yes' && v !== 'no') throw new ReplyError(ERR.SYNTAX);
        skipme = v === 'yes';
        break;
      }
      default:
        throw new ReplyError(ERR.SYNTAX);
    }
  }
  let killed = 0;
  for (const c of [...server.clients.values()]) {
    if (id !== null && c.id !== id) continue;
    if (type !== null && clientType(c) !== type) continue;
    if (addr !== null && c.addr !== addr) continue;
    if (laddr !== null && c.laddr !== laddr) continue;
    if (skipme && c === ctx.client) continue;
    kill(ctx, c);
    killed++;
  }
  ctx.reply.integer(killed);
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
    command('client|kill', -3, ['admin', 'stale'], [0, 0, 0], clientKillCommand),
  ]),
];
