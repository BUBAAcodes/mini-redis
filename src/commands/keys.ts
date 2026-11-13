/**
 * Key commands (spec 8.2): DEL, UNLINK, EXISTS, TYPE, KEYS, SCAN, RENAME, RANDOMKEY, DBSIZE,
 * FLUSHDB and FLUSHALL, and the TTL commands EXPIRE, PEXPIRE, EXPIREAT, PEXPIREAT, TTL, PTTL
 * and PERSIST.
 *
 * Key design choice: KEYS is a full walk by design and FLUSH* clears in one go (rule 10 allows
 * both), but SCAN does a bounded number of steps and only filters (MATCH, TYPE) what it
 * visited, so a page may come back empty while the cursor is still non-zero. DEL signals each
 * key it actually removed, once, so `DEL a a` replies 1 and a DEL of missing keys changes
 * nothing and propagates nothing. The four EXPIRE forms share one handler that turns every
 * deadline into absolute Unix ms in int64 (BigInt, so overflow is caught exactly as Redis
 * catches it), then always propagates that absolute time as PEXPIREAT, or DEL when the deadline
 * has already passed, so a replay never restarts a relative TTL (spec 9.5).
 *
 * Mirrors Redis db.c (delGenericCommand, existsCommand, typeCommand, keysCommand,
 * scanGenericCommand, renameGenericCommand, randomkeyCommand, dbsizeCommand),
 * db.c/cluster.c flushdbCommand and flushallCommand, and expire.c (expireGenericCommand,
 * parseExtendedExpireArgumentsOrReply, ttlGenericCommand, persistCommand).
 */
import { ERR, ReplyError, invalidExpireTime, unsupportedOption } from '../protocol/errors.js';
import { stringMatch } from '../utils/glob.js';
import { INT64_MAX, INT64_MIN, parseInt64 } from '../utils/numbers.js';
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';

export function delCommand(ctx: CommandContext): void {
  let deleted = 0;
  for (let i = 1; i < ctx.argv.length; i++) {
    const key = ctx.argv[i]!;
    ctx.db.lookupWrite(key);
    if (ctx.db.delete(key)) {
      ctx.db.signalModifiedKey(key);
      deleted++;
    }
  }
  ctx.reply.integer(deleted);
}

/** UNLINK frees memory in the background in Redis; here it is DEL (spec 8.2). */
export function unlinkCommand(ctx: CommandContext): void {
  delCommand(ctx);
}

export function existsCommand(ctx: CommandContext): void {
  let found = 0;
  // peek: EXISTS is not a "hit" and must not make a key look recently used.
  for (let i = 1; i < ctx.argv.length; i++) if (ctx.db.peek(ctx.argv[i]!) !== null) found++;
  ctx.reply.integer(found);
}

export function typeCommand(ctx: CommandContext): void {
  const obj = ctx.db.peek(ctx.argv[1]!);
  ctx.reply.simple(obj === null ? 'none' : obj.type);
}

export function keysCommand(ctx: CommandContext): void {
  const pattern = ctx.argv[1]!;
  const all = pattern === '*';
  ctx.reply.array(ctx.db.allKeys().filter((key) => all || stringMatch(pattern, key)));
}

/** Redis reads the cursor with strtoul: digits only, and it must fit in 64 bits. */
function parseCursor(s: string): number {
  if (!/^[0-9]+$/.test(s) || BigInt(s) > 0xffff_ffff_ffff_ffffn) {
    throw new ReplyError(ERR.INVALID_CURSOR);
  }
  // Our cursors are 32-bit (spec 10.2); a larger one just wraps, as a stale cursor would.
  return Number(BigInt(s) & 0xffff_ffffn);
}

export function scanCommand(ctx: CommandContext): void {
  const cursor = parseCursor(ctx.argv[1]!);
  let count = 10;
  let pattern: string | null = null;
  let type: string | null = null;
  for (let i = 2; i < ctx.argv.length;) {
    const opt = ctx.argv[i]!.toUpperCase();
    const hasValue = i + 1 < ctx.argv.length;
    if (opt === 'COUNT' && hasValue) {
      const n = parseInt64(ctx.argv[i + 1]!);
      if (n === null) throw new ReplyError(ERR.NOT_INTEGER);
      if (n < 1n) throw new ReplyError(ERR.SYNTAX);
      count = n > 0x7fff_ffffn ? 0x7fff_ffff : Number(n);
      i += 2;
    } else if (opt === 'MATCH' && hasValue) {
      pattern = ctx.argv[i + 1]!;
      i += 2;
    } else if (opt === 'TYPE' && hasValue) {
      type = ctx.argv[i + 1]!.toLowerCase();
      i += 2;
    } else {
      throw new ReplyError(ERR.SYNTAX);
    }
  }

  // Keep stepping until `count` entries or `count × 10` steps, whichever comes first (spec 10.2).
  const visited: Array<[string, string]> = [];
  let next = cursor;
  let steps = count * 10;
  do {
    next = ctx.db.scanStep(next, (key, obj) => visited.push([key, obj.type]));
  } while (next !== 0 && --steps > 0 && visited.length < count);

  const keys: string[] = [];
  for (const [key, keyType] of visited) {
    if (type !== null && keyType !== type) continue;
    if (pattern !== null && pattern !== '*' && !stringMatch(pattern, key)) continue;
    // Checked last, as in Redis, so only keys that passed the filters get expired here.
    if (ctx.db.expireIfNeeded(key)) continue;
    keys.push(key);
  }
  ctx.reply.array([String(next), keys]);
}

export function renameCommand(ctx: CommandContext): void {
  const from = ctx.argv[1]!;
  const to = ctx.argv[2]!;
  if (ctx.db.lookupWrite(from) === null) throw new ReplyError(ERR.NO_SUCH_KEY);
  // Renaming a key onto itself succeeds and changes nothing.
  if (from !== to) {
    ctx.db.lookupWrite(to);
    ctx.db.rename(from, to);
    ctx.db.signalModifiedKey(from);
    ctx.db.signalModifiedKey(to);
  }
  ctx.reply.ok();
}

export function randomkeyCommand(ctx: CommandContext): void {
  const key = ctx.db.randomKey();
  if (key === null) ctx.reply.nullBulk();
  else ctx.reply.bulk(key);
}

export function dbsizeCommand(ctx: CommandContext): void {
  ctx.reply.integer(ctx.db.size);
}

/** FLUSHDB and FLUSHALL take an optional SYNC or ASYNC; both run now (spec 8.2). */
function checkFlushArgs(ctx: CommandContext): void {
  if (ctx.argv.length > 2) throw new ReplyError(ERR.SYNTAX);
  if (ctx.argv.length === 2) {
    const mode = ctx.argv[1]!.toUpperCase();
    if (mode !== 'SYNC' && mode !== 'ASYNC') throw new ReplyError(ERR.SYNTAX);
  }
}

export function flushdbCommand(ctx: CommandContext): void {
  checkFlushArgs(ctx);
  // A running snapshot job must be aborted here (step 13); an empty db changes and propagates
  // nothing, as in Redis.
  ctx.db.flush();
  ctx.reply.ok();
}

export function flushallCommand(ctx: CommandContext): void {
  checkFlushArgs(ctx);
  let removed = 0;
  for (const db of ctx.server.dbs) removed += db.flush();
  // Redis forces FLUSHALL into the AOF and replicas even when every db was already empty.
  if (removed === 0) ctx.server.dirty++;
  ctx.reply.ok();
}

interface ExpireFlags {
  nx: boolean;
  xx: boolean;
  gt: boolean;
  lt: boolean;
}

/** EXPIRE's NX, XX, GT and LT, any case, repeats allowed; clashes are checked after all. */
function parseExpireFlags(argv: readonly string[]): ExpireFlags {
  const flags: ExpireFlags = { nx: false, xx: false, gt: false, lt: false };
  for (let i = 3; i < argv.length; i++) {
    const opt = argv[i]!.toUpperCase();
    if (opt === 'NX') flags.nx = true;
    else if (opt === 'XX') flags.xx = true;
    else if (opt === 'GT') flags.gt = true;
    else if (opt === 'LT') flags.lt = true;
    else throw new ReplyError(unsupportedOption(argv[i]!));
  }
  if (flags.nx && (flags.xx || flags.gt || flags.lt)) {
    throw new ReplyError(ERR.EXPIRE_NX_CONFLICT);
  }
  if (flags.gt && flags.lt) throw new ReplyError(ERR.EXPIRE_GT_LT_CONFLICT);
  return flags;
}

/**
 * EXPIRE, PEXPIRE, EXPIREAT and PEXPIREAT. `basetime` is cmdTime for the relative forms and 0
 * for the absolute ones. Errors come in Redis's order: flags, the number, overflow, and only
 * then the key, so a bad deadline is an error even for a missing key.
 */
function expireGeneric(
  ctx: CommandContext,
  name: string,
  basetime: number,
  seconds: boolean,
): void {
  const key = ctx.argv[1]!;
  const flags = parseExpireFlags(ctx.argv);
  let when = parseInt64(ctx.argv[2]!);
  if (when === null) throw new ReplyError(ERR.NOT_INTEGER);
  if (seconds) {
    // BigInt division truncates toward zero like C's, so these are Redis's exact bounds.
    if (when > INT64_MAX / 1000n || when < INT64_MIN / 1000n) {
      throw new ReplyError(invalidExpireTime(name));
    }
    when *= 1000n;
  }
  if (when > INT64_MAX - BigInt(basetime)) throw new ReplyError(invalidExpireTime(name));
  when += BigInt(basetime);

  if (ctx.db.lookupWrite(key) === null) {
    ctx.reply.integer(0);
    return;
  }
  // Deadlines past 2^53 ms (year 287,396) round to a double here (docs/DIFFERENCES.md).
  const deadline = Number(when);
  const current = ctx.db.getExpire(key);
  // GT and LT treat a key without a TTL as having an infinite one (spec 9.3).
  if (
    (flags.nx && current !== -1) ||
    (flags.xx && current === -1) ||
    (flags.gt && (current === -1 || deadline <= current)) ||
    (flags.lt && current !== -1 && deadline >= current)
  ) {
    ctx.reply.integer(0);
    return;
  }
  if (deadline <= ctx.server.cmdTime) {
    // Already past: the key goes now, and a replay must delete it rather than set a TTL.
    ctx.db.delete(key);
    ctx.db.signalModifiedKey(key);
    ctx.rewritePropagation(['DEL', key]);
  } else {
    ctx.db.setExpire(key, deadline);
    ctx.db.signalModifiedKey(key);
    // The exact int64, not the double: it must parse back as the same deadline.
    ctx.rewritePropagation(['PEXPIREAT', key, String(when)]);
  }
  ctx.reply.integer(1);
}

export const expireCommand = (ctx: CommandContext): void =>
  expireGeneric(ctx, 'expire', ctx.server.cmdTime, true);
export const pexpireCommand = (ctx: CommandContext): void =>
  expireGeneric(ctx, 'pexpire', ctx.server.cmdTime, false);
export const expireatCommand = (ctx: CommandContext): void =>
  expireGeneric(ctx, 'expireat', 0, true);
export const pexpireatCommand = (ctx: CommandContext): void =>
  expireGeneric(ctx, 'pexpireat', 0, false);

/** TTL and PTTL: -2 for no key, -1 for no TTL; TTL rounds to the nearest second. */
function ttlGeneric(ctx: CommandContext, ms: boolean): void {
  const key = ctx.argv[1]!;
  if (ctx.db.peek(key) === null) {
    ctx.reply.integer(-2);
    return;
  }
  const expireAt = ctx.db.getExpire(key);
  if (expireAt === -1) {
    ctx.reply.integer(-1);
    return;
  }
  const left = Math.max(0, expireAt - ctx.server.cmdTime);
  ctx.reply.integer(ms ? left : Math.floor((left + 500) / 1000));
}

export const ttlCommand = (ctx: CommandContext): void => ttlGeneric(ctx, false);
export const pttlCommand = (ctx: CommandContext): void => ttlGeneric(ctx, true);

export function persistCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  if (ctx.db.lookupWrite(key) !== null && ctx.db.removeExpire(key)) {
    ctx.db.signalModifiedKey(key);
    ctx.reply.integer(1);
  } else {
    ctx.reply.integer(0);
  }
}

export const keyCommands: CommandSpec[] = [
  command('del', -2, ['write'], [1, -1, 1], delCommand),
  command('unlink', -2, ['write'], [1, -1, 1], unlinkCommand),
  command('exists', -2, ['readonly'], [1, -1, 1], existsCommand),
  command('type', 2, ['readonly'], [1, 1, 1], typeCommand),
  command('keys', 2, ['readonly'], [0, 0, 0], keysCommand),
  command('scan', -2, ['readonly'], [0, 0, 0], scanCommand),
  command('rename', 3, ['write'], [1, 2, 1], renameCommand),
  command('randomkey', 1, ['readonly'], [0, 0, 0], randomkeyCommand),
  command('dbsize', 1, ['readonly'], [0, 0, 0], dbsizeCommand),
  command('flushdb', -1, ['write'], [0, 0, 0], flushdbCommand),
  command('flushall', -1, ['write'], [0, 0, 0], flushallCommand),
  command('expire', -3, ['write'], [1, 1, 1], expireCommand),
  command('pexpire', -3, ['write'], [1, 1, 1], pexpireCommand),
  command('expireat', -3, ['write'], [1, 1, 1], expireatCommand),
  command('pexpireat', -3, ['write'], [1, 1, 1], pexpireatCommand),
  command('ttl', 2, ['readonly'], [1, 1, 1], ttlCommand),
  command('pttl', 2, ['readonly'], [1, 1, 1], pttlCommand),
  command('persist', 2, ['write'], [1, 1, 1], persistCommand),
];
