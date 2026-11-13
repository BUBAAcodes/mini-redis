# ADR 0002: Dicts hash with MurmurHash3, seeded at random

**Status:** accepted (step 4)

## Context

Every keyspace, hash and set lives in our own `Dict` (spec 10.2), which picks a bucket from the low bits of a 32-bit hash. If a client can predict the hash, it can send thousands of keys that all land in one bucket. Every lookup in that bucket then turns into a linear scan, and one client can stall the single thread (hash flooding). Redis avoids this with SipHash-1-2 and a random 128-bit key (`siphash.c`, `dictGenHashFunction` in `server.c`).

## Decision

`src/utils/hash.ts` implements MurmurHash3 x86 32-bit over the latin1 byte string, one char per byte, with no encoding step. The seed is a random 32-bit value chosen once per server at startup and passed to every dict through `DictOptions`, never stored in module state. The test vectors in `tests/unit/hash.test.ts` pin the implementation.

## Consequences

- Fast in JS: only 32-bit `Math.imul` and shifts, with no BigInt and no allocation. SipHash needs 64-bit arithmetic, which costs BigInt or paired 32-bit words in JS.
- A random seed blocks precomputed collision sets, which is the practical attack. MurmurHash3 isn't a keyed PRF the way SipHash is: there are known seed-independent multicollision attacks on it. We accept that for a study project and record it here. A production server should use SipHash, as Redis does.
- Bucket layouts differ between runs, so SCAN order and `randomEntries` are not reproducible unless a test fixes the seed. The tests do, through `new Random(seed)`.
- 32-bit hashes cap a table at 2^32 buckets. That's far beyond what fits in a V8 heap.
