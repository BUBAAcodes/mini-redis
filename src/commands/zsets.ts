/**
 * Sorted set commands (spec 8.6), on a ZSet (dict + skip list, spec 10.3). ZMSCORE, ZLEXCOUNT,
 * ZREVRANGEBYLEX, ZREMRANGEBYLEX and ZRANDMEMBER are † (left to write by hand).
 *
 * Key design choice: ZRANGE, ZRANGEBYSCORE, ZREVRANGEBYSCORE, ZRANGEBYLEX and ZREVRANGE are one
 * engine, `zrangeGeneric`, as in Redis 7: the old commands just preset the range type and
 * direction, which also makes the same options syntax errors for them (BYSCORE on
 * ZRANGEBYSCORE). Each handler checks every argument before it changes anything (rule 4), in
 * Redis's order. Numbers are parsed the way Redis parses each one. Scores, increments and
 * weights use getDoubleFromObject (`parseStrictDouble`); range bounds use plain strtod
 * (`parseStrtodDouble`), where '' is 0 and a leading space is fine. Scores are written with the
 * encoder's d2string-exact formatter, as doubles in RESP3. A sorted set that empties is deleted.
 * Nothing here is random or relative, so every write propagates as sent.
 *
 * Mirrors Redis t_zset.c (zaddGenericCommand, zincrbyCommand, zscoreCommand, zcardCommand,
 * zcountCommand, zrangeGenericCommand, genericZrangebyrankCommand, genericZrangebyscoreCommand,
 * genericZrangebylexCommand, zrankGenericCommand, zremCommand, zremrangeGenericCommand,
 * genericZpopCommand, zunionInterDiffGenericCommand, zscanCommand, zslParseRange,
 * zslParseLexRange).
 */
import {
  LEX_MAX,
  LEX_MIN,
  lexGteMin,
  lexLteMax,
  scoreGteMin,
  scoreLteMax,
} from '../datastructures/skiplist.js';
import type { LexBound, LexRange, ScoreRange, SkiplistNode } from '../datastructures/skiplist.js';
import { Dict } from '../datastructures/dict.js';
import type { ZAddFlags } from '../datastructures/zset.js';
import { formatDouble as d2string } from '../protocol/encoder.js';
import { ERR, ReplyError, wrongArity } from '../protocol/errors.js';
import { createZsetObject } from '../storage/redis-object.js';
import type { SetObject, ZSetObject } from '../storage/redis-object.js';
import { clampToSafe, parseInt64, parseStrictDouble, parseStrtodDouble } from '../utils/numbers.js';
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';
import { matches, parseCursor, parseScanOptions, scanPage } from './scan.js';
import { lookupReadOfType, lookupWriteOfType } from './typed.js';

// ---------------------------------------------------------------- parsing

function parseLong(s: string): number {
  const n = parseInt64(s);
  if (n === null) throw new ReplyError(ERR.NOT_INTEGER);
  return clampToSafe(n);
}

function parseScore(s: string): number {
  const x = parseStrictDouble(s);
  if (x === null) throw new ReplyError(ERR.NOT_FLOAT);
  return x;
}

/** zslParseRange: `(` makes a bound exclusive; the number is read by plain strtod. */
export function parseScoreRange(minArg: string, maxArg: string): ScoreRange {
  const bound = (s: string): [number, boolean] => {
    const ex = s.startsWith('(');
    const x = parseStrtodDouble(ex ? s.slice(1) : s);
    if (x === null) throw new ReplyError(ERR.MIN_MAX_NOT_FLOAT);
    return [x, ex];
  };
  const [min, minex] = bound(minArg);
  const [max, maxex] = bound(maxArg);
  return { min, max, minex, maxex };
}

/** zslParseLexRange: `-` and `+` alone, or `[x` (inclusive) / `(x` (exclusive). */
export function parseLexRange(minArg: string, maxArg: string): LexRange {
  const bound = (s: string): [LexBound, boolean] => {
    if (s === '-') return [LEX_MIN, false];
    if (s === '+') return [LEX_MAX, false];
    if (s.startsWith('(')) return [s.slice(1), true];
    if (s.startsWith('[')) return [s.slice(1), false];
    throw new ReplyError(ERR.MIN_MAX_NOT_LEX);
  };
  const [min, minex] = bound(minArg);
  const [max, maxex] = bound(maxArg);
  return { min, max, minex, maxex };
}

/** ZPOPMIN / ZPOPMAX counts: Redis passes its range message as the parse error too. */
function parsePositiveCount(s: string): number {
  const n = parseInt64(s);
  if (n === null || n < 0n) throw new ReplyError(ERR.NOT_POSITIVE);
  return clampToSafe(n);
}

// ---------------------------------------------------------------- replies

type Scored = [member: string, score: number];

/** Members alone; or with scores: flat pairs in RESP2, [member, score] arrays in RESP3. */
function replyScored(ctx: CommandContext, items: readonly Scored[], withScores: boolean): void {
  const reply = ctx.reply;
  if (!withScores) {
    reply.array(items.map(([m]) => m));
    return;
  }
  if (reply.resp === 3) {
    reply.arrayLen(items.length);
    for (const [m, s] of items) {
      reply.arrayLen(2);
      reply.bulk(m);
      reply.double(s);
    }
  } else {
    reply.arrayLen(items.length * 2);
    for (const [m, s] of items) {
      reply.bulk(m);
      reply.double(s);
    }
  }
}

/** After a removal: delete the key if the set is empty, then signal the change once. */
function afterRemove(ctx: CommandContext, key: string, zset: ZSetObject): void {
  if (zset.value.size === 0) ctx.db.delete(key);
  ctx.db.signalModifiedKey(key);
}

// ---------------------------------------------------------------- ZADD, ZINCRBY

function zaddGeneric(ctx: CommandContext, start: number, forceIncr: boolean): void {
  const argv = ctx.argv;
  const key = argv[1]!;
  const flags: ZAddFlags = { incr: forceIncr };
  let ch = false;
  let i = start;
  for (; i < argv.length; i++) {
    const opt = argv[i]!.toUpperCase();
    if (opt === 'NX') flags.nx = true;
    else if (opt === 'XX') flags.xx = true;
    else if (opt === 'GT') flags.gt = true;
    else if (opt === 'LT') flags.lt = true;
    else if (opt === 'CH') ch = true;
    else if (opt === 'INCR') flags.incr = true;
    else break;
  }
  // Checked in Redis's order: pairs, then the flag clashes, then the scores.
  const elements = argv.length - i;
  if (elements === 0 || elements % 2 === 1) throw new ReplyError(ERR.SYNTAX);
  if (flags.nx && flags.xx) throw new ReplyError(ERR.ZADD_XX_NX);
  if ((flags.gt && flags.lt) || (flags.gt && flags.nx) || (flags.lt && flags.nx)) {
    throw new ReplyError(ERR.ZADD_GT_LT_NX);
  }
  if (flags.incr && elements > 2) throw new ReplyError(ERR.ZADD_INCR_PAIR);
  const pairs: Scored[] = [];
  for (let j = i; j < argv.length; j += 2) pairs.push([argv[j + 1]!, parseScore(argv[j]!)]);

  let zset = lookupWriteOfType(ctx, key, 'zset');
  if (zset === null) {
    if (flags.xx) {
      if (flags.incr) ctx.reply.nullBulk();
      else ctx.reply.integer(0);
      return;
    }
    zset = createZsetObject(ctx.server.dictOptions, ctx.server.rng);
    ctx.db.add(key, zset);
  }

  let added = 0;
  let updated = 0;
  let incrScore: number | null = null;
  for (const [member, score] of pairs) {
    const r = zset.value.add(member, score, flags);
    // NaN is only possible with INCR, which has a single pair, so nothing has changed yet.
    if (r.outcome === 'nan') throw new ReplyError(ERR.SCORE_NAN);
    if (r.outcome === 'added') added++;
    else if (r.outcome === 'updated') updated++;
    if (r.outcome !== 'skipped') incrScore = r.score;
  }
  // A set created just now always gains its first member, so it is never left empty.
  if (added + updated > 0) ctx.db.signalModifiedKey(key);

  if (flags.incr) {
    if (incrScore === null) ctx.reply.nullBulk();
    else ctx.reply.double(incrScore);
  } else {
    ctx.reply.integer(ch ? added + updated : added);
  }
}

export const zaddCommand = (ctx: CommandContext): void => zaddGeneric(ctx, 2, false);

export function zincrbyCommand(ctx: CommandContext): void {
  // ZINCRBY key incr member is ZADD key INCR incr member (Redis's zincrbyCommand does the same).
  zaddGeneric(ctx, 2, true);
}

// ---------------------------------------------------------------- reads

export function zscoreCommand(ctx: CommandContext): void {
  const zset = lookupReadOfType(ctx, ctx.argv[1]!, 'zset');
  const score = zset?.value.score(ctx.argv[2]!);
  if (score === undefined) ctx.reply.nullBulk();
  else ctx.reply.double(score);
}

export function zcardCommand(ctx: CommandContext): void {
  const zset = lookupReadOfType(ctx, ctx.argv[1]!, 'zset');
  ctx.reply.integer(zset === null ? 0 : zset.value.size);
}

export function zcountCommand(ctx: CommandContext): void {
  const range = parseScoreRange(ctx.argv[2]!, ctx.argv[3]!);
  const zset = lookupReadOfType(ctx, ctx.argv[1]!, 'zset');
  let count = 0;
  if (zset !== null) {
    const zsl = zset.value.zsl;
    const first = zsl.firstInRange(range);
    if (first !== null) {
      const last = zsl.lastInRange(range)!;
      count = zsl.rank(last.score, last.member) - zsl.rank(first.score, first.member) + 1;
    }
  }
  ctx.reply.integer(count);
}

type RangeType = 'auto' | 'rank' | 'score' | 'lex';
type Direction = 'auto' | 'forward' | 'reverse';

/** Up to `limit` nodes (-1 = all) from `start`, after skipping `offset`, while `keep` holds. */
function collect(
  start: SkiplistNode | null,
  reverse: boolean,
  offset: number,
  limit: number,
  keep: (n: SkiplistNode) => boolean,
): Scored[] {
  const out: Scored[] = [];
  // Redis's `while (ln && offset--)`: a negative offset walks off the end, so nothing is returned.
  if (offset < 0) return out;
  let n = start;
  for (let skip = offset; n !== null && skip > 0; skip--) n = reverse ? n.backward : n.next;
  for (let left = limit; n !== null && left !== 0; left--) {
    if (!keep(n)) break;
    out.push([n.member, n.score]);
    n = reverse ? n.backward : n.next;
  }
  return out;
}

/**
 * The one range engine (zrangeGenericCommand). `keyIdx` is argv's key position; the old
 * commands pass a preset `rangeType` and `direction`, so their own options are syntax errors.
 */
function zrangeGeneric(ctx: CommandContext, rangeType: RangeType, direction: Direction): void {
  const argv = ctx.argv;
  let withScores = false;
  let offset = 0;
  let limit = -1;
  for (let j = 4; j < argv.length; j++) {
    const opt = argv[j]!.toUpperCase();
    const left = argv.length - j - 1;
    if (opt === 'WITHSCORES') withScores = true;
    else if (opt === 'LIMIT' && left >= 2) {
      offset = parseLong(argv[j + 1]!);
      limit = parseLong(argv[j + 2]!);
      j += 2;
    } else if (direction === 'auto' && opt === 'REV') direction = 'reverse';
    else if (rangeType === 'auto' && opt === 'BYLEX') rangeType = 'lex';
    else if (rangeType === 'auto' && opt === 'BYSCORE') rangeType = 'score';
    else throw new ReplyError(ERR.SYNTAX);
  }
  if (direction === 'auto') direction = 'forward';
  if (rangeType === 'auto') rangeType = 'rank';
  if (limit !== -1 && rangeType === 'rank') throw new ReplyError(ERR.ZRANGE_LIMIT);
  if (withScores && rangeType === 'lex') throw new ReplyError(ERR.ZRANGE_WITHSCORES_BYLEX);
  const reverse = direction === 'reverse';
  // Score and lex ranges are given as max, min when reversed.
  let minArg = argv[2]!;
  let maxArg = argv[3]!;
  if (reverse && rangeType !== 'rank') [minArg, maxArg] = [maxArg, minArg];

  let items: Scored[] = [];
  if (rangeType === 'rank') {
    let start = parseLong(minArg);
    let end = parseLong(maxArg);
    const zset = lookupReadOfType(ctx, argv[1]!, 'zset');
    if (zset !== null) {
      const zsl = zset.value.zsl;
      const len = zsl.length;
      if (start < 0) start += len;
      if (end < 0) end += len;
      if (start < 0) start = 0;
      if (start <= end && start < len) {
        if (end >= len) end = len - 1;
        const first = zsl.byRank(reverse ? len - start : start + 1);
        items = collect(first, reverse, 0, end - start + 1, () => true);
      }
    }
  } else if (rangeType === 'score') {
    const range = parseScoreRange(minArg, maxArg);
    const zset = lookupReadOfType(ctx, argv[1]!, 'zset');
    if (zset !== null) {
      const zsl = zset.value.zsl;
      items = reverse
        ? collect(zsl.lastInRange(range), true, offset, limit, (n) => scoreGteMin(n.score, range))
        : collect(zsl.firstInRange(range), false, offset, limit, (n) =>
            scoreLteMax(n.score, range),
          );
    }
  } else {
    const range = parseLexRange(minArg, maxArg);
    const zset = lookupReadOfType(ctx, argv[1]!, 'zset');
    if (zset !== null) {
      const zsl = zset.value.zsl;
      items = reverse
        ? collect(zsl.lastInLexRange(range), true, offset, limit, (n) => lexGteMin(n.member, range))
        : collect(zsl.firstInLexRange(range), false, offset, limit, (n) =>
            lexLteMax(n.member, range),
          );
    }
  }
  replyScored(ctx, items, withScores);
}

export const zrangeCommand = (ctx: CommandContext): void => zrangeGeneric(ctx, 'auto', 'auto');
export const zrangebyscoreCommand = (ctx: CommandContext): void =>
  zrangeGeneric(ctx, 'score', 'forward');
export const zrevrangebyscoreCommand = (ctx: CommandContext): void =>
  zrangeGeneric(ctx, 'score', 'reverse');
export const zrangebylexCommand = (ctx: CommandContext): void =>
  zrangeGeneric(ctx, 'lex', 'forward');
export const zrevrangeCommand = (ctx: CommandContext): void =>
  zrangeGeneric(ctx, 'rank', 'reverse');

function zrankGeneric(ctx: CommandContext, reverse: boolean): void {
  const argv = ctx.argv;
  if (argv.length > 4) throw new ReplyError(wrongArity(argv[0]!.toLowerCase()));
  let withScore = false;
  if (argv.length === 4) {
    if (argv[3]!.toUpperCase() !== 'WITHSCORE') throw new ReplyError(ERR.SYNTAX);
    withScore = true;
  }
  const zset = lookupReadOfType(ctx, argv[1]!, 'zset');
  const member = argv[2]!;
  const rank = zset === null ? null : zset.value.rank(member, reverse);
  if (rank === null) {
    if (withScore) ctx.reply.nullArray();
    else ctx.reply.nullBulk();
    return;
  }
  if (!withScore) {
    ctx.reply.integer(rank);
    return;
  }
  ctx.reply.arrayLen(2);
  ctx.reply.integer(rank);
  ctx.reply.double(zset!.value.score(member)!);
}

export const zrankCommand = (ctx: CommandContext): void => zrankGeneric(ctx, false);
export const zrevrankCommand = (ctx: CommandContext): void => zrankGeneric(ctx, true);

// ---------------------------------------------------------------- removals

export function zremCommand(ctx: CommandContext): void {
  const key = ctx.argv[1]!;
  const zset = lookupWriteOfType(ctx, key, 'zset');
  let removed = 0;
  if (zset !== null) {
    for (let i = 2; i < ctx.argv.length; i++) if (zset.value.remove(ctx.argv[i]!)) removed++;
    if (removed > 0) afterRemove(ctx, key, zset);
  }
  ctx.reply.integer(removed);
}

export function zremrangebyrankCommand(ctx: CommandContext): void {
  let start = parseLong(ctx.argv[2]!);
  let end = parseLong(ctx.argv[3]!);
  const key = ctx.argv[1]!;
  const zset = lookupWriteOfType(ctx, key, 'zset');
  let removed = 0;
  if (zset !== null) {
    const len = zset.value.size;
    if (start < 0) start += len;
    if (end < 0) end += len;
    if (start < 0) start = 0;
    if (start <= end && start < len) {
      if (end >= len) end = len - 1;
      removed = zset.value.zsl.deleteRangeByRank(start + 1, end + 1, zset.value.forget);
      if (removed > 0) afterRemove(ctx, key, zset);
    }
  }
  ctx.reply.integer(removed);
}

export function zremrangebyscoreCommand(ctx: CommandContext): void {
  const range = parseScoreRange(ctx.argv[2]!, ctx.argv[3]!);
  const key = ctx.argv[1]!;
  const zset = lookupWriteOfType(ctx, key, 'zset');
  let removed = 0;
  if (zset !== null) {
    removed = zset.value.zsl.deleteRangeByScore(range, zset.value.forget);
    if (removed > 0) afterRemove(ctx, key, zset);
  }
  ctx.reply.integer(removed);
}

function zpopGeneric(ctx: CommandContext, max: boolean): void {
  const argv = ctx.argv;
  if (argv.length > 3) throw new ReplyError(ERR.SYNTAX);
  const counted = argv.length === 3;
  const count = counted ? parsePositiveCount(argv[2]!) : 1;
  const key = argv[1]!;
  const zset = lookupWriteOfType(ctx, key, 'zset');
  if (zset === null || count === 0) {
    ctx.reply.array([]);
    return;
  }
  const popped: Scored[] = [];
  const zsl = zset.value.zsl;
  while (popped.length < count && zset.value.size > 0) {
    const n = max ? zsl.last! : zsl.first!;
    popped.push([n.member, n.score]);
    zset.value.remove(n.member);
  }
  afterRemove(ctx, key, zset);
  if (counted) {
    replyScored(ctx, popped, true);
  } else {
    // Without a count the reply is one flat [member, score], even in RESP3.
    const [m, s] = popped[0]!;
    ctx.reply.arrayLen(2);
    ctx.reply.bulk(m);
    ctx.reply.double(s);
  }
}

export const zpopminCommand = (ctx: CommandContext): void => zpopGeneric(ctx, false);
export const zpopmaxCommand = (ctx: CommandContext): void => zpopGeneric(ctx, true);

// ---------------------------------------------------------------- ZUNIONSTORE, ZINTERSTORE

type Aggregate = 'SUM' | 'MIN' | 'MAX';

interface Source {
  obj: ZSetObject | SetObject | null;
  weight: number;
}

const sourceSize = (s: Source): number => s.obj?.value.size ?? 0;

/** A member's score in a source (a plain set's members score 1), or undefined. */
function sourceScore(s: Source, member: string): number | undefined {
  if (s.obj === null) return undefined;
  if (s.obj.type === 'zset') return s.obj.value.score(member);
  return s.obj.value.has(member) ? 1 : undefined;
}

function forEachInSource(s: Source, fn: (member: string, score: number) => void): void {
  if (s.obj === null) return;
  if (s.obj.type === 'zset') s.obj.value.dict.forEach(fn);
  else s.obj.value.forEach((m) => fn(m, 1));
}

/** weight × score, with NaN (inf × 0) as 0, as Redis does. */
function weighted(s: Source, score: number): number {
  const x = s.weight * score;
  return Number.isNaN(x) ? 0 : x;
}

/** zunionInterAggregate: a NaN sum (inf + -inf) becomes 0. */
function aggregate(agg: Aggregate, acc: number, x: number): number {
  if (agg === 'SUM') {
    const sum = acc + x;
    return Number.isNaN(sum) ? 0 : sum;
  }
  if (agg === 'MIN') return x < acc ? x : acc;
  return x > acc ? x : acc;
}

function zstoreGeneric(ctx: CommandContext, op: 'union' | 'inter'): void {
  const argv = ctx.argv;
  const name = argv[0]!.toLowerCase();
  const dst = argv[1]!;
  const numkeys = parseLong(argv[2]!);
  if (numkeys < 1) throw new ReplyError(`ERR at least 1 input key is needed for '${name}' command`);
  if (numkeys > argv.length - 3) throw new ReplyError(ERR.SYNTAX);

  // Every source is looked up and type-checked before the options are parsed, as in Redis.
  const sources: Source[] = [];
  for (let i = 0; i < numkeys; i++) {
    const obj = ctx.db.lookupWrite(argv[3 + i]!);
    if (obj !== null && obj.type !== 'zset' && obj.type !== 'set') {
      throw new ReplyError(ERR.WRONGTYPE);
    }
    sources.push({ obj, weight: 1 });
  }

  let agg: Aggregate = 'SUM';
  for (let j = 3 + numkeys; j < argv.length;) {
    const opt = argv[j]!.toUpperCase();
    const remaining = argv.length - j;
    if (opt === 'WEIGHTS' && remaining >= numkeys + 1) {
      j++;
      for (const s of sources) {
        const w = parseStrictDouble(argv[j++]!);
        if (w === null) throw new ReplyError(ERR.WEIGHT_NOT_FLOAT);
        s.weight = w;
      }
    } else if (opt === 'AGGREGATE' && remaining >= 2) {
      const a = argv[j + 1]!.toUpperCase();
      if (a !== 'SUM' && a !== 'MIN' && a !== 'MAX') throw new ReplyError(ERR.SYNTAX);
      agg = a;
      j += 2;
    } else {
      throw new ReplyError(ERR.SYNTAX);
    }
  }

  // Smallest first, as Redis sorts its sources (a stable sort; Redis's qsort may order equal
  // sizes differently, which can only change the last bits of a 3-way float SUM).
  sources.sort((a, b) => sourceSize(a) - sourceSize(b));
  // Scores are aggregated in a scratch dict, then added through ZSet.add, the one place that
  // decides how a score is stored.
  const acc = new Dict<number>(ctx.server.dictOptions);
  if (op === 'inter') {
    const [first, ...rest] = sources;
    forEachInSource(first!, (member, score) => {
      let total = weighted(first!, score);
      for (const s of rest) {
        const other = sourceScore(s, member);
        if (other === undefined) return;
        total = aggregate(agg, total, weighted(s, other));
      }
      acc.set(member, total);
    });
  } else {
    for (const s of sources) {
      forEachInSource(s, (member, score) => {
        const x = weighted(s, score);
        const cur = acc.get(member);
        acc.set(member, cur === undefined ? x : aggregate(agg, cur, x));
      });
    }
  }
  const result = createZsetObject(ctx.server.dictOptions, ctx.server.rng);
  acc.forEach((member, score) => result.value.add(member, score));

  // Looked up even though it's overwritten: lazy expiry and the snapshot hook see it (rule 5).
  ctx.db.lookupWrite(dst);
  const size = result.value.size;
  if (size > 0) {
    ctx.db.setKey(dst, result);
    ctx.db.signalModifiedKey(dst);
  } else if (ctx.db.delete(dst)) {
    ctx.db.signalModifiedKey(dst);
  }
  ctx.reply.integer(size);
}

export const zunionstoreCommand = (ctx: CommandContext): void => zstoreGeneric(ctx, 'union');
export const zinterstoreCommand = (ctx: CommandContext): void => zstoreGeneric(ctx, 'inter');

// ---------------------------------------------------------------- ZSCAN

export function zscanCommand(ctx: CommandContext): void {
  const cursor = parseCursor(ctx.argv[2]!);
  const zset = lookupReadOfType(ctx, ctx.argv[1]!, 'zset');
  if (zset === null) {
    ctx.reply.array(['0', []]);
    return;
  }
  const opts = parseScanOptions(ctx.argv, 3, false);
  const { next, visited } = scanPage<number>(cursor, opts.count, (c, fn) =>
    zset.value.dict.scan(c, fn),
  );
  const out: string[] = [];
  // Scores are bulk strings here even in RESP3, as in Redis.
  for (const [member, score] of visited)
    if (matches(opts, member)) out.push(member, d2string(score));
  ctx.reply.array([String(next), out]);
}

export const zsetCommands: CommandSpec[] = [
  command('zadd', -4, ['write', 'denyoom'], [1, 1, 1], zaddCommand),
  command('zincrby', 4, ['write', 'denyoom'], [1, 1, 1], zincrbyCommand),
  command('zscore', 3, ['readonly'], [1, 1, 1], zscoreCommand),
  command('zcard', 2, ['readonly'], [1, 1, 1], zcardCommand),
  command('zcount', 4, ['readonly'], [1, 1, 1], zcountCommand),
  command('zrange', -4, ['readonly'], [1, 1, 1], zrangeCommand),
  command('zrangebyscore', -4, ['readonly'], [1, 1, 1], zrangebyscoreCommand),
  command('zrevrangebyscore', -4, ['readonly'], [1, 1, 1], zrevrangebyscoreCommand),
  command('zrangebylex', -4, ['readonly'], [1, 1, 1], zrangebylexCommand),
  command('zrevrange', -4, ['readonly'], [1, 1, 1], zrevrangeCommand),
  command('zrank', -3, ['readonly'], [1, 1, 1], zrankCommand),
  command('zrevrank', -3, ['readonly'], [1, 1, 1], zrevrankCommand),
  command('zrem', -3, ['write'], [1, 1, 1], zremCommand),
  command('zremrangebyrank', 4, ['write'], [1, 1, 1], zremrangebyrankCommand),
  command('zremrangebyscore', 4, ['write'], [1, 1, 1], zremrangebyscoreCommand),
  command('zpopmin', -2, ['write'], [1, 1, 1], zpopminCommand),
  command('zpopmax', -2, ['write'], [1, 1, 1], zpopmaxCommand),
  command('zscan', -3, ['readonly'], [1, 1, 1], zscanCommand),
  command('zunionstore', -4, ['write', 'denyoom'], [1, 1, 1], zunionstoreCommand),
  command('zinterstore', -4, ['write', 'denyoom'], [1, 1, 1], zinterstoreCommand),
];
