/**
 * Connection commands: PING, ECHO, QUIT, SELECT, AUTH, HELLO, RESET and CLIENT (ID, SETNAME,
 * GETNAME, SETINFO, KILL, LIST, INFO).
 *
 * Key design choice: these only touch the calling client's own state, never the keyspace, so
 * none is a write and none propagates. QUIT doesn't close the socket itself: it sets
 * closeAfterReply, so its +OK goes out in the same beforeSleep write as every reply before it.
 *
 * AUTH and HELLO ... AUTH share one password check: both sides are hashed with SHA-256 and the
 * digests compared with timingSafeEqual, so neither the length nor any prefix of the password
 * shows in the time it takes (spec 12). We have no ACL users: "default" is the only one, and
 * with no `requirepass` it accepts any password, as Redis's `nopass` default user does.
 *
 * CLIENT KILL is the exception: it closes other connections, through Server.killClient. A
 * client killing itself still gets its reply first (closeAfterReply), as in Redis.
 *
 * Mirrors Redis server.c (pingCommand, echoCommand, helloCommand, resetCommand,
 * clearClientConnectionState), db.c (selectCommand), acl.c (authCommand, ACLAuthenticateUser)
 * and networking.c (clientCommand, clientSetNameOrReply, clientSetinfoCommand,
 * clientKillCommand, getClientType, getClientTypeByName).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { ERR, ReplyError, wrongArity } from '../protocol/errors.js';
import { clientInfoLine } from '../observability/client-info.js';
import { REDIS_VERSION } from '../server/version.js';
import { discardTransaction } from './dispatch.js';
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

/** Throws unless `name` is a legal CLIENT SETNAME / HELLO SETNAME value. */
function checkClientName(name: string): void {
  if (!validClientAttr(name))
    throw new ReplyError('ERR Client names cannot contain spaces, newlines or special characters.');
}

export function clientSetnameCommand(ctx: CommandContext): void {
  const name = ctx.argv[2]!;
  checkClientName(name);
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

// ---------------------------------------------------------------- AUTH, HELLO, RESET

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'latin1').digest();

/**
 * True if `user` and `pass` get a client in. Both comparisons always run, so a wrong user name
 * takes as long as a wrong password.
 */
function credentialsOk(requirepass: string, user: string, pass: string): boolean {
  const userOk = user === 'default';
  const passOk = requirepass === '' || timingSafeEqual(sha256(pass), sha256(requirepass));
  return userOk && passOk;
}

export function authCommand(ctx: CommandContext): void {
  const { argv, client, server } = ctx;
  if (argv.length > 3) throw new ReplyError(ERR.SYNTAX);
  const requirepass = server.config.get('requirepass');
  // The one-word form has no user to blame: with no password set it's a mistake worth reporting.
  if (argv.length === 2 && requirepass === '') throw new ReplyError(ERR.AUTH_NOT_CONFIGURED);
  const user = argv.length === 3 ? argv[1]! : 'default';
  if (!credentialsOk(requirepass, user, argv[argv.length - 1]!))
    throw new ReplyError(ERR.WRONGPASS);
  client.authenticated = true;
  ctx.reply.ok();
}

const NOAUTH_HELLO =
  'NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time';

/**
 * `HELLO [2|3 [AUTH user pass] [SETNAME name]]`. Checked in the order the reference Redis 7.4
 * answers: version, option syntax, the name, the credentials, and only then is anything
 * changed. So a failing HELLO leaves the protocol, the name and the authentication as they
 * were (rule 4), and a bad name beats a wrong password.
 */
export function helloCommand(ctx: CommandContext): void {
  const { argv, client, server } = ctx;
  let ver: 2 | 3 | null = null;
  let next = 1;
  if (argv.length >= 2) {
    const n = parseInt64(argv[1]!);
    if (n === null) throw new ReplyError('ERR Protocol version is not an integer or out of range');
    if (n < 2n || n > 3n) throw new ReplyError(ERR.NOPROTO);
    ver = Number(n) as 2 | 3;
    next = 2;
  }
  let credentials: [user: string, pass: string] | null = null;
  let name: string | null = null;
  for (let j = next; j < argv.length; j++) {
    const more = argv.length - 1 - j;
    const option = argv[j]!.toLowerCase();
    if (option === 'auth' && more >= 2) {
      credentials = [argv[j + 1]!, argv[j + 2]!];
      j += 2;
    } else if (option === 'setname' && more >= 1) {
      name = argv[j + 1]!;
      j += 1;
    } else {
      throw new ReplyError(`ERR Syntax error in HELLO option '${argv[j]!}'`);
    }
  }
  if (name !== null) checkClientName(name);
  if (credentials !== null) {
    if (!credentialsOk(server.config.get('requirepass'), credentials[0], credentials[1]))
      throw new ReplyError(ERR.WRONGPASS);
  } else if (!client.authenticated) {
    throw new ReplyError(NOAUTH_HELLO);
  }
  // Nothing can fail from here on.
  if (credentials !== null) client.authenticated = true;
  if (name !== null) client.name = name;
  if (ver !== null) client.reply.resp = ver;
  ctx.reply.map([
    ['server', 'redis'],
    ['version', REDIS_VERSION],
    ['proto', client.reply.resp],
    ['id', client.id],
    ['mode', 'standalone'],
    ['role', server.role === 'replica' ? 'replica' : 'master'],
    ['modules', []],
  ]);
}

/**
 * Back to a just-connected client (Redis's clearClientConnectionState): out of MULTI, WATCH
 * and subscriptions, db 0, RESP2, no name, and logged out if a password is required.
 */
export function resetCommand(ctx: CommandContext): void {
  const { client, server } = ctx;
  discardTransaction(client);
  server.pubsub.unsubscribeAll(client);
  client.monitor = false;
  server.monitors.delete(client);
  client.db = 0;
  client.name = '';
  client.reply.resp = 2;
  client.authenticated = server.config.get('requirepass') === '';
  ctx.reply.simple('RESET');
}

/** The class a client counts as, for CLIENT KILL TYPE and the output limits. */
export type ClientType = 'normal' | 'replica' | 'pubsub' | 'master';

/** Redis's getClientType: the link to our primary first, then replicas, then subscribers. */
export function clientType(client: Client): ClientType {
  if (client.primaryLink) return 'master';
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

/**
 * `CLIENT LIST [TYPE normal|master|replica|pubsub] [ID id ...]`: one line per client, oldest id
 * first, as one verbatim string.
 */
export function clientListCommand(ctx: CommandContext): void {
  const { server, argv } = ctx;
  let type: ClientType | null = null;
  let ids: Set<number> | null = null;
  const opt = argv[2]?.toLowerCase();
  if (opt === 'type' && argv.length === 4) {
    type = CLIENT_TYPES[argv[3]!.toLowerCase()] ?? null;
    if (type === null) throw new ReplyError(`ERR Unknown client type '${argv[3]}'`);
  } else if (opt === 'id' && argv.length >= 4) {
    ids = new Set();
    for (const raw of argv.slice(3)) {
      const id = parseInt64(raw);
      if (id === null || id <= 0n) throw new ReplyError('ERR Invalid client ID');
      ids.add(Number(id));
    }
  } else if (argv.length !== 2) {
    throw new ReplyError(ERR.SYNTAX);
  }
  const now = Date.now();
  let text = '';
  for (const c of server.clients.values()) {
    if (type !== null && clientType(c) !== type) continue;
    if (ids !== null && !ids.has(c.id)) continue;
    text += `${clientInfoLine(c, now)}\n`;
  }
  ctx.reply.verbatim(text);
}

export function clientInfoCommand(ctx: CommandContext): void {
  ctx.reply.verbatim(`${clientInfoLine(ctx.client)}\n`);
}

/** MONITOR: this client now sees every non-admin command the others run (spec 13.3). */
export function monitorCommand(ctx: CommandContext): void {
  const { client, server } = ctx;
  if (client.repl !== null) return;
  if (!client.monitor) {
    client.monitor = true;
    server.monitors.add(client);
  }
  ctx.reply.ok();
}

export const connectionCommands: CommandSpec[] = [
  command('ping', -1, [], [0, 0, 0], pingCommand),
  command('echo', 2, [], [0, 0, 0], echoCommand),
  command('quit', -1, ['noauth'], [0, 0, 0], quitCommand),
  command('select', 2, ['stale'], [0, 0, 0], selectCommand),
  command('auth', -2, ['noauth', 'stale'], [0, 0, 0], authCommand),
  command('hello', -1, ['noauth', 'stale'], [0, 0, 0], helloCommand),
  command('monitor', 1, ['admin', 'stale'], [0, 0, 0], monitorCommand),
  command('reset', 1, ['noauth', 'stale'], [0, 0, 0], resetCommand),
  command('client', -2, [], [0, 0, 0], containerOnly, [
    command('client|id', 2, ['stale'], [0, 0, 0], clientIdCommand),
    command('client|setname', 3, ['stale'], [0, 0, 0], clientSetnameCommand),
    command('client|getname', 2, ['stale'], [0, 0, 0], clientGetnameCommand),
    command('client|setinfo', 4, ['stale'], [0, 0, 0], clientSetinfoCommand),
    command('client|kill', -3, ['admin', 'stale'], [0, 0, 0], clientKillCommand),
    command('client|list', -2, ['admin', 'stale'], [0, 0, 0], clientListCommand),
    command('client|info', 2, ['stale'], [0, 0, 0], clientInfoCommand),
  ]),
];
