/**
 * String commands (spec 8.1).
 *
 * Key design choice: every handler parses and validates all its arguments, and type-checks the
 * key, before it changes anything, so an error reply always means nothing changed (rule 4).
 * Values are byte strings stored as-is (spec 7.1), so lengths are `value.length`. Math on
 * stored integers is BigInt (spec 7.2) and on floats is plain doubles; commands that rewrite a
 * value in place keep its TTL, as Redis does. SET and GETEX share Redis's option parser, and
 * turn any relative TTL into an absolute deadline before they propagate (SET … PXAT,
 * PEXPIREAT), so a replay never restarts the clock (spec 9.5).
 *
 * Mirrors Redis t_string.c (parseExtendedStringArgumentsOrReply, getExpireMillisecondsOrReply,
 * setGenericCommand, getCommand, getexCommand, getdelCommand, mgetCommand, msetCommand,
 * appendCommand, strlenCommand, incrDecrCommand, incrbyfloatCommand, getrangeCommand,
 * setrangeCommand).
 */
import { ERR, ReplyError, invalidExpireTime, wrongArity } from '../protocol/errors.js';
import { createStringObject } from '../storage/redis-object.js';
import type { StringObject } from '../storage/redis-object.js';
import {
  addInt64,
  clampToSafe,
  formatDouble,
  INT64_MAX,
  INT64_MIN,
  parseDouble,
  parseInt64,
} from '../utils/numbers.js';
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';

/** The string stored under `key` for a write, or null; any other type is WRONGTYPE. */
function stringForWrite(ctx: CommandContext, key: string): StringObject | null {
  const obj = ctx.db.lookupWrite(key);
  if (obj === null) return null;
  if (obj.type !== 'string') throw new ReplyError(ERR.WRONGTYPE);
  return obj;
}

/** Redis's checkStringLength: no string may grow past proto-max-bulk-len. */
function checkStringLength(ctx: CommandContext, size: number): void {
  if (size > ctx.server.config.get('proto-max-bulk-len')) {
    throw new ReplyError(ERR.STRING_TOO_LONG);
  }
}

/** Replaces the value of `key`, keeping a TTL it already has. */
function overwrite(ctx: CommandContext, key: string, value: string): void {
  ctx.db.setKey(key, createStringObject(value), { keepTtl: true });
  ctx.db.signalModifiedKey(key);
}

export function getCommand(ctx: CommandContext): void {
  const obj = ctx.db.lookupRead(ctx.argv[1]!);
  if (obj === null) ctx.reply.nullBulk();
  else if (obj.type !== 'string') throw new ReplyError(ERR.WRONGTYPE);
  else ctx.reply.bulk(obj.value);
}

type ExpireUnit = 'EX' | 'PX' | 'EXAT' | 'PXAT';
const EXPIRE_UNITS: ReadonlySet<string> = new Set<ExpireUnit>(['EX', 'PX', 'EXAT', 'PXAT']);

interface StringArgs {
  nx: boolean;
  xx: boolean;
  get: boolean;
  keepTtl: boolean;
  persist: boolean;
  /** The TTL option given, and its unparsed value. */
  unit: ExpireUnit | null;
  expire: string | null;
}

/**
 * SET's and GETEX's options, as Redis's parseExtendedStringArgumentsOrReply reads them: each
 * option is accepted only if nothing that clashes with it came before, so a clash is a syntax
 * error in either order. Repeating an option is fine, and for a TTL the last value wins.
 */
function parseStringArgs(argv: readonly string[], start: number, set: boolean): StringArgs {
  const a: StringArgs = {
    nx: false,
    xx: false,
    get: false,
    keepTtl: false,
    persist: false,
    unit: null,
    expire: null,
  };
  for (let i = start; i < argv.length; i++) {
    const opt = argv[i]!.toUpperCase();
    if (set && opt === 'NX' && !a.xx) a.nx = true;
    else if (set && opt === 'XX' && !a.nx) a.xx = true;
    else if (set && opt === 'GET') a.get = true;
    else if (set && opt === 'KEEPTTL' && a.unit === null) a.keepTtl = true;
    else if (!set && opt === 'PERSIST' && a.unit === null) a.persist = true;
    else if (
      EXPIRE_UNITS.has(opt) &&
      !a.keepTtl &&
      !a.persist &&
      (a.unit === null || a.unit === opt) &&
      i + 1 < argv.length
    ) {
      a.unit = opt as ExpireUnit;
      a.expire = argv[++i]!;
    } else {
      throw new ReplyError(ERR.SYNTAX);
    }
  }
  return a;
}

/**
 * A TTL option's value as an absolute deadline in Unix ms, in int64 (getExpireMillisecondsOrReply):
 * it must be positive, and neither the unit conversion nor adding the clock may overflow.
 */
function expireDeadline(ctx: CommandContext, name: string, unit: ExpireUnit, arg: string): bigint {
  let ms = parseInt64(arg);
  if (ms === null) throw new ReplyError(ERR.NOT_INTEGER);
  const seconds = unit === 'EX' || unit === 'EXAT';
  if (ms <= 0n || (seconds && ms > INT64_MAX / 1000n)) {
    throw new ReplyError(invalidExpireTime(name));
  }
  if (seconds) ms *= 1000n;
  if (unit === 'EX' || unit === 'PX') {
    const now = BigInt(ctx.server.cmdTime);
    if (ms > INT64_MAX - now) throw new ReplyError(invalidExpireTime(name));
    ms += now;
  }
  return ms;
}

export function setCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  const value = ctx.argv[2]!;
  const args = parseStringArgs(ctx.argv, 3, true);
  // The TTL is checked before GET replies or NX/XX decide anything, as in Redis.
  const deadline = args.unit === null ? null : expireDeadline(ctx, 'set', args.unit, args.expire!);
  // Looked up even though SET overwrites anything: lazy expiry and the snapshot hook (step 13)
  // must see the old value first (rule 5).
  const old = ctx.db.lookupWrite(key);
  if (args.get) {
    // GET replies with the old value before anything else; a wrong type fails the whole command.
    if (old !== null && old.type !== 'string') throw new ReplyError(ERR.WRONGTYPE);
    if (old === null) ctx.reply.nullBulk();
    else ctx.reply.bulk(old.value);
  }
  if ((args.nx && old !== null) || (args.xx && old === null)) {
    if (!args.get) ctx.reply.nullBulk();
    return;
  }
  // A plain SET drops the old TTL; KEEPTTL keeps it (spec 9.3).
  ctx.db.setKey(key, createStringObject(value), { keepTtl: args.keepTtl });
  // A deadline already past (EXAT 1) is stored anyway and expires on the next touch, as in Redis.
  if (deadline !== null) ctx.db.setExpire(key, Number(deadline));
  ctx.db.signalModifiedKey(key);
  if (!args.get) ctx.reply.ok();
  // A relative TTL would restart on replay (spec 9.5); PXAT is already exact.
  if (deadline !== null && args.unit !== 'PXAT') {
    ctx.rewritePropagation(['SET', key, value, 'PXAT', String(deadline)]);
  }
}

export function getexCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  const args = parseStringArgs(ctx.argv, 2, false);
  // Redis's order: a missing key is nil and a wrong type is WRONGTYPE before the TTL is checked.
  const obj = stringForWrite(ctx, key);
  if (obj === null) {
    ctx.reply.nullBulk();
    return;
  }
  const deadline =
    args.unit === null ? null : expireDeadline(ctx, 'getex', args.unit, args.expire!);
  ctx.reply.bulk(obj.value);
  if (deadline !== null && Number(deadline) <= ctx.server.cmdTime) {
    // Only EXAT or PXAT can name a past deadline (EX and PX must be positive): the key goes now.
    ctx.db.delete(key);
    ctx.db.signalModifiedKey(key);
    ctx.rewritePropagation(['DEL', key]);
  } else if (deadline !== null) {
    ctx.db.setExpire(key, Number(deadline));
    ctx.db.signalModifiedKey(key);
    ctx.rewritePropagation(['PEXPIREAT', key, String(deadline)]);
  } else if (args.persist && ctx.db.removeExpire(key)) {
    ctx.db.signalModifiedKey(key);
    ctx.rewritePropagation(['PERSIST', key]);
  }
  // No option, or PERSIST on a key without a TTL: nothing changed, nothing propagates.
}

export function getdelCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  const obj = stringForWrite(ctx, key);
  if (obj === null) {
    ctx.reply.nullBulk();
    return;
  }
  ctx.reply.bulk(obj.value);
  ctx.db.delete(key);
  ctx.db.signalModifiedKey(key);
}

export function mgetCommand(ctx: CommandContext): void {
  const values: Array<string | null> = [];
  for (let i = 1; i < ctx.argv.length; i++) {
    const obj = ctx.db.lookupRead(ctx.argv[i]!);
    // A key of another type reads as missing here, never WRONGTYPE.
    values.push(obj !== null && obj.type === 'string' ? obj.value : null);
  }
  ctx.reply.array(values);
}

export function msetCommand(ctx: CommandContext): void {
  // The arity is -3, so an odd number of words (a key without a value) is only caught here.
  if (ctx.argv.length % 2 === 0) {
    throw new ReplyError(wrongArity('mset'));
  }
  for (let i = 1; i < ctx.argv.length; i += 2) {
    const key = ctx.argv[i]!;
    ctx.db.lookupWrite(key);
    ctx.db.setKey(key, createStringObject(ctx.argv[i + 1]!));
    ctx.db.signalModifiedKey(key);
  }
  ctx.reply.ok();
}

export function appendCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  const suffix = ctx.argv[2]!;
  const obj = stringForWrite(ctx, key);
  const next = (obj?.value ?? '') + suffix;
  checkStringLength(ctx, next.length);
  if (obj === null) {
    ctx.db.setKey(key, createStringObject(next));
    ctx.db.signalModifiedKey(key);
  } else if (suffix.length > 0) {
    overwrite(ctx, key, next);
  } else {
    // Appending nothing changes nothing; Redis still signals the key, so WATCH sees it.
    ctx.db.signalModifiedKey(key);
  }
  ctx.reply.integer(next.length);
}

export function strlenCommand(ctx: CommandContext): void {
  const obj = ctx.db.lookupRead(ctx.argv[1]!);
  if (obj === null) ctx.reply.integer(0);
  else if (obj.type !== 'string') throw new ReplyError(ERR.WRONGTYPE);
  else ctx.reply.integer(obj.value.length);
}

/** INCR, DECR, INCRBY and DECRBY: BigInt math, exact over the whole int64 range (spec 7.2). */
function incrDecr(ctx: CommandContext, delta: bigint): void {
  const key = ctx.argv[1]!;
  const obj = stringForWrite(ctx, key);
  let current = 0n;
  if (obj !== null) {
    const parsed = parseInt64(obj.value);
    if (parsed === null) throw new ReplyError(ERR.NOT_INTEGER);
    current = parsed;
  }
  const next = addInt64(current, delta);
  if (next === null) throw new ReplyError(ERR.OVERFLOW);
  if (obj === null) ctx.db.setKey(key, createStringObject(String(next)));
  else ctx.db.setKey(key, createStringObject(String(next)), { keepTtl: true });
  ctx.db.signalModifiedKey(key);
  ctx.reply.integer(next);
}

/** An integer argument: a strict int64, else the usual not-an-integer error. */
function parseInt64OrThrow(s: string): bigint {
  const n = parseInt64(s);
  if (n === null) throw new ReplyError(ERR.NOT_INTEGER);
  return n;
}

export const incrCommand = (ctx: CommandContext): void => incrDecr(ctx, 1n);
export const decrCommand = (ctx: CommandContext): void => incrDecr(ctx, -1n);
export const incrbyCommand = (ctx: CommandContext): void =>
  incrDecr(ctx, parseInt64OrThrow(ctx.argv[2]!));

export function decrbyCommand(ctx: CommandContext): void {
  const by = parseInt64OrThrow(ctx.argv[2]!);
  // -INT64_MIN doesn't fit in int64, so Redis refuses it with its own message.
  if (by === INT64_MIN) throw new ReplyError(ERR.DECR_OVERFLOW);
  incrDecr(ctx, -by);
}

export function incrbyfloatCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  const by = parseDouble(ctx.argv[2]!);
  if (by === null) throw new ReplyError(ERR.NOT_FLOAT);
  const obj = stringForWrite(ctx, key);
  let current = 0;
  if (obj !== null) {
    const parsed = parseDouble(obj.value);
    if (parsed === null) throw new ReplyError(ERR.NOT_FLOAT);
    current = parsed;
  }
  const result = current + by;
  if (!Number.isFinite(result)) throw new ReplyError(ERR.NAN_OR_INFINITY);
  const text = formatDouble(result);
  if (obj === null) ctx.db.setKey(key, createStringObject(text));
  else ctx.db.setKey(key, createStringObject(text), { keepTtl: true });
  ctx.db.signalModifiedKey(key);
  ctx.reply.bulk(text);
  // Float math could differ on a replica or after a restart, so ship the exact result (spec 9.5).
  ctx.rewritePropagation(['SET', key, text, 'KEEPTTL']);
}

export function getrangeCommand(ctx: CommandContext): void {
  let start = clampToSafe(parseInt64OrThrow(ctx.argv[2]!));
  let end = clampToSafe(parseInt64OrThrow(ctx.argv[3]!));
  const obj = ctx.db.lookupRead(ctx.argv[1]!);
  if (obj === null) {
    ctx.reply.bulk('');
    return;
  }
  if (obj.type !== 'string') throw new ReplyError(ERR.WRONGTYPE);
  const len = obj.value.length;
  // Redis's exact clamping, quirks included (GETRANGE k 0 -100 returns the first byte).
  if (start < 0 && end < 0 && start > end) {
    ctx.reply.bulk('');
    return;
  }
  if (start < 0) start = len + start;
  if (end < 0) end = len + end;
  if (start < 0) start = 0;
  if (end < 0) end = 0;
  if (end >= len) end = len - 1;
  if (start > end || len === 0) ctx.reply.bulk('');
  else ctx.reply.bulk(obj.value.slice(start, end + 1));
}

export function setrangeCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  const offset = clampToSafe(parseInt64OrThrow(ctx.argv[2]!));
  const patch = ctx.argv[3]!;
  if (offset < 0) throw new ReplyError(ERR.OFFSET_OUT_OF_RANGE);
  const obj = stringForWrite(ctx, key);
  if (patch.length === 0) {
    // Nothing to write: never create a key, and report the current length.
    ctx.reply.integer(obj?.value.length ?? 0);
    return;
  }
  checkStringLength(ctx, offset + patch.length);
  let value = obj?.value ?? '';
  if (value.length < offset) value += '\0'.repeat(offset - value.length);
  value = value.slice(0, offset) + patch + value.slice(offset + patch.length);
  if (obj === null) ctx.db.setKey(key, createStringObject(value));
  else ctx.db.setKey(key, createStringObject(value), { keepTtl: true });
  ctx.db.signalModifiedKey(key);
  ctx.reply.integer(value.length);
}

export const stringCommands: CommandSpec[] = [
  command('get', 2, ['readonly'], [1, 1, 1], getCommand),
  command('set', -3, ['write', 'denyoom'], [1, 1, 1], setCommand),
  command('getex', -2, ['write'], [1, 1, 1], getexCommand),
  command('getdel', 2, ['write'], [1, 1, 1], getdelCommand),
  command('mget', -2, ['readonly'], [1, -1, 1], mgetCommand),
  command('mset', -3, ['write', 'denyoom'], [1, -1, 2], msetCommand),
  command('append', 3, ['write', 'denyoom'], [1, 1, 1], appendCommand),
  command('strlen', 2, ['readonly'], [1, 1, 1], strlenCommand),
  command('incr', 2, ['write', 'denyoom'], [1, 1, 1], incrCommand),
  command('decr', 2, ['write', 'denyoom'], [1, 1, 1], decrCommand),
  command('incrby', 3, ['write', 'denyoom'], [1, 1, 1], incrbyCommand),
  command('decrby', 3, ['write', 'denyoom'], [1, 1, 1], decrbyCommand),
  command('incrbyfloat', 3, ['write', 'denyoom'], [1, 1, 1], incrbyfloatCommand),
  command('getrange', 4, ['readonly'], [1, 1, 1], getrangeCommand),
  command('setrange', 4, ['write', 'denyoom'], [1, 1, 1], setrangeCommand),
];
