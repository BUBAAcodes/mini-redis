# ADR 0005: INCRBYFLOAT uses 64-bit doubles, and propagates its result

**Status:** accepted (step 6)

## Context

Redis computes INCRBYFLOAT and HINCRBYFLOAT in 80-bit `long double`s and prints them with `%.17Lg` (`util.c`, `ld2string`). JS has only 64-bit doubles, so the last digits of results like `0.1 + 0.2` can differ from Redis, and nothing in JS can reproduce an 80-bit sum.

## Decision

`parseDouble` and `formatDouble` (`src/utils/numbers.ts`) work in doubles. The result is printed as the shortest string that parses back to the same double (`String(x)`), expanded so it never uses exponent notation, with `inf` and `-inf` for infinities. A result that is NaN or infinite is refused with `increment would produce NaN or Infinity`. The command is propagated as `SET key <result> KEEPTTL` (spec 9.5), so a replica or an AOF replay stores the exact same text instead of redoing the math. The differential test (step 8) uses only multiples of 0.25, which both formats represent exactly. The difference is listed in `docs/DIFFERENCES.md`.

## Consequences

- Results agree with Redis whenever the operands are exactly representable in a double, and may differ in the last digits otherwise.
- Propagating the result means two nodes can never disagree about a float, whatever their arithmetic.
- `-0` prints as `0` (JS), while Redis prints `-0`. Not worth special-casing.
