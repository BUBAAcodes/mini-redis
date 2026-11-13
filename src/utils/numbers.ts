/**
 * Strict number parsing and formatting (spec 7.2): int64 as BigInt, floats as doubles, and the
 * clamp from int64 to a safe JS number for indexes and counts.
 *
 * Key design choice: integers parse to BigInt, so the whole signed 64-bit range is exact and
 * range checks can't be fooled by doubles rounding 9223372036854775808 down to INT64_MAX.
 * Floats are plain doubles (Redis uses 80-bit long doubles, so the last digits can differ).
 *
 * Mirrors Redis util.c (string2ll, string2ld, ld2string).
 */

export const INT64_MIN = -(2n ** 63n);
export const INT64_MAX = 2n ** 63n - 1n;

/** Optional '-', then digits with no leading zero; "-0" isn't allowed either (string2ll). */
const STRICT_INT = /^(?:0|-?[1-9][0-9]*)$/;

/** The int64 a byte string spells under Redis's strict rules, or null. */
export function parseInt64(s: string): bigint | null {
  // 20 chars covers "-9223372036854775808"; longer can't be in range, so skip the BigInt.
  if (s.length === 0 || s.length > 20 || !STRICT_INT.test(s)) return null;
  const n = BigInt(s);
  return n < INT64_MIN || n > INT64_MAX ? null : n;
}

/** `a + b` if it fits in int64, else null (INCRBY and friends reply "would overflow"). */
export function addInt64(a: bigint, b: bigint): bigint | null {
  const sum = a + b;
  return sum < INT64_MIN || sum > INT64_MAX ? null : sum;
}

/**
 * Any int64 as a JS integer that's safe to use as an index or length: values beyond
 * ±(2^53 - 1) are far past any string or list we can hold, so clamping changes no result.
 */
export function clampToSafe(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  if (n < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
  return Number(n);
}

const FINITE_DOUBLE = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const INFINITY_WORD = /^[+-]?inf$/i;

/**
 * The double a byte string spells, or null. Accepts decimals, exponents and `inf`, `+inf`,
 * `-inf` in any case; rejects `nan`, the empty string, spaces, and finite text that overflows
 * (strtold sets ERANGE for `1e999`, and Redis refuses it).
 */
export function parseDouble(s: string): number | null {
  if (INFINITY_WORD.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (!FINITE_DOUBLE.test(s)) return null;
  const x = Number(s);
  return Number.isFinite(x) ? x : null;
}

/**
 * The shortest string that parses back to `x`, never in exponent notation: `1e21` prints as
 * `1000000000000000000000` and `1e-7` as `0.0000001`. Infinities print as `inf` and `-inf`.
 */
export function formatDouble(x: number): string {
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  const text = String(x);
  const e = text.indexOf('e');
  if (e === -1) return text;
  // "d.ddde±X": move the decimal point X places instead of printing the exponent.
  const exp = Number(text.slice(e + 1));
  const negative = text.startsWith('-');
  const [intPart, fracPart = ''] = text.slice(negative ? 1 : 0, e).split('.');
  const digits = intPart! + fracPart;
  const point = intPart!.length + exp;
  const body =
    point <= 0
      ? `0.${'0'.repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + '0'.repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${body}` : body;
}
