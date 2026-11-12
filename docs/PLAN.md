# MiniRedis — Build Plan & Architecture

Nov 11, 2026 · @RISHIT

## Overview

MiniRedis is a Redis-compatible in-memory database server written in TypeScript with zero runtime dependencies. The real `redis-cli`, `redis-benchmark` and the `ioredis` client work against it unchanged, and that compatibility is the headline.

What makes an interviewer stop and ask questions:

- **Real wire protocol.** It speaks RESP2 and RESP3, so official Redis tools become your test clients and your benchmark.
- **Hand-built data structures.** A hash table with incremental rehashing, a skip list for sorted sets, a chunked list. Nothing hides behind a JavaScript `Map`.
- **Real durability.** Append-only file with three fsync modes, background rewrite, binary snapshots with checksums, and crash tests that `kill -9` the server.
- **Replication.** One primary, many replicas, full and partial resync using Redis's own handshake.
- **Memory limits.** `maxmemory` with approximate LRU and LFU eviction, the same sampling tricks Redis uses.
- **Proven correct.** A differential test sends the same random commands to real Redis and to MiniRedis and diffs every reply.
- **Measured.** Benchmarks against real Redis, flame graphs, and one optimisation with before/after numbers.

Scope: about 110 commands across 10 phases. Phases 0–5 are the shippable core; phases 6–9 are what make it stand out.

## Tech stack

Build it in TypeScript on Node.js, using only Node's built-in modules at runtime. Every dependency in `package.json` is a dev dependency.

Why TypeScript and not Go or Rust:

- **You already know it.** Your learning budget goes into database internals, not a new language.
- **Same threading model as Redis.** Node runs your code on one event-loop thread with non-blocking I/O. Redis works the same way, so you can explain why that is fast from first-hand experience.
- **"Zero dependencies" stands out** in an ecosystem where everyone reaches for npm.
- **Honest cost.** Node cannot `fork()`, so snapshots need your own design (one of the hard parts), and garbage-collection pauses show up in latency. Both are good interview material.

If you later want Go on your resume, the architecture in this doc carries over unchanged.

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript, `strict` mode | Types catch protocol and data-structure bugs early |
| Runtime | Node.js, current LTS | Event loop, `net`, `fs`, `Buffer` built in |
| Networking | `node:net` | Raw TCP sockets, no framework |
| Disk I/O | `node:fs` file handles + `fsync` | Full control over durability |
| Metrics endpoint | `node:http` | Prometheus `/metrics` without Express |
| Dev runner / build | `tsx` / `tsc` | Fast reloads; plain JS output |
| Tests | Vitest | Fast, TypeScript-native |
| Property tests | fast-check | Generates random command sequences |
| Test client | ioredis (dev only) | Proves a real client library works unchanged |
| Reference server | Official `redis` Docker image | The referee for differential tests and benchmarks |
| Benchmarks | `redis-benchmark` | The industry tool, ships with Redis |
| Profiling | `node --cpu-prof`, 0x | Flame graphs of hot paths |
| Lint / format | ESLint + Prettier | Consistent code for reviewers |
| Packaging / CI | Docker, docker-compose, GitHub Actions | Free tiers; one-command demo |

## Architecture

A command's whole life runs on Node's single event-loop thread, the same model Redis uses, so no command ever needs a lock.

&#91;embedded content: request path · 6 steps, 3 side systems\]

The handler step is also where pub/sub messages fan out and blocked BLPOP clients get woken; only write commands reach the AOF and the replicas.

## Project structure

One folder per subsystem, so each folder is one thing to study. The comment beside each file says what it owns.

```text
miniredis/
├── src/
│   ├── index.ts                  # entry: load config, start server, handle SIGTERM
│   ├── config.ts                 # defaults, CLI flags, miniredis.conf, CONFIG GET/SET
│   ├── server/
│   │   ├── server.ts             # net.Server, accept connections, maxclients
│   │   ├── client.ts             # per-connection state: buffer, db, MULTI queue, subscriptions
│   │   ├── cron.ts               # serverCron, runs every 100 ms
│   │   └── shutdown.ts           # graceful stop: flush AOF, save snapshot, close sockets
│   ├── protocol/
│   │   ├── parser.ts             # incremental RESP parser (survives split packets)
│   │   ├── encoder.ts            # RESP2 and RESP3 reply builders
│   │   └── inline.ts             # plain-text commands typed over telnet / nc
│   ├── commands/
│   │   ├── registry.ts           # command table: name, arity, flags, handler
│   │   ├── dispatch.ts           # lookup, checks, MULTI queueing, write propagation
│   │   ├── strings.ts            # SET GET INCR APPEND GETRANGE MSET ...
│   │   ├── keys.ts               # DEL EXISTS EXPIRE TTL TYPE RENAME SCAN ...
│   │   ├── lists.ts              # LPUSH RPOP LRANGE LINSERT BLPOP ...
│   │   ├── hashes.ts             # HSET HGET HGETALL HINCRBY HSCAN ...
│   │   ├── sets.ts               # SADD SINTER SUNION SDIFF SPOP ...
│   │   ├── zsets.ts              # ZADD ZRANGE ZRANK ZINCRBY ...
│   │   ├── pubsub.ts             # SUBSCRIBE PSUBSCRIBE PUBLISH PUBSUB
│   │   ├── transactions.ts       # MULTI EXEC DISCARD WATCH
│   │   ├── server.ts             # PING INFO DBSIZE FLUSHDB SAVE BGSAVE CONFIG DEBUG
│   │   ├── connection.ts         # HELLO AUTH SELECT CLIENT LIST/KILL/SETNAME
│   │   └── replication.ts        # REPLICAOF PSYNC REPLCONF WAIT
│   ├── datastructures/
│   │   ├── dict.ts               # hash table, incremental rehashing, SCAN cursor
│   │   ├── skiplist.ts           # sorted index with span counts for ZRANK
│   │   ├── zset.ts               # dict + skiplist working together
│   │   └── quicklist.ts          # list as linked chunks (fast push/pop both ends)
│   ├── storage/
│   │   ├── database.ts           # keyspace dict + expires dict, 16 databases
│   │   ├── redis-object.ts       # type tag, encoding, LRU clock / LFU counter
│   │   ├── expiry.ts             # lazy expiry + active expiry cycle
│   │   ├── eviction.ts           # maxmemory policies, sampling eviction pool
│   │   └── memory.ts             # approximate per-object memory accounting
│   ├── persistence/
│   │   ├── aof.ts                # append, fsync policies, replay on boot
│   │   ├── aof-rewrite.ts        # background compaction + rewrite buffer + atomic swap
│   │   ├── snapshot-writer.ts    # binary snapshot, written in chunks, copy-on-write
│   │   ├── snapshot-reader.ts    # load and verify checksum
│   │   └── crc64.ts              # checksum
│   ├── replication/
│   │   ├── primary.ts            # replica registry, full sync, command stream
│   │   ├── replica.ts            # handshake, load snapshot, apply stream, send ACKs
│   │   └── backlog.ts            # ring buffer for partial resync
│   ├── pubsub/hub.ts             # channel and pattern subscriptions
│   ├── blocking/waiters.ts       # BLPOP waiters, timeouts, wake-up order
│   ├── observability/
│   │   ├── info.ts               # INFO sections
│   │   ├── slowlog.ts            # SLOWLOG ring buffer
│   │   ├── monitor.ts            # MONITOR stream
│   │   └── metrics-http.ts       # Prometheus /metrics on node:http
│   └── utils/
│       ├── glob.ts               # Redis-style glob for KEYS, SCAN MATCH, PSUBSCRIBE
│       ├── numbers.ts            # strict integer/float parsing with Redis error text
│       └── logger.ts             # levelled logger, no deps
├── tests/
│   ├── unit/                     # parser, dict, skiplist, glob, crc64
│   ├── integration/              # ioredis against a live server on a random port
│   ├── differential/             # same random commands to Redis and MiniRedis, diff replies
│   ├── property/                 # fast-check model-based tests
│   ├── crash/                    # kill -9 mid-write, restart, verify data
│   └── fuzz/                     # garbage bytes into the parser
├── bench/
│   ├── run.sh                    # redis-benchmark against both servers
│   └── RESULTS.md                # numbers, charts, flame graphs
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PERSISTENCE.md
│   ├── REPLICATION.md
│   ├── walkthroughs/             # one per phase, written at the end of each phase
│   └── adr/                      # one file per design decision
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml        # primary + 2 replicas + real Redis for tests
├── .github/workflows/ci.yml      # lint, typecheck, unit, integration, differential
├── CLAUDE.md                     # rules and spec Claude reads every session
├── miniredis.conf                # sample config
├── package.json
├── tsconfig.json
└── README.md
```

One dependency rule keeps it clean: `protocol/` and `datastructures/` import nothing from the rest of the server, and command handlers never touch sockets. That rule is what lets you unit-test the hard parts in isolation.

## Feature scope

Ship the core first. The standout tier is what gets you a second interview. Stretch only if time is left over.

| Tier | Area | What's included |
| --- | --- | --- |
| Core | Protocol | RESP2 parser and encoder, pipelining, inline commands |
| Core | Strings and keys | SET with NX/XX/EX/PX/KEEPTTL/GET, GET, DEL, EXISTS, INCR/DECR/INCRBY/INCRBYFLOAT, APPEND, STRLEN, MGET/MSET, GETRANGE/SETRANGE, TYPE, RENAME, KEYS, SCAN |
| Core | Expiry | EXPIRE, PEXPIRE, EXPIREAT, TTL, PTTL, PERSIST; lazy and active expiry |
| Core | Data types | Lists, hashes, sets, sorted sets (about 50 commands, including ZRANGE BYSCORE/REV/LIMIT and SINTER/SUNION/SDIFF) |
| Core | Persistence | AOF with always/everysec/no fsync, AOF rewrite, SAVE/BGSAVE snapshots, recovery on boot |
| Core | Transactions | MULTI, EXEC, DISCARD, WATCH, UNWATCH |
| Core | Pub/sub | SUBSCRIBE, UNSUBSCRIBE, PSUBSCRIBE, PUBLISH, PUBSUB CHANNELS/NUMSUB |
| Core | Server | PING, ECHO, SELECT, DBSIZE, FLUSHDB, FLUSHALL, INFO, CONFIG GET/SET, COMMAND |
| Standout | Blocking ops | BLPOP, BRPOP, BLMOVE with timeouts and fair wake-up order |
| Standout | Memory | maxmemory, all 8 eviction policies, OBJECT IDLETIME/FREQ/ENCODING, MEMORY USAGE |
| Standout | Replication | REPLICAOF, full and partial resync, backlog, read-only replicas, WAIT |
| Standout | RESP3 | HELLO 3, maps, sets, doubles, push messages for pub/sub |
| Standout | Safety limits | requirepass/AUTH, maxclients, client output buffer limits, max request size |
| Standout | Observability | INFO sections, SLOWLOG, MONITOR, CLIENT LIST/KILL/SETNAME, `/metrics` for Prometheus, DEBUG DIGEST |
| Standout | Proof | Differential tests vs Redis, crash tests, fuzzing, benchmarks with flame graphs |
| Stretch | HyperLogLog | PFADD, PFCOUNT, PFMERGE: count billions of unique items in 12 KB |
| Stretch | Streams | XADD, XRANGE, XREAD with blocking |
| Stretch | Cluster mode | 16,384 hash slots, CRC16 key hashing, MOVED/ASK redirects |

Skip Lua scripting. It means embedding a whole language runtime and teaches little about databases.

## Phase-by-phase build plan

Ten phases, each ending in checks you can run yourself. Do not start a phase until the previous one's checks pass.

### Phase 0 — Setup

- Repo, strict `tsconfig`, ESLint, Prettier, Vitest, `tsx`; npm scripts `dev`, `build`, `test`, `bench`
- `CLAUDE.md` with the rules from "Building it with Claude" below
- Dockerfile, plus docker-compose with a real Redis container for later tests
- GitHub Actions running lint, typecheck and tests on every push

Done when:

- [ ] CI is green on an empty test suite

### Phase 1 — Talk RESP over TCP

- `net.Server`, per-client state, incremental RESP parser and encoder, inline commands
- Command table with arity and flags; PING, ECHO, SET, GET, DEL
- Stub COMMAND and CONFIG GET, which `redis-cli` and `redis-benchmark` may call on connect
- Pipelining: run every complete command in a chunk, then send all replies in one write

Done when:

- [ ] `redis-cli -p 6380 set a 1` and `get a` work
- [ ] A unit test feeds the parser one byte at a time and still gets the right commands
- [ ] `redis-benchmark -p 6380 -t set,get -P 16` finishes without errors

### Phase 2 — Keyspace, strings, expiry, and the referee

- Own dict with incremental rehashing; 16 databases; SELECT
- Full strings and keys command set with Redis's exact error messages
- Expiry: check on every access, plus an active cycle that samples keys with a TTL, deletes expired ones, and repeats while more than 25% were expired, under a time cap
- SCAN with Redis's reverse-binary cursor; glob matcher for KEYS and MATCH
- Differential test harness against real Redis. Build it now so it guards every later phase

Done when:

- [ ] 10,000 random string and key commands produce zero diffs against Redis
- [ ] 1M keys with a 1-second TTL disappear without ever being read

### Phase 3 — Data types

- Lists (quicklist), hashes, sets, sorted sets (skip list + dict)
- WRONGTYPE errors; delete a key when its list, hash or set becomes empty, as Redis does
- ZRANGE with BYSCORE, BYLEX, REV, LIMIT; ZRANK in O(log n) using skip-list spans

Done when:

- [ ] Differential tests cover all four types with zero diffs
- [ ] A benchmark shows ZRANK time barely changes between 10k and 1M members

### Phase 4 — Persistence

- AOF: append each write command in RESP form; fsync `always`, `everysec` or `no`; replay on boot; tolerate a half-written last command
- AOF rewrite (BGREWRITEAOF): build a compact file from current state, buffer writes that arrive meanwhile, then swap with an atomic rename
- Snapshots (SAVE, BGSAVE): own binary format with header, type tags, TTLs and a CRC64 footer; BGSAVE runs in chunks between event-loop ticks with app-level copy-on-write
- Boot order: AOF if enabled, else the snapshot

Done when:

- [ ] A crash test kills the server with SIGKILL 50 times under write load, and every restart loads cleanly
- [ ] With `appendfsync always`, no acknowledged write is ever lost
- [ ] BGSAVE on a large dataset never blocks other clients for long (measure max latency during the save)

### Phase 5 — Transactions, pub/sub, blocking

- MULTI/EXEC/DISCARD; errors at queue time abort EXEC, errors at run time do not (no rollback, like Redis)
- WATCH with per-key dirty tracking, including expiry, FLUSHDB and eviction
- SUBSCRIBE, PSUBSCRIBE, PUBLISH; subscriber mode only allows subscribe-family commands
- BLPOP, BRPOP, BLMOVE: waiter registry, wake on push, timeouts in cron, first-blocked-first-served

Done when:

- [ ] WATCH makes EXEC return nil when another client touches the key
- [ ] Two `redis-cli` terminals do pub/sub, including patterns
- [ ] BLPOP returns the moment another client pushes

**Core is shippable here.** Phases 6–9 turn it from a good project into a memorable one.

### Phase 6 — Memory limits and eviction

- Per-object memory estimate; `used_memory` in INFO
- maxmemory with all 8 policies; approximate LRU (24-bit clock, sample 5 keys, a pool of the best 16 candidates)
- LFU with Redis's logarithmic 8-bit counter and decay
- OBJECT IDLETIME, OBJECT FREQ, OBJECT ENCODING, MEMORY USAGE

Done when:

- [ ] With `maxmemory 50mb` and `allkeys-lru`, a 200 MB write stream keeps memory flat
- [ ] A hit-rate test shows frequently read keys survive eviction

### Phase 7 — Replication

- REPLICAOF host port; handshake PING, REPLCONF listening-port, REPLCONF capa psync2, PSYNC
- Full resync: `+FULLRESYNC`, stream the snapshot, then the live command stream; replicas reject writes
- Replication ID, offsets, 1 MB backlog ring buffer, partial resync with `+CONTINUE`
- REPLCONF ACK every second; WAIT numreplicas timeout; INFO replication

Done when:

- [ ] docker-compose runs 1 primary + 2 replicas, and DEBUG DIGEST matches on all three after a random write load
- [ ] Cutting a replica's network for 5 seconds ends in a partial resync, not a full one

### Phase 8 — Hardening and observability

- RESP3 through HELLO 3; AUTH with requirepass; maxclients; idle timeout
- Client output buffer limits: disconnect a slow reader instead of buffering forever
- Protocol limits on bulk length and array size; parser fuzzing
- INFO sections, SLOWLOG, MONITOR, CLIENT LIST/KILL/SETNAME, `/metrics`, graceful SIGTERM

Done when:

- [ ] The fuzzer sends 1M random inputs without a crash or hang
- [ ] A subscriber that never reads gets disconnected while server memory stays flat

### Phase 9 — Proof and polish

- Benchmarks vs real Redis on the same machine with the same flags; flame graphs
- One optimisation with before/after numbers
- README, architecture diagram, demo GIF, docs and ADRs

Done when:

- [ ] The top of the README answers what it is, how fast it is, and how you know it's correct

## The hard parts

Your two biggest learning stretches are persistence (phase 4) and replication (phase 7). Budget extra study days for both. The full list, hardest first:

| # | Hard part | Why it's hard | What you'll understand after |
| --- | --- | --- | --- |
| 1 | Snapshot without `fork()` | Redis forks and the OS gives it copy-on-write memory for free. Node can't, so you save keys in chunks between ticks while clients keep writing, copying a key's old value just before it changes | Point-in-time consistency, copy-on-write, why Redis relies on fork |
| 2 | Replication with partial resync | Two processes, a flaky network, and byte offsets that must line up exactly. A snapshot and then a command stream share one socket | Replication logs, offsets, async replication, eventual consistency |
| 3 | AOF rewrite without losing writes | Writes keep arriving during the rewrite. They must go to the old file and a rewrite buffer, then the swap must survive a crash at any moment | fsync, atomic rename, crash windows, durability guarantees |
| 4 | Incremental RESP parser | TCP is a byte stream, not messages. A command can split at any byte, or 100 commands can arrive in one chunk | Framing, buffers, state machines, backpressure |
| 5 | Incremental rehashing + SCAN | Resizing a 10M-key table in one go freezes the server, so you move a few buckets per operation. SCAN must not miss keys while the table grows or shrinks | Amortised cost, hashing, the reverse-binary cursor trick |
| 6 | Skip list with spans | A randomised structure that stays balanced on average; spans give a member's rank in O(log n) | Probabilistic data structures; why Redis chose it over a balanced tree |
| 7 | Approximate LRU and LFU | Exact LRU needs a linked list over every key. Redis samples instead, and LFU uses a logarithmic counter that decays | Trading accuracy for memory, probabilistic counting |
| 8 | Blocking commands | A client waits without blocking the thread. Wake-up order, timeouts, and replicating BLPOP as a plain pop all need care | Event-driven design, fairness |
| 9 | WATCH semantics | Every way a key can change must mark it dirty, including expiry, FLUSHDB and eviction | Optimistic concurrency control |
| 10 | Memory accounting in JS | V8 hides real object sizes, so you estimate per object and calibrate against `process.memoryUsage()` | The V8 heap, GC, why GC languages make databases harder |

## Testing strategy

The differential test is the line that impresses most: "I checked correctness against Redis itself." Every other layer supports it.

| Layer | What it proves | Tool | Example |
| --- | --- | --- | --- |
| Unit | Each hard module works alone | Vitest | Parser fed one byte at a time; skip-list invariants after 100k random inserts |
| Integration | A real client library works unchanged | Vitest + ioredis | Pipelines, transactions and pub/sub through ioredis on a random port |
| Differential | Replies match real Redis exactly | Own generator, Redis in Docker | Same seeded random command stream to both servers, every reply diffed |
| Property / model | No sequence of commands breaks state | fast-check | Random sequences compared against a tiny model built on a JS `Map` |
| Crash | Persistence keeps its promises | Node child process + SIGKILL | Kill at random points under write load; check acknowledged writes per fsync mode |
| Fuzz | Bad input never crashes the server | Own byte generator | Truncated, oversized and garbage RESP; server must reply with errors, never die |
| Replication | Replicas end up identical | docker-compose + DEBUG DIGEST | Random writes to the primary, then compare digests on all nodes |

Two habits make these tests worth showing:

- **Seed everything.** A failing random test prints its seed, so `npm run diff -- --seed 81723` replays the exact failure.
- **Run the differential suite in CI** with Redis as a service container, so every push is checked against the real thing.

## Benchmarks and proof

Measure MiniRedis against real Redis on the same machine, then explain the gap. Redis will win; the interview value is knowing exactly where and why.

1. Run `redis-benchmark` against both servers with identical flags, once without pipelining and once with it:

   ```bash
   redis-benchmark -p 6379 -t set,get,incr,lpush,lpop,zadd -n 1000000 -c 50 -q   # real Redis
   redis-benchmark -p 6380 -t set,get,incr,lpush,lpop,zadd -n 1000000 -c 50 -q   # MiniRedis
   redis-benchmark -p 6380 -t set,get -n 1000000 -c 50 -P 16 -q                    # pipelined
   ```
2. Record ops/sec and p50/p99 latency per command in `bench/RESULTS.md`, with a chart in the README.
3. Profile with `node --cpu-prof` or 0x and find the top hotspot. Typical suspects: `Buffer.concat` on every read, string conversion of bulk values, one `socket.write` per reply instead of one per batch.
4. Fix one hotspot and publish the before/after numbers. One measured optimisation beats ten claimed ones.
5. Also measure memory per key (1M keys of 100 bytes), restart time from AOF vs snapshot, and replica lag under load.

Pin down the machine, Node version and Redis version in `RESULTS.md` so anyone can rerun it.

## Building it with Claude

You have 5 days of Claude Code, so each day is one long session that builds about two phases, with this doc and `CLAUDE.md` as the spec. Studying comes later, so Claude must leave behind everything you need to learn the code without it.

Put these rules in `CLAUDE.md` before phase 1:

```markdown
# MiniRedis rules
- Zero runtime dependencies. Node built-ins only. Dev deps are fine.
- Match real Redis exactly: reply types, error strings, edge cases.
- Never use a JS Map or Set for the keyspace, hashes or sets. Use src/datastructures/dict.ts.
- protocol/ and datastructures/ import nothing from the rest of src/.
- Every command ships with unit tests and differential tests.
- Each module starts with a header comment: what it does, the key design
  choice, and which Redis source file it mirrors (e.g. t_zset.c).
- Comments explain why, not what.
- Write an ADR in docs/adr/ for every non-obvious decision.
- A phase is done only when all tests pass and the redis-cli smoke test works.
- At the end of each phase, write docs/walkthroughs/phase-N.md: the request
  path, key functions, trade-offs, and what you would do differently.
- Commit per feature with clear messages.
```

Prompt for each session, changing only the phase numbers:

```text
Read CLAUDE.md and docs/ARCHITECTURE.md. Build Phases 3 and 5 from the plan, one after the other.
Write tests first, then the code. Run the full test suite and the
differential tests until they pass. Then write the phase walkthrough.
Stop and ask me if a design choice could reasonably go either way.
```

### Making 5 days count

- **Prep tonight, without Claude Code.** Create the repo, paste the rules above into `CLAUDE.md`, and export this doc as Markdown into `docs/PLAN.md`.
- **Plan around the usage limit.** Pro's usage resets after a few hours. When you hit the limit, read what was just built until it resets.
- **Don't spend sessions on long explanations.** Ask for walkthrough files instead and read them later.
- **Commit after every phase**, so each phase is one clean diff to study later.
- **Day 5, last hour: build the study kit.** Have Claude write `docs/INTERVIEW.md`, answering every question in Interview prep with file and line references, and `docs/EXERCISES.md`, with break-it-on-purpose exercises for each module.
- **After Pro ends**, you can still paste code into a regular Claude chat and ask about it.

## Understanding it afterwards

Study after the 5 build days, one phase at a time in build order. The walkthroughs, `docs/INTERVIEW.md` and `docs/EXERCISES.md` that Claude writes during the build mean you won't need Claude Code for any of it.

For each phase:

1. **Read the walkthrough** Claude wrote in `docs/walkthroughs/`, then the module header comments.
2. **Trace one command end to end** with breakpoints (`node --inspect` + VS Code). For phase 1, follow `SET a 1` from raw socket bytes to the `+OK` reply.
3. **Break it on purpose.** Delete the rehash step, skip the fsync, drop a WATCH dirty flag, then see which test fails. If none does, you found a missing test.
4. **Explain it out loud** in two minutes without notes. Record it if you can; the gaps are obvious on playback.
5. **Compare with real Redis** using the source files below.

Near the end of your study days, rewrite three modules by hand without looking: the RESP parser, the skip list, and the dict with incremental rehashing. These are the ones an interviewer can ask you to code on a whiteboard.

| Your module | Redis source file to compare |
| --- | --- |
| `protocol/parser.ts`, `server/client.ts` | `networking.c` |
| `datastructures/dict.ts` | `dict.c` |
| `datastructures/skiplist.ts`, `zset.ts` | `t_zset.c` |
| `datastructures/quicklist.ts` | `quicklist.c` |
| `storage/expiry.ts` | `expire.c` |
| `storage/eviction.ts` | `evict.c` |
| `persistence/aof*.ts` | `aof.c` |
| `persistence/snapshot-*.ts` | `rdb.c` |
| `replication/*` | `replication.c` |
| `commands/transactions.ts` | `multi.c` |
| `pubsub/hub.ts` | `pubsub.c` |
| `blocking/waiters.ts` | `blocked.c` |
| `server/cron.ts` | `server.c` (`serverCron`) |

Study references:

- [Redis source code](https://github.com/redis/redis), the `src/` folder
- [Redis serialization protocol specification](https://redis.io/docs/latest/develop/reference/protocol-spec/)
- [Redis persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
- [Redis replication](https://redis.io/docs/latest/operate/oss_and_stack/management/replication/)
- [Key eviction](https://redis.io/docs/latest/develop/reference/eviction/)

## Interview prep

Tick a question only when you can answer it out loud, with your own code open, in under two minutes.

**Core design**

- [ ] Why is Redis single-threaded and still fast? Where does your server spend its time?
- [ ] What happens, step by step, when `redis-cli` sends `SET a 1`?
- [ ] How does your parser handle a command split across two TCP packets? Or 1,000 commands in one packet?
- [ ] What is pipelining, and why does it multiply throughput?
- [ ] How would you make it use more than one core? What did Redis 6 do with I/O threads?

**Data structures**

- [ ] Why does Redis use a skip list for sorted sets instead of a balanced tree? How does ZRANK run in O(log n)?
- [ ] What is incremental rehashing, and what problem does it solve?
- [ ] How does SCAN avoid missing keys while the table resizes?
- [ ] How do keys expire if nobody ever reads them? Why sample instead of scanning everything?

**Durability**

- [ ] AOF vs snapshot: what does each lose in a crash? What does `appendfsync everysec` really promise?
- [ ] How does AOF rewrite avoid losing writes that arrive during the rewrite?
- [ ] Redis uses `fork()` for BGSAVE. You couldn't. What did you do instead, and what does it cost?

**Distribution and concurrency**

- [ ] How does a replica catch up after a 5-second disconnect without a full copy?
- [ ] Is Redis replication strongly consistent? What does WAIT guarantee, and what doesn't it?
- [ ] How does WATCH work? Does MULTI/EXEC roll back on error?
- [ ] What happens when a pub/sub subscriber stops reading?

**Memory and proof**

- [ ] How does approximate LRU work, and why not exact LRU? How does LFU count with 8 bits?
- [ ] How did you prove MiniRedis is correct?
- [ ] Where is MiniRedis slower than Redis, and why?

## Schedule

You have 5 days of Claude Code Pro, so all ten phases get built on days 1–5, about two per day, and studying comes after. Studying needs only your editor, the walkthroughs and the study kit Claude writes on day 5.

&#91;embedded content: build schedule · 12 days, 9 blocks, 1 gate\]

If you fall behind, cut in this order: RESP3 and the phase 8 extras first, then eviction (phase 6). Never cut the differential tests, persistence or replication; they are why this project stands out. Days 6–13 run at your own pace, using the steps in "Understanding it afterwards".

## README and resume

A reviewer spends under a minute on your repo. The top of the README has to show that it works with real tools, how fast it is, and how you know it is correct.

README, top to bottom:

1. One-line pitch and badges: CI, test count, "differential-tested against Redis"
2. A short GIF: `redis-cli` and `redis-benchmark` running against MiniRedis
3. Results table: MiniRedis vs Redis ops/sec and p99, with the machine named
4. Architecture diagram, plus links to `docs/`
5. What's implemented: a command checklist grouped by type
6. Quick start: `docker compose up`, then `redis-cli -p 6380`
7. Design decisions: links to the ADRs, especially the fork-less snapshot

Resume bullets (fill in the numbers once you measure them):

- Built MiniRedis, a Redis-compatible in-memory database in TypeScript with zero runtime dependencies; works unchanged with `redis-cli`, `redis-benchmark` and ioredis across about 110 commands.
- Implemented AOF and snapshot persistence with SIGKILL crash-recovery tests, and primary–replica replication with partial resync through a replication backlog.
- Verified correctness with a differential harness that replays seeded random command streams against real Redis; reached \[N\] ops/sec, \[X\]% of Redis, under `redis-benchmark`.

Rehearse a 5-minute live demo: start a primary and replica with docker-compose, write through `redis-cli`, `kill -9` the primary, restart it, show the data is back, then show the replica resyncing.
