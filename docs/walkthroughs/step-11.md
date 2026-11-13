# Step 11: Sorted sets

## What this step built

A sorted set is a `ZSet` (`src/datastructures/zset.ts`): a `Dict<number>` of member → score for O(1) ZSCORE, plus a `Skiplist` (`src/datastructures/skiplist.ts`) ordered by (score, member) with spans for O(log n) ranks. The non-† commands of spec 8.6 are in `src/commands/zsets.ts`. All five range commands share one engine, `zrangeGeneric`, as in Redis 7. Two number parsers in `src/utils/numbers.ts` copy how Redis reads scores (`getDoubleFromObject`) and range bounds (plain `strtod`), and `bench/zrank.ts` measures ZRANK as the set grows.

## One real command's path

`ZRANGEBYSCORE z (1 3 WITHSCORES` on `{a:1, b:2, c:3, d:4}`:

1. `zrangebyscoreCommand` calls `zrangeGeneric(ctx, 'score', 'forward')` (`zsets.ts:249`). The preset type and direction make `BYSCORE` and `REV` syntax errors for this command, as in Redis.
2. The option loop reads `WITHSCORES`. The conflict checks pass, and no swap happens because it isn't reversed (`:275`).
3. `parseScoreRange('(1', '3')` (`:57`) gives `{min: 1, minex: true, max: 3}`. The numbers go through `parseStrtodDouble`, so `''` would be 0 and `' 1'` would be 1, exactly like Redis's `strtod`.
4. `lookupReadOfType(ctx, 'z', 'zset')` (`:296`) does the WRONGTYPE check after the range is parsed, which is Redis's order.
5. `zsl.firstInRange(range)` (`skiplist.ts:260`) descends from the top level, skipping every node below the minimum, and lands on `b`. `collect` (`zsets.ts:225`) walks level 0 forward while `scoreLteMax` holds, taking `b` and `c`.
6. `replyScored` (`:95`) writes `b 2 c 3` as a flat array in RESP2, or `[[b, ,2], [c, ,3]]` in RESP3. Scores go through the encoder's `d2string`-exact `formatDouble`.

## Key functions and why each exists

- **`Skiplist.insert` (`skiplist.ts:129`)**: records an `update[]` node and a `rank[]` per level on the way down. The new node's span is the old span minus the distance already covered (`:157`), and every level above the node's height gets `span++`.
- **`Skiplist.rank` / `byRank` (`:202`, `:245`)**: sum the spans along the search path. That makes ZRANK, ZRANGE by index and ZREMRANGEBYRANK O(log n).
- **`Skiplist.updateScore` (`:182`)**: changes the score in place when the node still sits between its neighbours. Otherwise it deletes and re-inserts. Repeated ZINCRBY by small steps usually takes the fast path.
- **`Skiplist.check` (`:380`)**: verifies order, backward links, the tail, the length and that every span equals the level-0 distance. The unit and property tests call it after every operation.
- **`ZSet.add` (`zset.ts:59`)**: all of ZADD's NX/XX/GT/LT/INCR rules in one place (Redis's `zsetAdd`). It returns an outcome, so ZADD can count `added` vs `updated` for CH, and INCR can reply nil when a flag stopped it.
- **`parseStrictDouble` / `parseStrtodDouble` (`numbers.ts:100`, `:114`)**: the two ways Redis reads a double. ZADD, ZINCRBY and WEIGHTS reject `''`, leading spaces, overflow and total underflow, but accept `infinity`. Range bounds are plain `strtod`: `''` → 0, `' 1'` → 1, `1e400` → inf. The differential's broken calls generate exactly these inputs.
- **`zstoreGeneric` (`zsets.ts:476`)**: type-checks every source before parsing WEIGHTS and AGGREGATE (Redis's order), sorts sources by size (`:517`), turns `inf × 0` and `inf + -inf` into 0, and builds the result through `ZSet.add` (`:542`).

## Trade-offs, and what Redis does differently

- Redis keeps a zset of up to 128 members in a listpack, with linear scans (`t_zset.c zzl*`, `zset-max-listpack-entries`). We always use the skip list (OBJECT ENCODING is already a DIFFERENCES.md row). One visible side effect is `-0`. A listpack stores an integral score as an integer, so `-0` is stored as `0`, but the ZINCRBY or ZADD INCR reply that computed it says `-0`. The harness found this at command 42,125 of seed 4242. The step 3 encoder test had pinned `-0 → "0"`, which it had read through a listpack. Now the encoder prints `-0` like `d2string` (`encoder.ts:165`), and `ZSet` stores `0` (`zset.ts:35`). A big Redis skip-list zset would keep `-0`; that's a new DIFFERENCES.md row.
- Lex ranges are only defined when all scores are equal. With mixed scores, the answer depends on how the search descends, which depends on random levels. So the generator keeps lex commands on their own keys `z0`–`z2`, which are only ever written by `ZADD z 0 …`.
- Redis sorts ZUNIONSTORE sources with `qsort`, which isn't stable; we use JS's stable sort. With three or more sources of equal size, the order of a float SUM could differ in the last bits. The generator's quarter scores are exact, so it never shows.
- `bench/zrank.ts` on this machine:

  |   members | links per ZRANK | ns per ZRANK | levels |
  | --------: | --------------: | -----------: | -----: |
  |    10,000 |            26.3 |          816 |      6 |
  |   100,000 |            32.1 |        5,396 |     10 |
  | 1,000,000 |            37.7 |       13,478 |     10 |

  The work grows like log n: 1.44× the links for 1.50× the log₂ n. Wall time grows 16.5× (linear would be 100×), because once a million nodes no longer fit in the CPU cache, nearly every link is a cache miss. So "time grows roughly with log n" holds for the work, not for the wall clock. `Skiplist.searchSteps` exists only so the benchmark can count links.

- Differential runs: seeds 1, 2, 3, 77, 4242, 9001 and 31337 at 50,000 ops, with zero diffs after the `-0` fix.

## The single most important line

`skiplist.ts:157`: `node.levels[i]!.span = u.levels[i]!.span - (rank[0]! - rank[i]!);`. Every rank, ZRANGE by index and ZREMRANGEBYRANK depends on spans being right. Replacing it with `= u.levels[i]!.span` fails "rank and byRank agree, 1-based" and "check() passes after 100,000 random inserts…" in `tests/unit/skiplist.test.ts`, and the property test in `tests/property/skiplist.test.ts`. The integration tests alone would not catch it: with five members nearly every node is level 1, where spans are always 1.

## Quiz

1. Why is the first node of a score range found by descending the levels, but the rest by walking level 0?
2. `ZCOUNT z '' +inf` counts members ≥ 0 in Redis, but `ZADD z '' m` is an error. Why the difference?
3. Why do the lex commands in the differential harness get keys of their own?

<details>
<summary>Answers</summary>

1. Finding the first node ≥ min is a search, so the express lanes cut it to O(log n). After that every node in the range is in the reply anyway, so following level 0 is O(k) for k results, and no faster method exists.
2. Redis reads range bounds with plain `strtod` (`zslParseRange`), which converts nothing from `''`, returns 0 and stops at the terminator, so the parse "succeeds". ZADD scores go through `getDoubleFromObject`, which explicitly rejects an empty string, leading spaces and ERANGE. `parseStrtodDouble` and `parseStrictDouble` copy each one.
3. A lex range assumes every score is equal. With mixed scores, which node the descent stops at depends on the skip list's random levels, so Redis and MiniRedis could legitimately disagree. Keys written only by `ZADD key 0 …` keep the precondition true, and any diff there is a real bug.

</details>
