# Step 24: Benchmarks and one optimisation

## What this step built

A benchmark kit that compares MiniRedis with Redis 7.4 on the same machine: `bench/run.sh`
(throughput through Compose, both servers, with and without pipelining), `bench/memory.ts`,
`bench/restart.ts` and `bench/repl-lag.ts`, a CSV-to-table converter and a profiler wrapper.
The profile showed the RESP parser making a new Buffer view for every header line and every
argument, and the fix reads them in place, which made the parser 40–61% faster and most
end-to-end tests 10–16% faster. All of it is written up in [bench/RESULTS.md](../../bench/RESULTS.md).

## One real command's path through the new code

`SET k v` arriving as `*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n` inside one socket chunk:

1. `Server.onData` feeds the chunk to the parser, `feed` (`src/protocol/parser.ts:115`), and
   `processInput` calls `next()` → `parse` (`:132`).
2. `multibulkHeader` calls `headerLine` (`:229`), which finds the CR and calls `consume(4)`
   (`:273`). The bytes are inside the head chunk, so `consume` sets `view` to that chunk and
   `viewAt` to the read position: no allocation. `parseLength(view, viewAt + 1, viewAt + 2)`
   reads `3` straight from the chunk's bytes.
3. For each argument, `bulkHeader` (`:209`) does the same for `$3\r\n` and checks `view[viewAt]`
   is `$`.
4. The body: `consume(len + 2)`, `expectCrlf(view, at + len)`, then
   `view.toString('latin1', at, at + len)` (`:178`). That's the one allocation per argument, the
   string itself.
5. `finish` (`:187`) returns `{ argv, bytes }` and resets `view` to an empty buffer, so a parser
   never keeps a finished socket chunk alive.

Before this step, steps 2–4 each went through `take(n)`, which returned
`chunk.subarray(pos, pos + n)`: seven short-lived Buffer objects for one `SET`.

## Key functions and why each exists

- **`RespParser.consume`**: leaves consumed bytes at `view[viewAt…]`, in the chunk when they
  sit in one chunk and in a copy when they straddle two. Two fields rather than a returned pair,
  because a pair is an allocation too.
- **`bench/run.sh`**: the exact commands of spec 18, so anyone can rerun them. It runs
  `redis-benchmark` inside the Redis container against both servers, so neither gets a
  networking advantage.
- **`bench/report.ts`**: CSV to table. It shows a negative ops/sec as a dash, because
  `redis-benchmark` under WSL2 sometimes prints one, and a table that silently said "−215,517"
  would be wrong.
- **`bench/profile.sh` + `bench/profile-top.ts`**: profile the built server under load and print
  self and total time per function without opening DevTools; with `PROFILE=0 RUNS=5`, the
  median-of-five throughput used for before/after.
- **`bench/parser.ts`**: the parser on its own, without sockets, so its before/after is
  repeatable within about 10%, where the network benchmark swings ±20%.
- **`bench/memory.ts`, `restart.ts`, `repl-lag.ts`**: the other numbers spec 18 asks for. The
  pipelined loader in `bench/lib.ts` counts reply bytes (`+OK\r\n` is 5 bytes) instead of
  parsing a million replies.

## Trade-offs, and what Redis does differently

Redis's `processMultibulkBuffer` (`networking.c`) reads lengths with `string2ll` straight from
the query buffer and, for big arguments, hands the buffer itself to the new object so the bytes
are never copied. We can't avoid the copy into a JS string, the arguments' representation
(rule 2), but we now avoid every allocation around it. The price is two more fields on the
parser and an invariant to keep in mind: `view` is only valid until the next `consume`.

Benchmarking on a WSL2 laptop is noisy, so every claim in RESULTS.md has a repeat count and a
range next to it. During this step a second Claude Code session was found running the full test
suite in the same repo, which made the parser numbers swing by 2.5×; the baseline was redone
after it stopped.

## The most important line

In `consume`:

```ts
if (this.pos + n <= first.length) {
```

Delete the condition (always read in place) and a header or argument that straddles two chunks
is read past the end of the first chunk. Five parser tests fail, among them "a 1,000-command
pipeline fed one byte at a time parses exactly like one chunk"
(`tests/unit/parser.test.ts:296`). Delete the in-place branch instead (always copy) and
everything passes but `bench/parser.ts` drops back to the old numbers. That is the optimisation.

## Quiz

1. Why does the end-to-end gain (10–16%) look so much smaller than the parser's (40–61%)?
2. Why does the no-pipelining table show MiniRedis at about half of Redis, but the `-P 16`
   table at about a third?
3. What is the next hotspot, and what would fix it?

<details>
<summary>Answers</summary>

1. Parsing was about 30% of the server's time; making 30% of the work 40% faster saves about
   12%, which is what the profile shows (103 s → 91 s of samples). The rest is dispatch,
   hashing, the data structures and the socket writes, which didn't change (Amdahl's law).
2. Without pipelining both servers spend most of each command waiting on a network round trip,
   which costs both the same, so the gap is diluted. With 16 commands per round trip the
   per-command cost dominates, and that's where C beats V8.
3. `murmur3_32`, at 12.5% of self time: a SET hashes its key five times, three of them in the
   usually empty `expires` dict. Returning early from `Dict.get`, `has` and `delete` when the
   dict is empty, as Redis's `dictFind` does, removes those three.

</details>
