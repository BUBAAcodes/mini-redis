/**
 * The SCAN family's shared parts: the cursor, the MATCH, COUNT and TYPE options, and the
 * bounded stepping loop, used by SCAN, HSCAN, SSCAN and ZSCAN.
 *
 * Key design choice: one loop for every SCAN. It keeps stepping until it has `count` entries or
 * has taken `count × 10` steps (spec 10.2), so a page costs bounded work whatever the table
 * looks like, and filtering happens after the stepping, as in Redis. A page can therefore come
 * back empty with a non-zero cursor. Redis returns a small (listpack) collection in one call
 * with cursor 0; we page small collections like big ones (DIFFERENCES.md).
 *
 * Mirrors Redis db.c (parseScanCursorOrReply, scanGenericCommand).
 */
import { ERR, ReplyError } from '../protocol/errors.js';
import { stringMatch } from '../utils/glob.js';
import { parseInt64 } from '../utils/numbers.js';

/** Redis reads the cursor with strtoul: digits only, and it must fit in 64 bits. */
export function parseCursor(s: string): number {
  if (!/^[0-9]+$/.test(s) || BigInt(s) > 0xffff_ffff_ffff_ffffn) {
    throw new ReplyError(ERR.INVALID_CURSOR);
  }
  // Our cursors are 32-bit (spec 10.2); a larger one just wraps, as a stale cursor would.
  return Number(BigInt(s) & 0xffff_ffffn);
}

export interface ScanOptions {
  count: number;
  /** null, or a glob; '*' is turned into null since it matches everything. */
  pattern: string | null;
  /** SCAN only: a lowercase type name, or null. */
  type: string | null;
}

/** The options from `argv[start]` on. TYPE is only accepted when `allowType` (plain SCAN). */
export function parseScanOptions(
  argv: readonly string[],
  start: number,
  allowType: boolean,
): ScanOptions {
  const opts: ScanOptions = { count: 10, pattern: null, type: null };
  for (let i = start; i < argv.length;) {
    const opt = argv[i]!.toUpperCase();
    const hasValue = i + 1 < argv.length;
    if (opt === 'COUNT' && hasValue) {
      const n = parseInt64(argv[i + 1]!);
      if (n === null) throw new ReplyError(ERR.NOT_INTEGER);
      if (n < 1n) throw new ReplyError(ERR.SYNTAX);
      opts.count = n > 0x7fff_ffffn ? 0x7fff_ffff : Number(n);
      i += 2;
    } else if (opt === 'MATCH' && hasValue) {
      opts.pattern = argv[i + 1]! === '*' ? null : argv[i + 1]!;
      i += 2;
    } else if (allowType && opt === 'TYPE' && hasValue) {
      opts.type = argv[i + 1]!.toLowerCase();
      i += 2;
    } else {
      throw new ReplyError(ERR.SYNTAX);
    }
  }
  return opts;
}

/**
 * Runs `step` from `cursor` until `count` entries were visited or `count × 10` steps were
 * taken, and returns the entries visited (unfiltered) with the next cursor (0 = done).
 */
export function scanPage<V>(
  cursor: number,
  count: number,
  step: (cursor: number, fn: (key: string, value: V) => void) => number,
): { next: number; visited: Array<[string, V]> } {
  const visited: Array<[string, V]> = [];
  let next = cursor;
  let steps = count * 10;
  do {
    next = step(next, (key, value) => visited.push([key, value]));
  } while (next !== 0 && --steps > 0 && visited.length < count);
  return { next, visited };
}

/** True if `key` passes the MATCH filter. */
export const matches = (opts: ScanOptions, key: string): boolean =>
  opts.pattern === null || stringMatch(opts.pattern, key);
