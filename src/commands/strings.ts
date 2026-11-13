/**
 * String commands (spec 8.1, except the TTL ones that arrive in step 7: SET's EX/PX/EXAT/PXAT/
 * KEEPTTL and GETEX, which are syntax errors until then).
 *
 * Key design choice: every handler parses and validates all its arguments, and type-checks the
 * key, before it changes anything, so an error reply always means nothing changed (rule 4).
 * Values are byte strings stored as-is (spec 7.1), so lengths are `value.length`. Math on
 * stored integers is BigInt (spec 7.2) and on floats is plain doubles; commands that rewrite a
 * value in place keep its TTL, as Redis does.
 *
 * Mirrors Redis t_string.c (setGenericCommand, getCommand, getdelCommand, mgetCommand,
 * msetCommand, appendCommand, strlenCommand, incrDecrCommand, incrbyfloatCommand,
 * getrangeCommand, setrangeCommand).
 */
import { ERR, ReplyError, wrongArity } from '../protocol/errors.js';
import { createStringObject } from '../storage/redis-object.js';
import type { StringObject } from '../storage/redis-object.js';
import {
  addInt64,
  clampToSafe,
  formatDouble,
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

export function setCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  const value = ctx.argv[2]!;
  // Parse every option first. Repeating one is fine, as in Redis; NX with XX is not.
  let nx = false;
  let xx = false;
  let get = false;
  for (let i = 3; i < ctx.argv.length; i++) {
    const opt = ctx.argv[i]!.toUpperCase();
    if (opt === 'NX' && !xx) nx = true;
    else if (opt === 'XX' && !nx) xx = true;
    else if (opt === 'GET') get = true;
    else throw new ReplyError(ERR.SYNTAX);
  }
  // Looked up even though SET overwrites anything: lazy expiry (step 7) and the snapshot hook
  // (step 13) must see the old value first (rule 5).
  const old = ctx.db.lookupWrite(key);
  if (get) {
    // GET replies with the old value before anything else; a wrong type fails the whole command.
    if (old !== null && old.type !== 'string') throw new ReplyError(ERR.WRONGTYPE);
    if (old === null) ctx.reply.nullBulk();
    else ctx.reply.bulk(old.value);
  }
  if ((nx && old !== null) || (xx && old === null)) {
    if (!get) ctx.reply.nullBulk();
    return;
  }
  ctx.db.setKey(key, createStringObject(value));
  ctx.db.signalModifiedKey(key);
  if (!get) ctx.reply.ok();
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
