// Decides whether two replies to the same command count as equal (spec 15.3).
//
// Key design choice: replies are compared as exact bytes, and the only exceptions are the two
// the spec allows: unordered replies (KEYS, until sets and hashes arrive) are compared as sorted
// lists, and positive TTL/PTTL values may differ by up to 1 s / 100 ms because the two servers
// read their clocks at different moments. Anything else that differs gets fixed in MiniRedis,
// not here (the rule in 15.3).
import type { Exchange, RespValue } from '../helpers/resp-client.js';

/** Replies whose element order is unspecified, so they are compared as sorted lists. */
const UNORDERED = new Set(['keys', 'smembers', 'sinter', 'sunion', 'sdiff', 'hkeys', 'hvals']);
/** Replies that are flat field/value pairs in unspecified order: compared as sorted pairs. */
const UNORDERED_PAIRS = new Set(['hgetall']);

const TTL_TOLERANCE: Record<string, number> = { ttl: 1, pttl: 100 };

const asText = (v: RespValue): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));

function sortedItems(v: RespValue, pairs: boolean): string[] | null {
  if (!Array.isArray(v)) return null;
  if (!pairs) return v.map(asText).sort();
  const out: string[] = [];
  for (let i = 0; i + 1 < v.length; i += 2) out.push(asText([v[i]!, v[i + 1]!]));
  return out.sort();
}

export function repliesMatch(argv: readonly string[], ref: Exchange, mine: Exchange): boolean {
  if (ref.raw === mine.raw) return true;
  const name = (argv[0] ?? '').toLowerCase();

  const tolerance = TTL_TOLERANCE[name];
  if (tolerance !== undefined) {
    const a = ref.value;
    const b = mine.value;
    // -1 and -2 must match exactly (that's the raw check above); only positives get slack.
    return (
      typeof a === 'number' &&
      typeof b === 'number' &&
      a > 0 &&
      b > 0 &&
      Math.abs(a - b) <= tolerance
    );
  }

  if (UNORDERED.has(name) || UNORDERED_PAIRS.has(name)) {
    const a = sortedItems(ref.value, UNORDERED_PAIRS.has(name));
    const b = sortedItems(mine.value, UNORDERED_PAIRS.has(name));
    return a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return false;
}
