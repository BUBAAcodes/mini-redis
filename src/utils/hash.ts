/**
 * MurmurHash3 (x86, 32-bit) over a latin1 byte string: the hash every Dict uses (spec 10.2).
 *
 * Key design choice: the seed comes from the server's random generator at startup, so nobody can
 * work out ahead of time a set of keys that all land in one bucket and turn every lookup into a
 * linear scan (hash flooding). It hashes the bytes of the string directly, one char per byte
 * (spec 7.1), with no encoding step. See docs/adr/0002-murmurhash3-random-seed.md.
 *
 * Mirrors Redis's siphash.c, used by dictGenHashFunction() in server.c with a random key, for
 * the same reason.
 */

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

/** Returns the unsigned 32-bit MurmurHash3 of `s`, read as bytes in little-endian blocks. */
export function murmur3_32(s: string, seed: number): number {
  const len = s.length;
  const blocksEnd = len & ~3;
  let h = seed | 0;
  let i = 0;

  for (; i < blocksEnd; i += 4) {
    // `& 0xff` keeps the hash defined even if a non-byte string ever slips in (rule 2).
    let k =
      (s.charCodeAt(i) & 0xff) |
      ((s.charCodeAt(i + 1) & 0xff) << 8) |
      ((s.charCodeAt(i + 2) & 0xff) << 16) |
      ((s.charCodeAt(i + 3) & 0xff) << 24);
    k = Math.imul(k, C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, C2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  const rest = len & 3;
  if (rest > 0) {
    let k = 0;
    if (rest === 3) k ^= (s.charCodeAt(i + 2) & 0xff) << 16;
    if (rest >= 2) k ^= (s.charCodeAt(i + 1) & 0xff) << 8;
    k ^= s.charCodeAt(i) & 0xff;
    k = Math.imul(k, C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, C2);
    h ^= k;
  }

  // The finaliser makes every input bit affect every output bit, so masking off the low bits for
  // a bucket index still uses the whole key.
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
