/**
 * Key commands (spec 8.2, except the TTL ones in step 7): DEL, UNLINK, EXISTS, TYPE, KEYS,
 * SCAN, RENAME, RANDOMKEY, DBSIZE, FLUSHDB and FLUSHALL.
 *
 * Key design choice: KEYS is a full walk by design and FLUSH* clears in one go (rule 10 allows
 * both), but SCAN does a bounded number of steps and only filters (MATCH, TYPE) what it
 * visited, so a page may come back empty while the cursor is still non-zero. DEL signals each
 * key it actually removed, once, so `DEL a a` replies 1 and a DEL of missing keys changes
 * nothing and propagates nothing.
 *
 * Mirrors Redis db.c (delGenericCommand, existsCommand, typeCommand, keysCommand,
 * scanGenericCommand, renameGenericCommand, randomkeyCommand, dbsizeCommand) and
 * db.c/cluster.c flushdbCommand and flushallCommand.
 */
import { ERR, ReplyError } from '../protocol/errors.js';
import { stringMatch } from '../utils/glob.js';
import { parseInt64 } from '../utils/numbers.js';
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
];
