# Step 04: Dict with incremental rehashing

## What this step built

`src/datastructures/dict.ts` is the hash table that every keyspace, hash and set will use. It has chained buckets, two tables, and incremental rehashing: one bucket moves per operation, so growing or shrinking never pauses the server. It also provides a SCAN cursor that survives resizing and the sampling that eviction and active expiry need. `src/utils/hash.ts` (seeded MurmurHash3) and `src/utils/random.ts` (seedable xoshiro128**) are the two utilities it depends on.

## One real operation's path

`d.set('k4', 4)` on a dict that holds `k0`…`k3` in its 4 buckets:

1. `dict.ts:122` `set()` checks that no walk is running, then calls `step()` (`:368`). Nothing is rehashing yet, so the step does nothing.
2. `murmur3_32('k4', seed)` (`hash.ts:17`) hashes the bytes, and `find()` (`:372`) checks t0's bucket `h & 3`. The key is missing.
3. `expandIfNeeded()` (`:393`) sees `used0 (4) ≥ size (4)`. `startRehash(8)` (`:397`) allocates t1 and sets `rehashIdx = 0`.
4. `:133`: t1 now exists, so `k4` goes straight into t1's bucket `h & 7`, and `used1` becomes 1.
5. The next `get('k0')` runs `step()`, then `rehash(1)` (`:181`). That skips empty buckets (at most 10), moves one bucket's chain to t1 by rehashing each key, and increments `moved` (`:207`).
6. Once `used0` hits 0, `finishIfDone()` (`:404`) makes t1 the new t0 and sets `rehashIdx = -1`.

## Key functions and why each exists

- **`step()`**: the whole point of the design. Each get, has, set or delete pays for one bucket of the resize, so the cost is amortised and no single call is O(n). Walks and scans pause it.
- **`rehash(n)`**: moves n non-empty buckets and gives up after n × 10 empty ones. Without that cap, one step on a 90%-empty table after a shrink starts could scan thousands of buckets.
- **`rehashMs(ms)`**: serverCron's share (step 5 wires it up). It works in batches of 100 buckets and stops when the time runs out, so idle dicts still finish resizing.
- **`maybeShrink()`**: shrinks when `used < size / 10`, to the next power of two ≥ used. It runs after every delete and from cron. The gap between the grow threshold (1.0) and the shrink threshold (0.1) stops a dict from resizing back and forth.
- **`finishIfDone()`**: also runs after deletes. Deletes can empty t0 before the rehash reaches the end, and then the swap can happen at once instead of waiting for steps over empty buckets.
- **`scan()` + `nextCursor()` (`:59`)**: the reverse-binary cursor. Incrementing the _reversed_ bits means the cursor walks bucket indexes high bit first, so the buckets already visited are the same set whether the mask is 3 bits or 10. While rehashing, it visits one small-table bucket and then every big-table bucket that bucket expands to (the `do … while (v & (m0 ^ m1))` loop, `:267`).
- **`randomEntry()` / `randomEntries(n)`**: these are Redis's `dictGetRandomKey` and `dictGetSomeKeys`. The first retries random buckets until one isn't empty. The second walks forward from a random bucket, which is cheaper but less uniform: good enough for eviction sampling.
- **`forEach()`**: the full walk for KEYS and SAVE. A `walking` counter makes any change throw, so a walk can't be corrupted under itself.
- **`check()`**: proves the invariants in tests: each key is in the bucket its hash names, t0 is empty below `rehashIdx`, the counts are right and no key is stored twice.

## Trade-offs, and what Redis does differently

- Redis (`dict.c`) uses SipHash with a random key. We use MurmurHash3 with a random seed because it's fast in 32-bit JS math. It is weaker against a determined attacker (ADR 0002).
- Redis grows to the next power of two above `used + 1` and can force a resize past a load factor of 5 when resizing is disabled (during fork). With no fork, we don't need `dict_can_resize`: we always double.
- Redis also rehashes inside `dictGetRandomKey` and `dictGetSomeKeys`, and uses _safe iterators_ that pause rehashing but still allow deletes. Our walks are stricter: no changes at all, as spec 10.2 says.
- An entry doesn't cache its hash, so a rehash computes every key's hash again (Redis does the same). A cached uint32 above 2^30 would be a heap number in V8, which costs an allocation per entry.
- `delete` returns a boolean, not the entry. `Db` (step 5/6) will look up the old value first when it needs it.

## The single most important line

`dict.ts:369`, `if (this.rehashIdx !== -1 && this.walking === 0) this.rehash(1);`. It is what makes rehashing incremental. If it's deleted, a dict only rehashes when cron runs, so in a unit test it never rehashes at all: a 4-bucket table keeps a million keys in four chains. "grows from 0 to 1M keys and back down" then never finishes (every insert searches a chain of hundreds of thousands of entries), and "operations alone finish a grow before the next one is due" fails.

## Quiz

1. A dict has 1,024 buckets and 1,024 keys. Insert one more key. Where does it go, and how many operations until the rehash is guaranteed done?
2. Why does SCAN increment the cursor's reversed bits instead of just doing `cursor + 1`?
3. Why can't `forEach` allow a delete during the walk, when SCAN between calls allows anything?

<details>
<summary>Answers</summary>

1. Into t1 (2,048 buckets). The insert starts the grow and then puts the new key in t1. Every later get, has, set or delete moves one non-empty bucket and advances `rehashIdx` by at least one, so at most 1,024 more operations empty t0 (fewer, since empty buckets are skipped along the way). Inserts during the rehash also go to t1, so t0 only shrinks.
2. With `+1`, a cursor that has visited buckets 0–5 of an 8-bucket table means nothing once the table doubles to 16: keys from bucket 3 may now sit in bucket 11, which `+1` counting would visit long after, or never if the table shrinks back first. Reversed counting visits indexes high bit first, so "already visited" is a prefix of the bit pattern, and that stays true under every mask size. Keys are never skipped, though some can come back twice.
3. A walk holds a position inside a bucket chain and across both tables. A delete could run a rehash step (moving the chain it's standing in), finish a rehash (swapping t0 and t1 under it), or start a shrink, and then the walk would skip or repeat entries. SCAN keeps nothing between calls except the 32-bit cursor, and the cursor math works whatever the tables look like.

</details>
