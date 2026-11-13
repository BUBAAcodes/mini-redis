# ADR 0004: INCR and friends do their math in BigInt

**Status:** accepted (step 6)

## Context

Redis stores counters as signed 64-bit integers (`long long`) and reports overflow exactly at `9223372036854775807` (`t_string.c`, `incrDecrCommand`). A JS `number` is a double and loses integer precision past 2^53, so `SET k 9223372036854775806` then `INCR k` would round to the wrong value, or even look like it overflowed when it hasn't.

## Decision

`parseInt64` (`src/utils/numbers.ts`) returns a `bigint`, and `addInt64` adds two of them and returns `null` when the sum leaves the int64 range. INCR, DECR, INCRBY and DECRBY call these (`incrDecr` in `src/commands/strings.ts`). The new value is stored with `String(bigint)`, which is exactly Redis's decimal text. DECRBY with `-9223372036854775808` is refused up front with Redis's own `decrement would overflow`, because its negation doesn't fit. HINCRBY (step 10) will use the same helpers. Indexes and counts are a different case: they're parsed as int64 and then clamped with `clampToSafe`, because nothing we can hold is longer than 2^53.

## Consequences

- Every int64 value is exact, and overflow is detected at the same value as Redis.
- BigInt is slower than number arithmetic. An INCR allocates two BigInts and one string. The benchmark in step 24 will show whether it matters; a fast path for values below 2^53 is the optimisation to try if it does.
- A stored value is re-parsed on every INCR. Redis avoids that with its int encoding; we don't keep encodings (spec 6.1).
