/**
 * Hash commands (spec 8.4), on a Dict of field → value. HSETNX, HMSET, HSTRLEN and HRANDFIELD
 * are † (left to write by hand).
 *
 * Key design choice: a hash is a Dict<string>, never a JS Map (spec 0), so it gets the seeded
 * hash function, incremental rehashing and the reverse-binary SCAN cursor for free. Every
 * handler checks all its arguments before it changes anything (rule 4), in Redis's order, so
 * the same bad call gets the same error on both servers. HINCRBY does its math in BigInt
 * (ADR 0004). HINCRBYFLOAT is propagated as `HSET key field <result>`, because float math done
 * again elsewhere could round differently (spec 9.5, ADR 0005). A hash whose last field is
 * deleted is deleted with it.
 *
 * Mirrors Redis t_hash.c (hsetCommand, hgetCommand, hmgetCommand, hdelCommand, hlenCommand,
 * hexistsCommand, genericHgetallCommand, hincrbyCommand, hincrbyfloatCommand, hscanCommand).
 */
import { ERR, ReplyError, wrongArity } from '../protocol/errors.js';
import type { ReplyItem } from '../protocol/encoder.js';
import { createHashObject } from '../storage/redis-object.js';
import type { HashObject } from '../storage/redis-object.js';
import { addInt64, formatDouble, parseDouble, parseInt64 } from '../utils/numbers.js';
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';
import { matches, parseCursor, parseScanOptions, scanPage } from './scan.js';
import { lookupReadOfType, lookupWriteOfType } from './typed.js';

/** The hash under `key` for a write, created and added if missing (hashTypeLookupWriteOrCreate). */
function hashForWrite(ctx: CommandContext, key: string): HashObject {
  const existing = lookupWriteOfType(ctx, key, 'hash');
  if (existing !== null) return existing;
  const obj = createHashObject(ctx.server.dictOptions);
  ctx.db.add(key, obj);
  return obj;
}

export function hsetCommand(ctx: CommandContext): void {
  // Arity -4 allows `HSET k f v g`; fields and values must pair up.
  if (ctx.argv.length % 2 === 1) throw new ReplyError(wrongArity('hset'));
  const key = ctx.argv[1]!;
  const hash = hashForWrite(ctx, key);
  let created = 0;
  for (let i = 2; i < ctx.argv.length; i += 2) {
    if (hash.value.set(ctx.argv[i]!, ctx.argv[i + 1]!)) created++;
  }
  ctx.db.signalModifiedKey(key);
  ctx.reply.integer(created);
}

export function hgetCommand(ctx: CommandContext): void {
  const hash = lookupReadOfType(ctx, ctx.argv[1]!, 'hash');
  const value = hash?.value.get(ctx.argv[2]!);
  if (value === undefined) ctx.reply.nullBulk();
  else ctx.reply.bulk(value);
}

export function hmgetCommand(ctx: CommandContext): void {
  const hash = lookupReadOfType(ctx, ctx.argv[1]!, 'hash');
  const out: ReplyItem[] = [];
  for (let i = 2; i < ctx.argv.length; i++) out.push(hash?.value.get(ctx.argv[i]!) ?? null);
  ctx.reply.array(out);
}

export function hdelCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  const hash = lookupWriteOfType(ctx, key, 'hash');
  let deleted = 0;
  if (hash !== null) {
    for (let i = 2; i < ctx.argv.length; i++) {
      if (hash.value.delete(ctx.argv[i]!)) deleted++;
    }
    if (deleted > 0) {
      if (hash.value.size === 0) ctx.db.delete(key);
      ctx.db.signalModifiedKey(key);
    }
  }
  ctx.reply.integer(deleted);
}

export function hlenCommand(ctx: CommandContext): void {
  const hash = lookupReadOfType(ctx, ctx.argv[1]!, 'hash');
  ctx.reply.integer(hash === null ? 0 : hash.value.size);
}

export function hexistsCommand(ctx: CommandContext): void {
  const hash = lookupReadOfType(ctx, ctx.argv[1]!, 'hash');
  ctx.reply.integer(hash !== null && hash.value.has(ctx.argv[2]!) ? 1 : 0);
}

export function hkeysCommand(ctx: CommandContext): void {
  const hash = lookupReadOfType(ctx, ctx.argv[1]!, 'hash');
  const out: string[] = [];
  hash?.value.forEach((field) => out.push(field));
  ctx.reply.array(out);
}

export function hvalsCommand(ctx: CommandContext): void {
  const hash = lookupReadOfType(ctx, ctx.argv[1]!, 'hash');
  const out: string[] = [];
  hash?.value.forEach((_field, value) => out.push(value));
  ctx.reply.array(out);
}

/** A map in RESP3, a flat field/value array in RESP2 (spec 7.3). */
export function hgetallCommand(ctx: CommandContext): void {
  const hash = lookupReadOfType(ctx, ctx.argv[1]!, 'hash');
  const pairs: Array<[string, string]> = [];
  hash?.value.forEach((field, value) => pairs.push([field, value]));
  ctx.reply.map(pairs);
}

export function hincrbyCommand(ctx: CommandContext): void {
  const by = parseInt64(ctx.argv[3]!);
  if (by === null) throw new ReplyError(ERR.NOT_INTEGER);
  const key = ctx.argv[1]!;
  const field = ctx.argv[2]!;
  const existing = lookupWriteOfType(ctx, key, 'hash');
  let current = 0n;
  const old = existing?.value.get(field);
  if (old !== undefined) {
    const parsed = parseInt64(old);
    if (parsed === null) throw new ReplyError(ERR.HASH_NOT_INTEGER);
    current = parsed;
  }
  const result = addInt64(current, by);
  if (result === null) throw new ReplyError(ERR.OVERFLOW);
  hashForWrite(ctx, key).value.set(field, String(result));
  ctx.db.signalModifiedKey(key);
  ctx.reply.integer(result);
}

export function hincrbyfloatCommand(ctx: CommandContext): void {
  const by = parseDouble(ctx.argv[3]!);
  if (by === null) throw new ReplyError(ERR.NOT_FLOAT);
  // Unlike INCRBYFLOAT, Redis refuses an infinite increment before looking at the value.
  if (!Number.isFinite(by)) throw new ReplyError(ERR.VALUE_NAN_OR_INFINITY);
  const key = ctx.argv[1]!;
  const field = ctx.argv[2]!;
  const existing = lookupWriteOfType(ctx, key, 'hash');
  let current = 0;
  const old = existing?.value.get(field);
  if (old !== undefined) {
    const parsed = parseDouble(old);
    if (parsed === null) throw new ReplyError(ERR.HASH_NOT_FLOAT);
    current = parsed;
  }
  const result = current + by;
  if (!Number.isFinite(result)) throw new ReplyError(ERR.NAN_OR_INFINITY);
  const text = formatDouble(result);
  hashForWrite(ctx, key).value.set(field, text);
  ctx.db.signalModifiedKey(key);
  // The exact result, so a replica or an AOF replay can't round differently (spec 9.5).
  ctx.rewritePropagation(['HSET', key, field, text]);
  ctx.reply.bulk(text);
}

export function hscanCommand(ctx: CommandContext): void {
  const cursor = parseCursor(ctx.argv[2]!);
  const hash = lookupReadOfType(ctx, ctx.argv[1]!, 'hash');
  if (hash === null) {
    ctx.reply.array(['0', []]);
    return;
  }
  // Options are parsed after the lookup, as in Redis, so a missing key ignores bad ones.
  const opts = parseScanOptions(ctx.argv, 3, false);
  const { next, visited } = scanPage<string>(cursor, opts.count, (c, fn) => hash.value.scan(c, fn));
  const out: string[] = [];
  for (const [field, value] of visited) {
    if (matches(opts, field)) out.push(field, value);
  }
  ctx.reply.array([String(next), out]);
}

export const hashCommands: CommandSpec[] = [
  command('hset', -4, ['write', 'denyoom'], [1, 1, 1], hsetCommand),
  command('hget', 3, ['readonly'], [1, 1, 1], hgetCommand),
  command('hmget', -3, ['readonly'], [1, 1, 1], hmgetCommand),
  command('hdel', -3, ['write'], [1, 1, 1], hdelCommand),
  command('hexists', 3, ['readonly'], [1, 1, 1], hexistsCommand),
  command('hlen', 2, ['readonly'], [1, 1, 1], hlenCommand),
  command('hkeys', 2, ['readonly'], [1, 1, 1], hkeysCommand),
  command('hvals', 2, ['readonly'], [1, 1, 1], hvalsCommand),
  command('hgetall', 2, ['readonly'], [1, 1, 1], hgetallCommand),
  command('hincrby', 4, ['write', 'denyoom'], [1, 1, 1], hincrbyCommand),
  command('hincrbyfloat', 4, ['write', 'denyoom'], [1, 1, 1], hincrbyfloatCommand),
  command('hscan', -3, ['readonly'], [1, 1, 1], hscanCommand),
];
