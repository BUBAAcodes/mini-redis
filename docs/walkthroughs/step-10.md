# Step 10: Hashes and sets

## What this step built

Hashes (`src/commands/hashes.ts`) are a `Dict<string>` of field → value, and sets (`src/commands/sets.ts`) are a `Dict<true>`. Both reuse the step 4 dict, so they get its seeded hash, incremental rehashing and SCAN cursor. The non-† commands of spec 8.4 and 8.5 are in, including HSCAN and SSCAN, through a SCAN helper factored out of `keys.ts` (`src/commands/scan.ts`). The two random or float commands are rewritten for propagation: HINCRBYFLOAT becomes `HSET`, and SPOP becomes `SREM` (or `DEL` when the set empties).

## One real command's path

`SPOP s 2` on `{a, b, c, d}`:

1. The dispatcher calls `spopCommand` (`sets.ts:82`). With three words it takes the count branch. `abc` and `-1` both give `value is out of range, must be positive`, before the key is looked up.
2. `lookupWriteOfType(ctx, 's', 'set')` (`typed.ts`) does lazy expiry and the type check.
3. The count is below the set's size, so the loop at `sets.ts:123` draws `randomEntry()` from the set's dict, deletes it and records it, twice. `randomEntry` uses the server's seeded RNG, so a test can replay it.
4. `ctx.rewritePropagation(['SREM', 's', m1, m2])` (`sets.ts:127`) tells the propagator (`propagate.ts:48`) to record that instead of `SPOP s 2`.
5. `signalModifiedKey('s')` bumps `dirty`, so the dispatcher finishes the record. The recording sink sees `{ db: 0, argv: ['SREM', 's', m1, m2] }`.
6. The reply uses `reply.set`: a flat array in RESP2, `~2` in RESP3, as Redis 7.4 does.

## Key functions and why each exists

- **`scanPage` and `parseScanOptions` (`scan.ts:67`, `:35`)**: one bounded stepping loop and one option parser for SCAN, HSCAN, SSCAN (and ZSCAN next step). TYPE is only allowed for SCAN. HSCAN and SSCAN parse their options after the key lookup (`hashes.ts:163`), as Redis does, so a missing key replies `0 []` even with bad options.
- **`hashForWrite` (`hashes.ts:27`)**: Redis's `hashTypeLookupWriteOrCreate`. HINCRBY and HINCRBYFLOAT call it only after every check has passed, so a failed increment never leaves an empty hash behind.
- **`hincrbyfloatCommand` (`hashes.ts:130`)**: has three different errors, in Redis's order: a non-float increment, an infinite increment (`value is NaN or Infinity`, `:134`, which plain INCRBYFLOAT doesn't have), and a non-float stored value. Then the result is checked and propagated as `HSET` (`:151`).
- **`compute` (`sets.ts:194`)**: SINTER walks the smallest set and probes the others. SUNION and SDIFF accumulate into a scratch `Dict`. Every source is type-checked first, so `SINTER missing str` is still WRONGTYPE, as in Redis.
- **`setOpStoreCommand` (`sets.ts:225`)**: computes the whole result before touching the destination, so `SDIFFSTORE a a b` works. An empty result deletes the destination, and a STORE that changed nothing isn't propagated.
- **The digest cases for `'hash'` and `'set'` (`debug.ts:46`, `:58`)**: sorted by byte order first, so two servers that built the same data in a different order agree.

## Trade-offs, and what Redis does differently

- Redis keeps small hashes and sets as listpacks or intsets (`t_hash.c`, `t_set.c`, `hashTypeConvert`, `setTypeConvert`) and returns them from HSCAN and SSCAN in one call. We always use a dict and page them (DIFFERENCES.md already lists both).
- SRANDMEMBER uses Redis's case 3 and case 4 strategies (`srandmemberWithCountCommand`): copy and remove when asking for most of the set, draw until distinct when asking for a few. A negative count is capped at 1,048,576, so one call can't block the thread for hours (rule 11). That cap is a new DIFFERENCES.md row.
- A single SPOP that takes the last member propagates `DEL` (the spec 9.5 table). Redis sends `SREM`. Both replay to the same state; this is also a new DIFFERENCES.md row.
- RESP3 shapes were checked against the reference with `HELLO 3`: SMEMBERS, SINTER and counted SPOP are sets, SRANDMEMBER and HKEYS are arrays, HGETALL is a map. HELLO doesn't exist until step 22, so the tests switch a client's `reply.resp` on the server side.
- The generator keeps HINCRBYFLOAT on the `x0` and `x1` fields, which only ever hold quarters (ADR 0005). SPOP, SRANDMEMBER, HSCAN and SSCAN are never generated (spec 15.3) and have their own tests.
- Differential runs: seeds 1, 2 and 3 at 10,000 ops and 77 and 4242 at 50,000 ops, with zero diffs.

## The single most important line

`sets.ts:127`: `ctx.rewritePropagation(['SREM', key, ...popped]);`. Without it, SPOP propagates as sent, and every replica and AOF replay draws its own random members, so the copies quietly drift apart (rule 6). Deleting it fails "SPOP removes random members and propagates them as SREM" in `tests/integration/sets-commands.test.ts`.

## Quiz

1. Why does HINCRBYFLOAT call `hashForWrite` only after parsing the stored value, and not at the start?
2. `SDIFFSTORE a a b`: what would break if the destination were cleared before computing?
3. Why can't the differential harness check SPOP, and what checks it instead?

<details>
<summary>Answers</summary>

1. Rule 4: an error reply means nothing changed. Creating the hash first and then failing (say on `inf`) would leave an empty hash under the key, and EXISTS would see it. Redis creates the hash only on the success path too.
2. `a` is both a source and the destination. Clearing it first would make the result empty. `compute` reads every source into a plain array before `setKey` replaces the destination.
3. The two servers would pick different random members, so the replies differ by design (spec 15.3 lists SPOP as never generated). The integration tests check that the members really left the set, that the reply shapes match, and that the recording sink shows exactly `SREM s <m1> <m2>`, or `DEL s` when the set empties.

</details>
