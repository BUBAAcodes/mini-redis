/**
 * Set commands (spec 8.5), on a Dict of member → true. SMISMEMBER, SMOVE and SINTERCARD are †
 * (left to write by hand).
 *
 * Key design choice: a set is a Dict<true>, never a JS Set (spec 0). Random picks (SPOP,
 * SRANDMEMBER) go through the dict's sampling on the server's seeded RNG. SPOP's random choice
 * must never be made again on a replica or an AOF replay, so it is propagated as the exact
 * `SREM key m1 m2 …`, or `DEL key` when it took the whole set (spec 9.5). The algebra commands
 * look up and type-check every source before computing anything, and compute the whole result
 * before touching the destination, so `SDIFFSTORE a a b` reads `a` before replacing it. An empty
 * result deletes the destination, and an emptied set is deleted.
 *
 * Mirrors Redis t_set.c (saddCommand, sremCommand, sismemberCommand, scardCommand,
 * spopCommand, spopWithCountCommand, srandmemberCommand, srandmemberWithCountCommand,
 * sinterGenericCommand, sunionDiffGenericCommand, sscanCommand).
 */
import { Dict } from '../datastructures/dict.js';
import { ERR, ReplyError } from '../protocol/errors.js';
import { createSetObject } from '../storage/redis-object.js';
import type { SetObject } from '../storage/redis-object.js';
import { INT64_MIN, clampToSafe, parseInt64 } from '../utils/numbers.js';
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';
import { matches, parseCursor, parseScanOptions, scanPage } from './scan.js';
import { lookupReadOfType, lookupWriteOfType } from './typed.js';

/**
 * The most items a negative SRANDMEMBER count may ask for. Redis loops the full count, so
 * `SRANDMEMBER s -9223372036854775807` would block our single thread forever (rule 11); the
 * limit matches the largest request array we accept (spec 7.4). See DIFFERENCES.md.
 */
export const SRANDMEMBER_MAX_REPEATS = 1_048_576;

function membersOf(set: SetObject | null): string[] {
  const out: string[] = [];
  set?.value.forEach((m) => out.push(m));
  return out;
}

export function saddCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  let set = lookupWriteOfType(ctx, key, 'set');
  if (set === null) {
    set = createSetObject(ctx.server.dictOptions);
    ctx.db.add(key, set);
  }
  let added = 0;
  for (let i = 2; i < ctx.argv.length; i++) if (set.value.set(ctx.argv[i]!, true)) added++;
  if (added > 0) ctx.db.signalModifiedKey(key);
  ctx.reply.integer(added);
}

export function sremCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  const set = lookupWriteOfType(ctx, key, 'set');
  let removed = 0;
  if (set !== null) {
    for (let i = 2; i < ctx.argv.length; i++) if (set.value.delete(ctx.argv[i]!)) removed++;
    if (removed > 0) {
      if (set.value.size === 0) ctx.db.delete(key);
      ctx.db.signalModifiedKey(key);
    }
  }
  ctx.reply.integer(removed);
}

export function sismemberCommand(ctx: CommandContext): void {
  const set = lookupReadOfType(ctx, ctx.argv[1]!, 'set');
  ctx.reply.integer(set !== null && set.value.has(ctx.argv[2]!) ? 1 : 0);
}

export function scardCommand(ctx: CommandContext): void {
  const set = lookupReadOfType(ctx, ctx.argv[1]!, 'set');
  ctx.reply.integer(set === null ? 0 : set.value.size);
}

/** A set in RESP3 (spec 7.3). */
export function smembersCommand(ctx: CommandContext): void {
  ctx.reply.set(membersOf(lookupReadOfType(ctx, ctx.argv[1]!, 'set')));
}

export function spopCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  if (ctx.argv.length > 3) throw new ReplyError(ERR.SYNTAX);
  if (ctx.argv.length === 2) {
    const set = lookupWriteOfType(ctx, key, 'set');
    if (set === null) {
      ctx.reply.nullBulk();
      return;
    }
    const [member] = set.value.randomEntry()!;
    set.value.delete(member);
    if (set.value.size === 0) {
      ctx.db.delete(key);
      ctx.rewritePropagation(['DEL', key]);
    } else {
      ctx.rewritePropagation(['SREM', key, member]);
    }
    ctx.db.signalModifiedKey(key);
    ctx.reply.bulk(member);
    return;
  }

  // Redis passes its range message as the parse error too, so 'abc' is "out of range".
  const n = parseInt64(ctx.argv[2]!);
  if (n === null || n < 0n) throw new ReplyError(ERR.NOT_POSITIVE);
  const count = clampToSafe(n);
  const set = lookupWriteOfType(ctx, key, 'set');
  if (set === null || count === 0) {
    ctx.reply.set([]);
    return;
  }
  if (count >= set.value.size) {
    const all = membersOf(set);
    ctx.db.delete(key);
    ctx.rewritePropagation(['DEL', key]);
    ctx.db.signalModifiedKey(key);
    ctx.reply.set(all);
    return;
  }
  const popped: string[] = [];
  while (popped.length < count) {
    const [member] = set.value.randomEntry()!;
    set.value.delete(member);
    popped.push(member);
  }
  ctx.rewritePropagation(['SREM', key, ...popped]);
  ctx.db.signalModifiedKey(key);
  ctx.reply.set(popped);
}

export function srandmemberCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  if (ctx.argv.length > 3) throw new ReplyError(ERR.SYNTAX);
  if (ctx.argv.length === 2) {
    const set = lookupReadOfType(ctx, key, 'set');
    if (set === null) ctx.reply.nullBulk();
    else ctx.reply.bulk(set.value.randomEntry()![0]);
    return;
  }

  const n = parseInt64(ctx.argv[2]!);
  if (n === null) throw new ReplyError(ERR.NOT_INTEGER);
  if (n === INT64_MIN) throw new ReplyError(ERR.SRANDMEMBER_RANGE);
  if (n < -BigInt(SRANDMEMBER_MAX_REPEATS)) {
    throw new ReplyError(
      `ERR value is out of range, value must between -${SRANDMEMBER_MAX_REPEATS} and 9223372036854775807`,
    );
  }
  const set = lookupReadOfType(ctx, key, 'set');
  if (set === null || n === 0n) {
    ctx.reply.array([]);
    return;
  }
  const dict = set.value;
  if (n < 0n) {
    // Repeats allowed: independent draws.
    const out: string[] = [];
    for (let i = Number(-n); i > 0; i--) out.push(dict.randomEntry()![0]);
    ctx.reply.array(out);
    return;
  }
  const count = clampToSafe(n);
  if (count >= dict.size) {
    ctx.reply.array(membersOf(set));
    return;
  }
  // Distinct members. Asking for most of the set: copy it and drop random members until
  // `count` are left (Redis's case 3). Asking for a few: draw until `count` distinct (case 4).
  const picked = new Dict<true>(ctx.server.dictOptions);
  if (count * 3 > dict.size) {
    dict.forEach((m) => picked.set(m, true));
    while (picked.size > count) picked.delete(picked.randomEntry()![0]);
  } else {
    while (picked.size < count) picked.set(dict.randomEntry()![0], true);
  }
  const out: string[] = [];
  picked.forEach((m) => out.push(m));
  ctx.reply.array(out);
}

type SetOp = 'inter' | 'union' | 'diff';

/**
 * The sets under `keys`, null for a missing one. Every key is type-checked before anything is
 * computed. A STORE looks sources up for writing, as Redis does.
 */
function lookupSources(ctx: CommandContext, keys: readonly string[], forStore: boolean) {
  return keys.map((k) =>
    forStore ? lookupWriteOfType(ctx, k, 'set') : lookupReadOfType(ctx, k, 'set'),
  );
}

function compute(ctx: CommandContext, op: SetOp, sets: Array<SetObject | null>): string[] {
  if (op === 'inter') {
    if (sets.some((s) => s === null)) return [];
    // Walk the smallest set and probe the others, as Redis does.
    const sorted = (sets as SetObject[]).slice().sort((a, b) => a.value.size - b.value.size);
    const [first, ...rest] = sorted;
    const out: string[] = [];
    first!.value.forEach((m) => {
      if (rest.every((s) => s.value.has(m))) out.push(m);
    });
    return out;
  }
  const acc = new Dict<true>(ctx.server.dictOptions);
  if (op === 'union') {
    for (const s of sets) s?.value.forEach((m) => acc.set(m, true));
  } else {
    const [first, ...rest] = sets;
    first?.value.forEach((m) => {
      if (!rest.some((s) => s !== null && s.value.has(m))) acc.set(m, true);
    });
  }
  const out: string[] = [];
  acc.forEach((m) => out.push(m));
  return out;
}

function setOpCommand(ctx: CommandContext, op: SetOp): void {
  const sets = lookupSources(ctx, ctx.argv.slice(1), false);
  ctx.reply.set(compute(ctx, op, sets));
}

function setOpStoreCommand(ctx: CommandContext, op: SetOp): void {
  const dst = ctx.argv[1]!;
  const sets = lookupSources(ctx, ctx.argv.slice(2), true);
  const result = compute(ctx, op, sets);
  // Looked up even though it's overwritten: lazy expiry and the snapshot hook see it (rule 5).
  ctx.db.lookupWrite(dst);
  if (result.length > 0) {
    const obj = createSetObject(ctx.server.dictOptions);
    for (const m of result) obj.value.set(m, true);
    ctx.db.setKey(dst, obj);
    ctx.db.signalModifiedKey(dst);
  } else if (ctx.db.delete(dst)) {
    ctx.db.signalModifiedKey(dst);
  }
  ctx.reply.integer(result.length);
}

export const sinterCommand = (ctx: CommandContext): void => setOpCommand(ctx, 'inter');
export const sunionCommand = (ctx: CommandContext): void => setOpCommand(ctx, 'union');
export const sdiffCommand = (ctx: CommandContext): void => setOpCommand(ctx, 'diff');
export const sinterstoreCommand = (ctx: CommandContext): void => setOpStoreCommand(ctx, 'inter');
export const sunionstoreCommand = (ctx: CommandContext): void => setOpStoreCommand(ctx, 'union');
export const sdiffstoreCommand = (ctx: CommandContext): void => setOpStoreCommand(ctx, 'diff');

export function sscanCommand(ctx: CommandContext): void {
  const cursor = parseCursor(ctx.argv[2]!);
  const set = lookupReadOfType(ctx, ctx.argv[1]!, 'set');
  if (set === null) {
    ctx.reply.array(['0', []]);
    return;
  }
  const opts = parseScanOptions(ctx.argv, 3, false);
  const { next, visited } = scanPage<true>(cursor, opts.count, (c, fn) => set.value.scan(c, fn));
  const out: string[] = [];
  for (const [member] of visited) if (matches(opts, member)) out.push(member);
  ctx.reply.array([String(next), out]);
}

export const setCommands: CommandSpec[] = [
  command('sadd', -3, ['write', 'denyoom'], [1, 1, 1], saddCommand),
  command('srem', -3, ['write'], [1, 1, 1], sremCommand),
  command('sismember', 3, ['readonly'], [1, 1, 1], sismemberCommand),
  command('smembers', 2, ['readonly'], [1, 1, 1], smembersCommand),
  command('scard', 2, ['readonly'], [1, 1, 1], scardCommand),
  command('spop', -2, ['write'], [1, 1, 1], spopCommand),
  command('srandmember', -2, ['readonly'], [1, 1, 1], srandmemberCommand),
  command('sinter', -2, ['readonly'], [1, -1, 1], sinterCommand),
  command('sunion', -2, ['readonly'], [1, -1, 1], sunionCommand),
  command('sdiff', -2, ['readonly'], [1, -1, 1], sdiffCommand),
  command('sinterstore', -3, ['write', 'denyoom'], [1, -1, 1], sinterstoreCommand),
  command('sunionstore', -3, ['write', 'denyoom'], [1, -1, 1], sunionstoreCommand),
  command('sdiffstore', -3, ['write', 'denyoom'], [1, -1, 1], sdiffstoreCommand),
  command('sscan', -3, ['readonly'], [1, 1, 1], sscanCommand),
];
