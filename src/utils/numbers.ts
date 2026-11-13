/**
 * Strict number parsing (spec 7.2). Step 5 needs only integers, for SELECT and CONFIG; step 6
 * adds floats, the safe-number clamping and formatting.
 *
 * Key design choice: integers parse to BigInt, so the whole signed 64-bit range is exact and
 * range checks can't be fooled by doubles rounding 9223372036854775808 down to INT64_MAX.
 *
 * Mirrors Redis util.c (string2ll).
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
