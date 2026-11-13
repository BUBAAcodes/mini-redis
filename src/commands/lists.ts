/**
 * List commands (spec 8.3), on the Quicklist (spec 10.4), including BLPOP, BRPOP and BLMOVE
 * (spec 9.12; the waiting itself is in blocking/waiters.ts). LPUSHX, RPUSHX, LPOS and RPOPLPUSH
 * are † (left to write by hand).
 *
 * Key design choice: each handler parses and checks its arguments in the same order as Redis's
 * (some parse before the key lookup, some after), so the same bad call gets the same error on
 * both servers. Nothing changes before every check has passed (rule 4). A list that becomes
 * empty is deleted at once, so no command can see an empty list; its TTL goes with it. A command
 * that changed nothing (LPOP 0, LTRIM that keeps everything) doesn't call signalModifiedKey, so
 * it isn't propagated.
 *
 * Mirrors Redis t_list.c (pushGenericCommand, popGenericCommand, llenCommand, lrangeCommand,
 * lindexCommand, lsetCommand, linsertCommand, lremCommand, ltrimCommand, lmoveGenericCommand,
 * blockingPopGenericCommand, blmoveGenericCommand).
 */
import { parseTimeout } from '../blocking/waiters.js';
import { ERR, ReplyError, wrongArity } from '../protocol/errors.js';
import { createListObject } from '../storage/redis-object.js';
import type { ListObject } from '../storage/redis-object.js';
import { clampToSafe, parseInt64 } from '../utils/numbers.js';
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';
import { lookupReadOfType, lookupWriteOfType } from './typed.js';

/** A long argument (getLongFromObjectOrReply), clamped to a safe JS number (spec 7.2). */
function parseLong(s: string): number {
  const n = parseInt64(s);
  if (n === null) throw new ReplyError(ERR.NOT_INTEGER);
  return clampToSafe(n);
}

type End = 'LEFT' | 'RIGHT';

function parseEnd(s: string): End {
  const e = s.toUpperCase();
  if (e !== 'LEFT' && e !== 'RIGHT') throw new ReplyError(ERR.SYNTAX);
  return e;
}

/** The list under `key` for a push, created and added if missing. */
function listForPush(ctx: CommandContext, key: string): ListObject {
  const existing = lookupWriteOfType(ctx, key, 'list');
  if (existing !== null) return existing;
  const obj = createListObject(ctx.server.config.get('list-max-node-items'));
  ctx.db.add(key, obj);
  return obj;
}

/** After a removal: delete the key if the list is empty, then signal the change once. */
function afterRemove(ctx: CommandContext, key: string, list: ListObject): void {
  if (list.value.length === 0) ctx.db.delete(key);
  ctx.db.signalModifiedKey(key);
}

/** Redis's start/end normalisation for LRANGE and LTRIM: null when the range is empty. */
function normaliseRange(start: number, end: number, len: number): [number, number] | null {
  if (start < 0) start += len;
  if (end < 0) end += len;
  if (start < 0) start = 0;
  if (start > end || start >= len) return null;
  if (end >= len) end = len - 1;
  return [start, end];
}

function pushGeneric(ctx: CommandContext, end: End): void {
  const key = ctx.argv[1]!;
  const list = listForPush(ctx, key);
  for (let i = 2; i < ctx.argv.length; i++) {
    if (end === 'LEFT') list.value.pushHead(ctx.argv[i]!);
    else list.value.pushTail(ctx.argv[i]!);
  }
  ctx.db.signalModifiedKey(key);
  ctx.reply.integer(list.value.length);
}

export const lpushCommand = (ctx: CommandContext): void => pushGeneric(ctx, 'LEFT');
export const rpushCommand = (ctx: CommandContext): void => pushGeneric(ctx, 'RIGHT');

function popGeneric(ctx: CommandContext, end: End): void {
  const key = ctx.argv[1]!;
  let count = -1;
  // Arity -2 lets any number through; Redis takes at most a count.
  if (ctx.argv.length > 3) throw new ReplyError(wrongArity(ctx.argv[0]!.toLowerCase()));
  if (ctx.argv.length === 3) {
    // Redis passes its range message as the parse error too, so 'abc' is "out of range".
    const n = parseInt64(ctx.argv[2]!);
    if (n === null || n < 0n) throw new ReplyError(ERR.NOT_POSITIVE);
    count = clampToSafe(n);
  }
  const list = lookupWriteOfType(ctx, key, 'list');
  if (list === null) {
    if (count === -1) ctx.reply.nullBulk();
    else ctx.reply.nullArray();
    return;
  }
  const pop = (): string => (end === 'LEFT' ? list.value.popHead()! : list.value.popTail()!);
  if (count === -1) {
    ctx.reply.bulk(pop());
  } else {
    const n = Math.min(count, list.value.length);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(pop());
    ctx.reply.array(out);
    if (n === 0) return;
  }
  afterRemove(ctx, key, list);
}

export const lpopCommand = (ctx: CommandContext): void => popGeneric(ctx, 'LEFT');
export const rpopCommand = (ctx: CommandContext): void => popGeneric(ctx, 'RIGHT');

export function llenCommand(ctx: CommandContext): void {
  const list = lookupReadOfType(ctx, ctx.argv[1]!, 'list');
  ctx.reply.integer(list === null ? 0 : list.value.length);
}

export function lrangeCommand(ctx: CommandContext): void {
  const start = parseLong(ctx.argv[2]!);
  const end = parseLong(ctx.argv[3]!);
  const list = lookupReadOfType(ctx, ctx.argv[1]!, 'list');
  const r = list === null ? null : normaliseRange(start, end, list.value.length);
  ctx.reply.array(r === null ? [] : list!.value.range(r[0], r[1]));
}

export function lindexCommand(ctx: CommandContext): void {
  const list = lookupReadOfType(ctx, ctx.argv[1]!, 'list');
  if (list === null) {
    ctx.reply.nullBulk();
    return;
  }
  const value = list.value.index(parseLong(ctx.argv[2]!));
  if (value === undefined) ctx.reply.nullBulk();
  else ctx.reply.bulk(value);
}

export function lsetCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  const list = lookupWriteOfType(ctx, key, 'list');
  if (list === null) throw new ReplyError(ERR.NO_SUCH_KEY);
  const index = parseLong(ctx.argv[2]!);
  if (!list.value.set(index, ctx.argv[3]!)) throw new ReplyError(ERR.INDEX_OUT_OF_RANGE);
  ctx.db.signalModifiedKey(key);
  ctx.reply.ok();
}

export function linsertCommand(ctx: CommandContext): void {
  const where = ctx.argv[2]!.toUpperCase();
  if (where !== 'BEFORE' && where !== 'AFTER') throw new ReplyError(ERR.SYNTAX);
  const key = ctx.argv[1]!;
  const list = lookupWriteOfType(ctx, key, 'list');
  if (list === null) {
    ctx.reply.integer(0);
    return;
  }
  const at = list.value.indexOf(ctx.argv[3]!);
  if (at === -1) {
    ctx.reply.integer(-1);
    return;
  }
  list.value.insert(where === 'BEFORE' ? at : at + 1, ctx.argv[4]!);
  ctx.db.signalModifiedKey(key);
  ctx.reply.integer(list.value.length);
}

export function lremCommand(ctx: CommandContext): void {
  const count = parseLong(ctx.argv[2]!);
  const key = ctx.argv[1]!;
  const list = lookupWriteOfType(ctx, key, 'list');
  if (list === null) {
    ctx.reply.integer(0);
    return;
  }
  const removed = list.value.remove(ctx.argv[3]!, count);
  if (removed > 0) afterRemove(ctx, key, list);
  ctx.reply.integer(removed);
}

export function ltrimCommand(ctx: CommandContext): void {
  const start = parseLong(ctx.argv[2]!);
  const end = parseLong(ctx.argv[3]!);
  const key = ctx.argv[1]!;
  const list = lookupWriteOfType(ctx, key, 'list');
  if (list !== null) {
    const len = list.value.length;
    const r = normaliseRange(start, end, len);
    if (r === null) list.value.clear();
    else list.value.trim(r[0], r[1]);
    if (list.value.length !== len) afterRemove(ctx, key, list);
  }
  ctx.reply.ok();
}

export function lmoveCommand(ctx: CommandContext): void {
  const from = parseEnd(ctx.argv[3]!);
  const to = parseEnd(ctx.argv[4]!);
  lmoveGeneric(ctx, from, to);
}

/** LMOVE's work, shared with BLMOVE: source and destination are argv[1] and argv[2]. */
function lmoveGeneric(ctx: CommandContext, from: End, to: End): void {
  const srcKey = ctx.argv[1]!;
  const dstKey = ctx.argv[2]!;
  const src = lookupWriteOfType(ctx, srcKey, 'list');
  if (src === null) {
    ctx.reply.nullBulk();
    return;
  }
  // The destination's type is checked before anything is popped (rule 4).
  lookupWriteOfType(ctx, dstKey, 'list');
  const value = from === 'LEFT' ? src.value.popHead()! : src.value.popTail()!;
  if (srcKey === dstKey) {
    // A rotation: the list never empties, and the key is signalled once.
    if (to === 'LEFT') src.value.pushHead(value);
    else src.value.pushTail(value);
    ctx.db.signalModifiedKey(srcKey);
  } else {
    afterRemove(ctx, srcKey, src);
    const dst = listForPush(ctx, dstKey);
    if (to === 'LEFT') dst.value.pushHead(value);
    else dst.value.pushTail(value);
    ctx.db.signalModifiedKey(dstKey);
  }
  ctx.reply.bulk(value);
}

/**
 * BLPOP and BRPOP (spec 9.12): the timeout is checked first, then the keys in order. The first
 * list found is popped like LPOP, so a key of another type before it is WRONGTYPE. Nothing
 * ready means block, except inside a transaction, which must never wait: null at once.
 * Served waiters run this again (blocking/waiters.ts), so this is also the serving code.
 */
function blockingPopGeneric(ctx: CommandContext, end: End): void {
  const keys = ctx.argv.slice(1, -1);
  const timeout = parseTimeout(ctx.argv[ctx.argv.length - 1]!, ctx.server.cmdTime);
  for (const key of keys) {
    const list = lookupWriteOfType(ctx, key, 'list');
    if (list === null) continue;
    const value = end === 'LEFT' ? list.value.popHead()! : list.value.popTail()!;
    afterRemove(ctx, key, list);
    // A replica or an AOF replay must pop, never wait (spec 9.12).
    ctx.rewritePropagation([end === 'LEFT' ? 'LPOP' : 'RPOP', key]);
    ctx.reply.array([key, value]);
    return;
  }
  if (ctx.client.denyBlocking) {
    ctx.reply.nullArray();
    return;
  }
  ctx.server.waiters.block(ctx, keys, timeout);
}

export const blpopCommand = (ctx: CommandContext): void => blockingPopGeneric(ctx, 'LEFT');
export const brpopCommand = (ctx: CommandContext): void => blockingPopGeneric(ctx, 'RIGHT');

/**
 * BLMOVE: the directions, then the timeout, then LMOVE if the source has elements (so its
 * destination's type is checked only then). Inside MULTI a missing source gives LMOVE's own
 * null bulk, though a timeout gives a null array, as in Redis.
 */
export function blmoveCommand(ctx: CommandContext): void {
  const from = parseEnd(ctx.argv[3]!);
  const to = parseEnd(ctx.argv[4]!);
  const timeout = parseTimeout(ctx.argv[5]!, ctx.server.cmdTime);
  const srcKey = ctx.argv[1]!;
  if (lookupWriteOfType(ctx, srcKey, 'list') === null) {
    if (ctx.client.denyBlocking) ctx.reply.nullBulk();
    else ctx.server.waiters.block(ctx, [srcKey], timeout);
    return;
  }
  lmoveGeneric(ctx, from, to);
  ctx.rewritePropagation(['LMOVE', srcKey, ctx.argv[2]!, ctx.argv[3]!, ctx.argv[4]!]);
}

export const listCommands: CommandSpec[] = [
  command('lpush', -3, ['write', 'denyoom'], [1, 1, 1], lpushCommand),
  command('rpush', -3, ['write', 'denyoom'], [1, 1, 1], rpushCommand),
  command('lpop', -2, ['write'], [1, 1, 1], lpopCommand),
  command('rpop', -2, ['write'], [1, 1, 1], rpopCommand),
  command('llen', 2, ['readonly'], [1, 1, 1], llenCommand),
  command('lrange', 4, ['readonly'], [1, 1, 1], lrangeCommand),
  command('lindex', 3, ['readonly'], [1, 1, 1], lindexCommand),
  command('lset', 4, ['write', 'denyoom'], [1, 1, 1], lsetCommand),
  command('linsert', 5, ['write', 'denyoom'], [1, 1, 1], linsertCommand),
  command('lrem', 4, ['write'], [1, 1, 1], lremCommand),
  command('ltrim', 4, ['write'], [1, 1, 1], ltrimCommand),
  command('lmove', 5, ['write', 'denyoom'], [1, 2, 1], lmoveCommand),
  command('blpop', -3, ['write', 'blocking'], [1, -2, 1], blpopCommand),
  command('brpop', -3, ['write', 'blocking'], [1, -2, 1], brpopCommand),
  command('blmove', 6, ['write', 'denyoom', 'blocking'], [1, 2, 1], blmoveCommand),
];
