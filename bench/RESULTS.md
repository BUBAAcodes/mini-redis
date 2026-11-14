# Benchmark results

MiniRedis against Redis 7.4 on the same laptop, plus one profiled optimisation (spec section
18). Redis wins everywhere, as expected. The useful part is where the gap is big, where it's
small, and why.

## The machine

|        |                                                                                     |
| ------ | ----------------------------------------------------------------------------------- |
| CPU    | 11th Gen Intel Core i5-1145G7 @ 2.60 GHz, 4 cores / 8 threads (laptop, turbo boost) |
| RAM    | 7.6 GB visible to WSL2                                                              |
| OS     | Windows, WSL2 kernel 6.6.87.2-microsoft-standard-WSL2                               |
| Docker | 29.8.2                                                                              |
| Node   | 26.13.1 (in the image and on the host)                                              |
| Redis  | 7.4.12 (`redis:7.4` image)                                                          |
| Date   | 2026-11-14                                                                          |

**Noise warning.** This is a laptop running Linux inside a VM. The same command can vary by
±20% between runs and by more between hours (CPU boost, thermals, Docker's network over WSL2).
`redis-benchmark` here also sometimes prints a negative ops/sec for a fast test, a counter
glitch under WSL2's clock; such rows were re-run (noted below). Compare the two servers within
a table, not these numbers with another machine's.

## Throughput

Both servers in Compose with the same persistence settings (AOF on, `appendfsync everysec`, no
save points). `redis-benchmark` runs inside the Redis container against both, so both pay the
same container network:

```bash
docker compose up -d --build miniredis redis
T=ping_inline,ping_mbulk,set,get,incr,lpush,rpush,lpop,rpop,sadd,hset,spop,zadd,zpopmin,lrange_100,mset
docker compose exec -T redis redis-benchmark -h redis     -p 6379 -n 200000 -c 50 -t $T --csv > bench/redis.csv
docker compose exec -T redis redis-benchmark -h miniredis -p 6380 -n 200000 -c 50 -t $T --csv > bench/miniredis.csv
# then both again with -P 16 (pipelining)
```

`bash bench/run.sh` runs exactly this, plus everything below, and writes `bench/tables.md`. The
raw CSVs are in `bench/`. These numbers are for the final code, after the optimisation.

### No pipelining (`-P 1`), 50 clients

| Test                               | Redis ops/s | MiniRedis ops/s | MiniRedis / Redis | Redis p50 ms | MiniRedis p50 ms | Redis p99 ms | MiniRedis p99 ms |
| ---------------------------------- | ----------: | --------------: | ----------------: | -----------: | ---------------: | -----------: | ---------------: |
| PING_INLINE                        |      54,215 |          29,749 |               55% |        0.439 |            1.119 |        1.447 |            5.071 |
| PING_MBULK                         |      54,660 |          31,075 |               57% |        0.439 |            1.055 |        1.255 |            4.071 |
| SET                                |      57,078 |          24,134 |               42% |        0.415 |            1.543 |        1.423 |           12.183 |
| GET                                |      55,096 |          27,465 |               50% |        0.431 |            1.199 |        1.231 |            5.647 |
| INCR                               |      52,645 |          25,961 |               49% |        0.423 |            1.375 |        1.847 |            5.671 |
| LPUSH                              |      61,331 |          26,226 |               43% |        0.399 |            1.311 |        1.143 |            5.951 |
| RPUSH                              |      57,405 |          31,451 |               55% |        0.415 |            1.375 |        1.455 |            6.175 |
| LPOP                               |     111,545 |          27,778 |               25% |        0.399 |            1.215 |        1.311 |            5.047 |
| RPOP                               |      60,772 |          28,559 |               47% |        0.399 |            1.199 |        1.255 |            4.903 |
| SADD                               |      56,641 |          29,351 |               52% |        0.431 |            1.151 |        1.183 |            4.575 |
| HSET                               |      54,825 |          33,162 |               60% |        0.415 |            1.327 |        1.903 |            5.495 |
| SPOP                               |      44,803 |          30,698 |               69% |        0.591 |            1.079 |        2.039 |            4.439 |
| ZADD                               |      42,726 |          28,914 |               68% |        0.631 |            1.183 |        2.151 |            5.303 |
| ZPOPMIN                            |      44,944 |          29,308 |               65% |        0.583 |            1.127 |        1.983 |            5.111 |
| LPUSH (needed to benchmark LRANGE) |      46,849 |          30,053 |               64% |        0.575 |            1.319 |        1.943 |            8.191 |
| LRANGE_100 (first 100 elements)    |      37,010 |          13,631 |               37% |        0.911 |            2.567 |        2.495 |           13.543 |
| MSET (10 keys)                     |      40,667 |          15,728 |               39% |        0.815 |            2.855 |        2.591 |           10.767 |

### Pipelining (`-P 16`), 50 clients

| Test                               | Redis ops/s | MiniRedis ops/s | MiniRedis / Redis | Redis p50 ms | MiniRedis p50 ms | Redis p99 ms | MiniRedis p99 ms |
| ---------------------------------- | ----------: | --------------: | ----------------: | -----------: | ---------------: | -----------: | ---------------: |
| PING_INLINE                        |     386,100 |         245,098 |               63% |        1.087 |            2.775 |       13.231 |            7.535 |
| PING_MBULK                         |     530,504 |         215,517 |               41% |        0.887 |            2.879 |        4.415 |           11.911 |
| SET                                |     352,734 |         132,275 |               37% |        1.687 |            5.279 |        9.135 |           14.367 |
| GET                                |     619,195 |         217,865 |               35% |        0.855 |            3.191 |        3.535 |            9.031 |
| INCR                               |     312,989 |         142,552 |               46% |        1.831 |            4.767 |        8.695 |           16.559 |
| LPUSH                              |     378,072 |         128,617 |               34% |        1.679 |            5.159 |        5.951 |           17.263 |
| RPUSH                              |     404,858 |         116,347 |               29% |        1.583 |            5.263 |        4.375 |           22.831 |
| LPOP                               |     320,513 |         156,250 |               49% |        1.831 |            4.367 |        6.647 |           13.143 |
| RPOP                               |     378,788 |         165,289 |               44% |        1.679 |            4.071 |        5.503 |           12.607 |
| SADD                               |     673,401 |         160,000 |               24% |        0.895 |            3.991 |        2.799 |           13.399 |
| HSET \*                            |     383,877 |         106,895 |               28% |        1.735 |            6.039 |        4.439 |           18.159 |
| SPOP                               |     531,915 |         241,546 |               45% |        0.991 |            2.895 |        3.111 |            7.551 |
| ZADD                               |     483,092 |         165,017 |               34% |        1.247 |            4.271 |        4.423 |           12.439 |
| ZPOPMIN                            |     769,231 |         221,976 |               29% |        0.775 |            3.111 |        2.167 |            8.911 |
| LPUSH (needed to benchmark LRANGE) |     421,941 |         117,165 |               28% |        1.615 |            5.303 |        4.223 |           21.983 |
| LRANGE_100 (first 100 elements)    |      77,882 |          31,061 |               40% |        4.911 |           19.935 |       12.079 |           86.655 |
| MSET (10 keys)                     |     119,689 |          33,630 |               28% |        5.439 |           21.599 |       16.543 |           56.831 |

\* In the full run MiniRedis's HSET row came out as a negative ops/sec (the counter glitch). The
row shown is the median of three separate runs of `-t hset -P 16` against each server.

**Reading the tables.** Without pipelining, both servers spend most of their time waiting on
the container network: one round trip per command, so Redis manages only about 55,000 ops/s
here and MiniRedis gets about half of that. With 16 commands per round trip, the network
stops being the limit and the cost per command decides: Redis goes to 300,000–770,000 ops/s,
MiniRedis to 100,000–250,000, so MiniRedis lands at a quarter to a half of Redis. The gap is
widest where Redis has a specialised fast path: SADD and ZPOPMIN (Redis's small sets and
zsets are compact listpacks and intsets, a few cache lines each), RPUSH (listpack appends) and
MSET (ten keys per command, so ten times our per-key overheads). It is narrowest for PING,
where neither server touches data.

## Memory: 1M keys with 100-byte values

`npx tsx bench/memory.ts` fills each server with `SET key:<9 digits> <100 bytes>`, pipelined,
then reads INFO and `docker stats --no-stream`:

| Server    |      Keys | `used_memory` | RSS before | RSS after | RSS per key |
| --------- | --------: | ------------: | ---------: | --------: | ----------: |
| Redis 7.4 | 1,000,000 |      171.6 MB |     7.2 MB |  181.5 MB |       183 B |
| MiniRedis | 1,000,000 |      260.4 MB |   132.5 MB |  769.9 MB |       668 B |

MiniRedis uses about 3.6× Redis's memory per key. Its `used_memory` is our own estimate of
the dataset (spec 10.5, ADR 0013), not an allocator count, so RSS is the fair comparison. The
estimate undershoots RSS because the V8 heap keeps room to grow, and freed memory from
earlier benchmarks (the 132 MB "before") isn't returned to the OS. Each key holds 113 bytes of
data (a 13-byte name and a 100-byte value), so Redis's overhead is about 70 bytes per key
(`dictEntry`, `robj` and two `sds` headers), and MiniRedis's about 550: a dict entry object,
an `RObj`, two string headers, the bucket array's share, and V8's heap slack. Loading took 5.6 s on Redis and 11.4 s
on MiniRedis.

## Restart with 1M keys

`npm run build && npx tsx bench/restart.ts` starts the built server on a temp dir, fills it,
kills it with SIGKILL, and times the next start until `Ready to accept connections`. Median
of four runs, with the range:

| Restart from   |      Keys | File size | Empty start | Start with data, median (range) |
| -------------- | --------: | --------: | ----------: | ------------------------------: |
| AOF (everysec) | 1,000,000 |  134.5 MB |      ~0.3 s |           10.9 s (9.0 – 13.3 s) |
| Snapshot       | 1,000,000 |  110.6 MB |      ~0.3 s |             4.9 s (4.5 – 6.3 s) |

The snapshot loads about twice as fast: it's a compact binary format checked by one CRC,
whereas the AOF replays a million SET commands through the parser and the dispatcher. That's
why Redis prefixes its AOF with an RDB preamble, one of the stretch goals (spec 24). Redis
wasn't timed: its image disables DEBUG RELOAD, and restarting its container would time Docker
as much as Redis.

## Replica lag under load

`docker compose --profile replication up -d --build`, then `npx tsx bench/repl-lag.ts`: while
`redis-benchmark -t set,lpush,incr -n 1000000` (no pipelining) writes to the primary, the
primary's `master_repl_offset` minus each replica's acknowledged offset, sampled every second:

| Replica  | Samples | Mean lag | Max lag | Last lag | Stream rate |
| -------- | ------: | -------: | ------: | -------: | ----------: |
| replica1 |     154 |   417 KB | 1954 KB |     0 KB |    0.8 MB/s |
| replica2 |     154 |   480 KB | 2063 KB |   115 KB |    0.8 MB/s |

The replicas keep up. The mean lag is about half a second of stream, which is what an ACK
sent once a second measures by itself: right after an ACK the lag reads near zero, just
before the next one it reads a full second's worth. The lag never grew across the 154
samples, and both replicas ended level with the primary.

## Performance checks (spec 15.8)

| Check                                   | Result                                                                                                    | How                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------- |
| 64 MB bulk sent in 1 KB chunks          | parsed in 433 ms (limit 2 s)                                                                              | `tests/unit/parser.test.ts` |
| PING latency during a BGSAVE of 1M keys | 1,570 PINGs answered while the BGSAVE took 3.1 s, the worst 24.4 ms (limit 50 ms)                         | `npm run test:perf`         |
| ZRANK at 10,000 vs 1,000,000 members    | 26.3 → 37.7 links per lookup (1.44×, log₂ n grows 1.50×); 1,226 → 24,021 ns (19.6×, linear would be 100×) | `npx tsx bench/zrank.ts`    |
| Dict growth 0 → 1M keys → 0             | never more than one bucket moved per operation                                                            | `tests/unit/dict.test.ts`   |

ZRANK's work grows with log n; its wall time grows faster because a million skip-list nodes
don't fit in the CPU caches, so nearly every link is a cache miss. Step 11 measured the same
link counts with lower times (816 → 13,478 ns); the machine was faster that day, which is the
noise warning above in action.

## The optimisation: parse requests in place

### Finding the hotspot

```bash
bash bench/profile.sh   # the built server under --cpu-prof, loopback redis-benchmark -P 16
```

It runs `node --cpu-prof dist/index.js` against a local `redis-benchmark -n 1000000 -c 50 -P 16
-t ping_mbulk,set,get,incr,lpush,hset,mset`, then `bench/profile-top.ts` sums the samples per
function. Self time, before the change:

| Self time | Function            | What it is                                                         |
| --------: | ------------------- | ------------------------------------------------------------------ |
|     10.3% | `writeBuffer`       | the socket write system call; already one per client per loop turn |
|      9.9% | `murmur3_32`        | hashing keys                                                       |
|      6.2% | `call`              | the dispatcher, with the inlined command handlers                  |
|      5.6% | `latin1Slice`       | bytes → JS strings, once per argument: needed                      |
|      4.5% | `toString`          | Node's wrapper around it                                           |
|  **4.1%** | **`FastBuffer`**    | **a new Buffer object**                                            |
|      3.1% | (garbage collector) |                                                                    |
|  **2.7%** | **`subarray`**      | **making a Buffer view**                                           |

`FastBuffer` and `subarray` together were 6.8% of all samples, and they bought nothing. For
every header line (`*3\r\n`, `$3\r\n`) and every bulk body, the parser called `take(n)`, which
returned `chunk.subarray(pos, pos + n)`: a new Buffer object, used for a few byte reads or one
`toString`, then garbage. A `SET k v` made seven of them. They also fed the 3.1% GC.

### The fix

[parser.ts](../src/protocol/parser.ts): a new `consume(n)` leaves the bytes at
`view[viewAt…]`, the socket chunk itself, plus an offset, whenever they sit inside one chunk.
That is nearly always the case; across a chunk boundary it still copies. Headers are parsed in
place (`parseLength(view, viewAt + 1, …)`) and bodies are decoded straight from the chunk
(`view.toString('latin1', at, at + len)`). The fields are reused, so the hot path allocates
nothing but the argument strings. The parser's 49 unit tests, the 100,000-case fuzzer, a
20,000-op differential run, and the crash and replication suites all pass unchanged.

### Before and after

**The parser alone** (`npx tsx bench/parser.ts`: a pipeline cut into 16 KB chunks, no sockets).
Each cell is the median of three process runs of the best of 15 rounds:

| Workload                                      |        Before |         After |   Change |
| --------------------------------------------- | ------------: | ------------: | -------: |
| `SET key:<n> xxx`, 200,000 commands           | 532,590 cmd/s | 858,604 cmd/s | **+61%** |
| `MSET` with 10 pairs, 20,000 commands         |  96,989 cmd/s | 136,074 cmd/s | **+40%** |
| `SET` with a 100-byte value, 200,000 commands | 565,529 cmd/s | 802,859 cmd/s | **+42%** |

**End to end** (`PROFILE=0 RUNS=5 bash bench/profile.sh`: the built server over loopback, `-P 16`,
median of five runs):

| Test           |  Before |   After | Change |
| -------------- | ------: | ------: | -----: |
| PING_MBULK     | 234,577 | 258,398 |   +10% |
| SET            | 123,686 | 126,920 |    +3% |
| GET            | 179,856 | 208,986 |   +16% |
| INCR           | 107,101 | 121,966 |   +14% |
| LPUSH          | 140,647 | 127,081 |   −10% |
| HSET           | 105,820 | 117,633 |   +11% |
| MSET (10 keys) |  25,692 |  29,253 |   +14% |

**The profile** (same command, same machine): `FastBuffer` and `subarray` went from 6.8% to
nothing, GC from 3.1% to 2.6%, and total time inside `parse` from 31.2% to 26.2% of samples.
The whole benchmark took 91 s of samples instead of 103 s for the same work, 12% less CPU.

The parser itself is 40–60% faster, but parsing is only part of each command, so end to end
most tests gain 10–16%. SET and LPUSH moved by less than this machine's run-to-run noise:
their five runs spread over ±20%, so +3% and −10% don't mean anything either way.

### What's next

After the fix the top frame is `murmur3_32` at 12.5% of self time. A `SET` hashes its key five
times: once in `dict` and twice in `expires` for the lookup, then `dict` again and `expires`
again for the write. In this benchmark, and in many real datasets, `expires` is empty. Redis's
`dictFind` returns early on an empty dict before hashing (`dict.c`), and doing the same in
`Dict.get`, `has` and `delete` would remove three of the five hashes. After that come
`touchWatchedKey` (3%, a `Map` lookup per write even with no watchers at all) and the
dispatcher's two `hrtime.bigint()` calls per command.

## Why Redis wins

- **C against a garbage-collected runtime.** Redis's per-command path is a few function calls
  over structs it laid out itself. Ours allocates JS objects (argument strings, the `argv` array,
  a command context, reply strings), and V8 has to collect them.
- **Compact encodings.** Small sets, hashes, lists and sorted sets in Redis are listpacks or
  intsets: one contiguous block, searched linearly, cheap to append to. We always build full
  hash tables and skip lists (spec 2: out of scope), which costs both time and the 3.6× memory.
- **Hashing.** Redis caches nothing either, but SipHash in C over a short key is a handful of
  nanoseconds. Our MurmurHash3 in JS works through `charCodeAt` and 32-bit `Math.imul`.
- **The network stack.** Redis writes replies with its own buffers and `write`/`writev`
  directly. We go through Node's stream machinery: `cork`, `uncork`, `writeGeneric`.
- **`fork()`.** Redis's BGSAVE runs in a child process on another core. Ours shares the
  one thread, in 2 ms slices, which shows up as the 24 ms worst PING above.
