# Step 08: Differential harness

## What this step built

`tests/differential/` sends the same seeded random commands to the Redis 7.4 container and to an in-process MiniRedis, and fails on the first reply whose bytes differ (rule 3's judge, spec 15.3). A generator draws weighted commands, only from names MiniRedis has registered. A comparator allows exactly two exceptions: unordered replies and TTL/PTTL jitter. A final test checks that a full SCAN returns the same keys on both servers in every database. CI runs it against a `redis:7.4` service container with `OPS=20000`.

## One real command's path

`SEED=81723 OPS=10000 npm run test:diff`:

1. `beforeAll` (`differential.test.ts:29`) connects to Redis on `REDIS_PORT`, starts MiniRedis on port 0 with `startServer()`, and runs `FLUSHALL` and `SELECT 0` on both (`:42`).
2. `new Generator(SEED, registered)` (`:56`) filters `TEMPLATES` to registered commands. `gen.next()` (`generator.ts:226`) picks a weighted command, builds its arguments, and about 5% of the time runs them through `broken()`.
3. All commands are generated up front (`:57`) and hashed (`:58`). The `commands-sha1` printed on stderr is how you check that a replay sent the same bytes.
4. Each command goes to both servers through `TestClient.exchange()` (`resp-client.ts:137`), which returns the exact reply bytes and the decoded value (`:66`, `:67`).
5. `repliesMatch()` (`compare.ts:28`) accepts equal bytes, then tries the two exceptions. A mismatch throws with the seed, the command number and the last 20 commands with both replies (`:72`).
6. The SCAN test (`:81`) pages through `SCAN … COUNT 7` on both servers, per database, and compares the sorted key sets.

## Key functions and why each exists

- **`Generator.next()` (`generator.ts:226`)**: the only source of commands. It uses one seeded `Random`, so a seed fixes the whole run.
- **`TEMPLATES` (`generator.ts:126`)**: one weighted argument builder per command. A new step adds its commands here, and they are drawn as soon as they are registered.
- **`Gen.floatKey()` and `Gen.deadlineMs()` (`generator.ts`)**: `f0`–`f3` only ever hold quarter values, so INCRBYFLOAT stays inside what both servers represent exactly. Deadlines are fixed absolute times in 2096, so a seed gives the same bytes on any day.
- **`repliesMatch()` (`compare.ts:28`)**: the exception list. It is a pure function, so `tests/unit/differential-harness.test.ts` tests it without Docker.
- **`TestClient.exchange()`**: keeps the raw bytes next to the parsed value, so binary data and reply types are compared exactly.

## Trade-offs, and what Redis does differently

- Redis has no equivalent: its own tests (`tests/unit/*.tcl`) assert fixed expected values, while here the reference server is the oracle. The cost is that anything MiniRedis does differently on purpose must be kept out of the generator, not hidden in the comparator.
- Two such cases came up and were handled in the generator, not by loosening `repliesMatch`. A key near 2^63 followed by INCRBYFLOAT printed `9223372036854776000` against Redis's `9223372036854775814` (long double against double, ADR 0005). So no word near 2^63 is generated, and the float pool is separate. APPEND and SETRANGE could also turn an ordinary key into `1.542`, where the last digits differ, so INCRBYFLOAT only touches the `f` keys. Overflow errors are still covered by the step 6 tests.
- Replies are never read before the next command is generated, so a failing run can be replayed from `SEED` alone.
- MULTI/EXEC blocks and more types are not generated yet. The spec says they join once registered (steps 9–16), and `TEMPLATES` is where that happens.
- Runs so far: 10,000 ops with several seeds and 50,000 ops with four seeds, zero diffs. Breaking the "not an integer" error text was caught at command 134.

## The single most important line

`compare.ts:51`, the final `return false;`. Everything the exception list doesn't allow must fail. If it returned `true`, the harness would pass on any difference. "requires identical bytes by default" and "accepts KEYS in a different order, but not different members" in `differential-harness.test.ts` would fail.

## Quiz

1. Why are all commands generated before the first one is sent?
2. Why are deadlines a fixed base plus a random number, not `Date.now() + n`?
3. Why is the comparator not allowed to ignore a diff such as the INCRBYFLOAT precision one?

<details>
<summary>Answers</summary>

1. The generator never looks at replies, so the run is a pure function of the seed. Hashing the list up front proves a replay is byte for byte the same run.
2. With `Date.now()` the argument bytes would change from day to day, so `SEED=…` would not replay. A fixed far-future base still keeps every TTL well above 100 seconds.
3. Spec 15.3's rule: a diff is fixed in MiniRedis, never by loosening the harness, unless it's one of the listed exceptions. A broader comparator would hide real bugs. Known differences are kept out of what the generator produces and recorded in `DIFFERENCES.md`.

</details>
