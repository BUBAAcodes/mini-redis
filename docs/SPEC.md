# MiniRedis: Build Spec

A Redis-compatible in-memory database server, written from scratch in TypeScript with zero runtime dependencies. The real `redis-cli`, `redis-benchmark` and ioredis work against it unchanged.

This file is the single source of truth for the project. If it disagrees with `docs/PLAN.md` or anything else, this file wins.

**Claude Code: before every session, read sections 0, 3, 4 and 7 in full, then every section the current step lists under "Read".** The file is long and Claude Code time is limited to 5 days, so read only what the step needs.

---

## 0. How to work with this spec

**For every build step (section 14):**
1. Read the sections above, the step's "Read" list, and the code the step will touch.
2. Show a short plan (10 lines at most) and wait for approval.
3. Write the step's tests first, then the code.
4. Run `npm run typecheck`, `npm run lint` and `npm test`, plus any suite the step names. Fix until everything passes.
5. Write `docs/walkthroughs/step-NN.md` from the template below. Keep the chat summary to five lines; the explaining goes in the file, which I'll study after the build days.
6. Commit with a message like `step-04: dict with incremental rehashing`.

**Walkthrough template (one page at most):**
- What this step built, in three sentences.
- One real command's path through the new code, with `file:line` for each hop.
- The key functions and why each exists.
- Trade-offs, and what real Redis does differently (name the Redis source file).
- The single most important line, and which test fails if it's deleted.
- Three quiz questions, with answers inside a `<details>` block.

**Ground rules:**
- One step at a time. Don't start the next step on your own.
- Never break a rule in section 3. If a step seems to need it, stop and ask.
- Zero runtime dependencies. Dev dependencies only, each with a one-line reason in the commit message.
- Handlers are synchronous and named after their command (`setCommand`, `zaddCommand`), as in Redis's own source.
- Keyspaces, hashes and sets use `datastructures/dict.ts`, never a JS `Map` or `Set`. (Maps are fine for small registries such as WATCH and pub/sub.)
- Every module starts with a header comment: what it does, its key design choice, and the Redis source file it mirrors (for example `t_zset.c`).
- Comments explain why, not what.
- When you're unsure how Redis behaves, ask the reference server (section 16) instead of guessing: `docker compose exec redis redis-cli <command>`. Match it.
- An intentional difference from Redis goes in `docs/DIFFERENCES.md` with its reason (section 19). A choice tagged *(ADR)* in this file, or any other non-obvious one, gets a short ADR in `docs/adr/`.
- Commands marked † in section 8 are left for me to write by hand later. Don't build them.

---

## 1. What we're building, in plain words

Redis is a database that keeps all its data in memory, so a read or write takes microseconds. Programs talk to it over TCP with a simple protocol called RESP. MiniRedis is our own version: same protocol, same commands and the same behaviour for everything we build, so tools made for Redis work with it unchanged.

| Term | Meaning |
|---|---|
| RESP | Redis's wire protocol: typed, length-prefixed messages |
| Command table | Every command MiniRedis knows, with its argument count and flags |
| Database | One keyspace; there are 16, numbered 0–15, chosen with SELECT |
| Dict | Our hash table, mapping keys to values |
| Rehashing | Growing or shrinking a dict by moving a few buckets at a time |
| TTL | Time to live: when a key expires |
| Lazy / active expiry | Deleting an expired key when it's touched / in a background sweep |
| Event loop | The one thread that runs every command, one after another |
| serverCron | The timer that does background chores, 10 times a second |
| beforeSleep | Work done once at the end of each event-loop turn: write the AOF, then send replies |
| Pipelining | A client sending many commands without waiting for each reply |
| AOF | Append-only file: every write command, in order, on disk |
| fsync | Asking the OS to really put file data on the disk |
| AOF rewrite | Replacing a long AOF with the shortest file that rebuilds the same data |
| Snapshot | A binary file holding the whole dataset as it was at one moment |
| Copy-on-write | Saving a key's old value just before it changes, so a snapshot in progress stays point-in-time |
| Primary / replica | The server that takes writes / a copy that follows it |
| Replication offset | How many bytes of the replication stream have been produced, or applied |
| Backlog | The last N bytes of the replication stream, kept so a replica can catch up after a short disconnect |
| PSYNC | The command a replica uses to ask for a full or a partial sync |
| Eviction | Deleting keys to stay under a memory limit |
| Blocking command | A command, such as BLPOP, that waits until data arrives |
| Differential test | Sending the same commands to real Redis and to MiniRedis and comparing every reply |

### One command, start to finish
1. You type `SET user:1 alice` in `redis-cli`.
2. `redis-cli` sends the bytes `*3\r\n$3\r\nSET\r\n$6\r\nuser:1\r\n$5\r\nalice\r\n`.
3. They may arrive in two TCP chunks. The parser keeps the first part and waits until the command is complete.
4. The dispatcher finds `set` in the command table, checks the argument count and the client's state, and runs `setCommand`.
5. `setCommand` stores `alice` under `user:1` in database 0 and marks the key as modified, which tells WATCH, memory accounting and any snapshot in progress.
6. SET is a write, so the command is appended to the AOF buffer and the replication stream.
7. At the end of the event-loop turn, `beforeSleep` hands the AOF buffer to the OS, then sends `+OK\r\n`.
8. A replica receives the same bytes, applies them, and within a second reports its new offset to the primary.

---

## 2. Scope

**In scope:** a TCP server speaking RESP2 and RESP3; about 130 commands across strings, keys, lists, hashes, sets, sorted sets, pub/sub, transactions, administration and replication, plus 25 more I add by hand; 16 databases; TTLs with lazy and active expiry; a memory limit with 8 eviction policies; an AOF with three fsync modes and background rewrite; point-in-time snapshots without `fork()`; crash recovery; primary–replica replication with full and partial resync and WAIT; blocking list commands; password auth; protocol, buffer and client limits; INFO, SLOWLOG, MONITOR, CLIENT and a Prometheus endpoint; differential, property, crash, fuzz and replication tests; benchmarks against real Redis; Docker; CI.

**Out of scope (real Redis has these; we skip them):** Lua scripts and Functions; modules; Streams, HyperLogLog, geo and bitmaps (some are stretch goals); Cluster and Sentinel; ACL users beyond one password; TLS; client-side caching; keyspace notifications (stretch); I/O threads; compact encodings such as listpack and intset; reading or writing real RDB files; chained replicas; SORT, MIGRATE, DUMP/RESTORE, COPY, MOVE, SWAPDB; the LATENCY monitor; active defragmentation; sharded pub/sub.

---

## 3. Rules that must always hold

1. **One thread runs every command.** Handlers are synchronous: no `await`, Promises or callbacks inside a command. Background I/O (fsync, job file writes) may finish later, but its callbacks never touch the keyspace.
2. **Bytes, not text.** Keys, values, fields and members are byte strings: JS strings with one character per byte (0–255), made with `latin1`. Never decode client data as UTF-8. Convert back with `Buffer.from(s, 'latin1')` only at a socket or a file.
3. **Redis-exact replies.** The same reply types and the same error text as the pinned reference, Redis 7.4. The differential test (section 15.3) is the judge. Intentional differences are listed in `docs/DIFFERENCES.md`.
4. **All or nothing.** A command checks every argument before it changes anything. If it replies with an error, nothing changed.
5. **One door for keys.** Commands read and change keys only through `Db` methods (section 6.1), never by touching a dict directly, so expiry, WATCH, snapshots, memory accounting and the dirty counter see every change. Write commands look keys up with `lookupWrite` and call `db.signalModifiedKey(key)` exactly once after changing a key.
6. **Every change is propagated once, in order, exactly.** Each write that changed data goes once through `propagate()` to the AOF and the replicas, in the order it ran. Anything relative or random is rewritten into an exact form first (section 9.5): relative TTLs become absolute times, SPOP becomes SREM, INCRBYFLOAT becomes SET.
7. **Expired means gone.** No command returns the value of a key whose TTL has passed. A primary deletes it and propagates DEL; a replica hides it and waits for the primary's DEL. (DBSIZE and INFO may count it until it's collected, as in Redis.)
8. **Write before you reply.** A write's AOF bytes are handed to the OS before its reply is sent; with `appendfsync always` they are fsynced first too. A file is only ever replaced by: write a temp file → fsync → rename → fsync the directory.
9. **Snapshots are point-in-time.** A snapshot (BGSAVE, AOF rewrite, replica full sync) holds every key exactly as it was when the job started. Copy-on-write (section 9.8) guarantees it.
10. **No long pauses.** Only commands that are slow by design (KEYS, FLUSHALL, SAVE, DEBUG RELOAD, or a client asking for a huge range) may touch every key at once. Rehashing, active expiry, eviction, BGSAVE and AOF rewrite work in small slices with time budgets.
11. **Never trust the network.** Every length and count from a client is checked before memory is allocated. Bad input gets a protocol error and the connection closes. No input crashes or hangs the server.
12. **Replies keep their order.** Each client gets replies in the order it sent commands, across pipelining, blocking and transactions.
13. **Replicas are read-only copies.** A replica changes data only from its primary's stream, and its offset counts exactly the bytes it applied.
14. **Memory limits apply before the command.** With `maxmemory` set, eviction runs before any command flagged `denyoom`; if it can't free enough, the command gets `-OOM` and nothing changes.
15. **Our own name.** It's MiniRedis, "Redis-compatible". No Redis logo, and the README says Redis is a trademark of Redis Ltd. and MiniRedis isn't affiliated with it.

---

## 4. Stack and repo layout

| Piece | Choice |
|---|---|
| Language | TypeScript, `strict`, ES modules |
| Runtime | Node.js 26 LTS (24 also works); built-in modules only: `net`, `fs`, `crypto`, `http`, `os` |
| Runtime dependencies | None |
| Dev runner / build | `tsx` for development, `tsc` to `dist/` |
| Tests | Vitest + `@vitest/coverage-v8`, fast-check, ioredis (dev only) |
| Reference server | `redis:7.4` Docker image, for differential tests and benchmarks |
| CLI tools | `redis-cli` and `redis-benchmark`, installed locally or run from the Redis image |
| Lint / format | ESLint (`typescript-eslint`) + Prettier |
| Profiling | `node --cpu-prof`, `0x` through `npx` |
| Containers | Docker (multi-stage, `node:26-alpine`), Docker Compose |
| CI | GitHub Actions; image pushed to GHCR |
| Diagrams | Mermaid in the README and `docs/ARCHITECTURE.md` |

```text
miniredis/
├── src/
│   ├── index.ts                 # entry: flags + config file, start server, signals
│   ├── config.ts                # directives, defaults, units, CONFIG GET/SET
│   ├── server/
│   │   ├── server.ts            # Server state, net.Server, accept, maxclients
│   │   ├── client.ts            # per-connection state, output queue, limits
│   │   ├── event-loop.ts        # scheduleBeforeSleep() and beforeSleep()
│   │   ├── cron.ts              # serverCron
│   │   ├── propagate.ts         # one path from writes to the AOF and the replicas
│   │   └── shutdown.ts          # SHUTDOWN and SIGTERM
│   ├── protocol/
│   │   ├── parser.ts            # incremental RESP + inline parser
│   │   ├── encoder.ts           # RESP2/RESP3 reply builders
│   │   └── errors.ts            # ReplyError and the strings in section 7.4
│   ├── commands/
│   │   ├── registry.ts          # the command table
│   │   ├── dispatch.ts          # checks, MULTI queueing, timing, propagation, serving blocked keys
│   │   ├── strings.ts  keys.ts  lists.ts  hashes.ts  sets.ts  zsets.ts
│   │   └── pubsub.ts  transactions.ts  connection.ts  server.ts  replication.ts  debug.ts
│   ├── datastructures/
│   │   ├── dict.ts              # hash table, incremental rehash, SCAN cursor, sampling
│   │   ├── skiplist.ts          # sorted index with spans
│   │   ├── zset.ts              # dict + skiplist
│   │   └── quicklist.ts         # list as linked chunks
│   ├── storage/
│   │   ├── database.ts          # Db: the one door to keys (section 6.1)
│   │   ├── redis-object.ts      # type, value, LRU/LFU field, snapshot marker
│   │   ├── expiry.ts            # lazy check + active cycle
│   │   ├── eviction.ts          # policies, sampling, eviction pool
│   │   ├── memory.ts            # byte estimates
│   │   └── watch.ts             # WATCH registry
│   ├── persistence/
│   │   ├── snapshot-job.ts      # copy-on-write engine for BGSAVE, rewrite and full sync
│   │   ├── snapshot-format.ts   # binary writer and reader (section 11.2)
│   │   ├── aof.ts               # append, fsync policies, loading
│   │   ├── aof-rewrite.ts       # rewrite job, rewrite buffer, swap
│   │   ├── crc64.ts             # CRC-64/Jones, as in Redis
│   │   └── files.ts             # temp → fsync → rename → fsync dir
│   ├── replication/
│   │   ├── primary.ts           # replicas, PSYNC, full and partial sync, WAIT
│   │   ├── replica.ts           # handshake, loading, applying, ACKs, promotion
│   │   └── backlog.ts           # ring buffer with offsets
│   ├── pubsub/hub.ts            # channels and patterns
│   ├── blocking/waiters.ts      # blocked clients per key, timeouts, wake order
│   ├── observability/           # info.ts  slowlog.ts  monitor.ts  metrics-http.ts
│   └── utils/
│       ├── glob.ts              # Redis glob matching
│       ├── numbers.ts           # strict int64/float parsing and formatting
│       ├── bytes.ts             # latin1 helpers
│       ├── hash.ts              # MurmurHash3 with a random seed
│       ├── random.ts            # seedable PRNG; all randomness goes through it
│       └── logger.ts            # Redis-style log lines
├── tests/
│   ├── helpers/                 # server on port 0 with a temp dir, RESP test client
│   └── unit/  integration/  differential/  property/  crash/  fuzz/  replication/
├── bench/                       # run.sh, memory.ts, calibrate-memory.ts, RESULTS.md
├── docs/
│   ├── SPEC.md                  # this file
│   ├── PLAN.md                  # the plan doc, exported
│   ├── ARCHITECTURE.md  DIFFERENCES.md  INTERVIEW.md  EXERCISES.md
│   ├── walkthroughs/            # one per step
│   └── adr/                     # one short file per design decision
├── docker/healthcheck.js
├── .github/workflows/           # ci.yml, nightly.yml
├── .github/dependabot.yml
├── Dockerfile
├── docker-compose.yml
├── miniredis.conf               # sample config
├── CLAUDE.md
├── package.json  tsconfig.json  tsconfig.build.json  eslint.config.js  vitest.config.ts  .prettierrc
└── README.md
```

**Layering rules:**
- `protocol/`, `datastructures/` and `utils/` import nothing from the rest of `src/`.
- `commands/` never touch sockets or files; they use `Db`, the reply builders and the propagation helpers.
- `persistence/` and `replication/` reach keys only through `Db` and the snapshot engine.
- All server state lives on one `Server` object passed around explicitly. No module-level mutable state, because tests start several servers in one process.

---

## 5. Configuration

MiniRedis reads a config file and command-line flags, like `redis-server`:

```bash
node dist/index.js miniredis.conf --port 6380 --appendonly yes --replicaof 127.0.0.1 6381
```

- A config file has one directive per line, `name value [value ...]`; `#` starts a comment; values may be quoted.
- A flag is `--name` followed by every argument up to the next `--`. Flags override the file.
- Memory sizes take Redis's units: `1k` = 1,000, `1kb` = 1,024, `1m` = 1,000,000, `1mb` = 1,048,576, `1g`, `1gb`.
- `CONFIG GET` takes case-insensitive glob patterns. `CONFIG SET` changes directives marked mutable. Booleans are `yes`/`no`.

| Directive | Default | Mutable | Purpose |
|---|---|---|---|
| `port` | `6380` | no | TCP port; 6380 so it never clashes with a real Redis on 6379 |
| `bind` | `127.0.0.1` | no | Listen address; `0.0.0.0` only inside Docker |
| `requirepass` | empty | yes | Password for AUTH; empty means no auth |
| `databases` | `16` | no | Number of databases |
| `maxclients` | `10000` | yes | Extra connections get an error and are closed |
| `timeout` | `0` | yes | Close clients idle this many seconds; `0` = never |
| `tcp-keepalive` | `300` | no | TCP keepalive, in seconds |
| `hz` | `10` | yes | serverCron runs per second |
| `loglevel` | `notice` | yes | `debug`, `verbose`, `notice`, `warning` |
| `dir` | `./data` | no | Folder for every file MiniRedis writes |
| `dbfilename` | `dump.mrdb` | no | Snapshot file name |
| `save` | `3600 1 300 100 60 10000` | yes | Save points: snapshot after N seconds if at least M changes; `""` disables |
| `appendonly` | `no` | yes | AOF on or off; turning it on at runtime starts a rewrite |
| `appendfilename` | `appendonly.aof` | no | AOF file name |
| `appendfsync` | `everysec` | yes | `always`, `everysec` or `no` |
| `aof-load-truncated` | `yes` | yes | Load an AOF whose last command was cut off |
| `auto-aof-rewrite-percentage` | `100` | yes | Rewrite when the AOF grows this much over its last rewritten size |
| `auto-aof-rewrite-min-size` | `64mb` | yes | …but never below this size |
| `maxmemory` | `0` | yes | Memory limit in bytes; `0` = none |
| `maxmemory-policy` | `noeviction` | yes | One of the 8 policies in section 9.4 |
| `maxmemory-samples` | `5` | yes | Keys sampled per eviction round |
| `lfu-log-factor` | `10` | yes | How slowly the LFU counter grows |
| `lfu-decay-time` | `1` | yes | Minutes per LFU counter decrement |
| `list-max-node-items` | `128` | yes | Items per quicklist node (our own directive) |
| `proto-max-bulk-len` | `64mb` | yes | Largest bulk string (Redis: 512mb; V8 strings top out just under that) |
| `client-query-buffer-limit` | `256mb` | yes | Unparsed input allowed per client (Redis: 1gb) |
| `client-output-buffer-limit` | `normal 0 0 0 replica 256mb 64mb 60 pubsub 32mb 8mb 60` | yes | Hard limit, soft limit and soft seconds per client class |
| `slowlog-log-slower-than` | `10000` | yes | Microseconds; slower commands are logged |
| `slowlog-max-len` | `128` | yes | Entries kept |
| `replicaof` | empty | via REPLICAOF | `host port` of the primary |
| `masterauth` | empty | yes | Password a replica uses with its primary |
| `replica-read-only` | `yes` | yes | Replicas reject writes from normal clients |
| `repl-backlog-size` | `1mb` | yes | Replication backlog size |
| `repl-timeout` | `60` | yes | Seconds without traffic before a replication link is dropped |
| `repl-ping-replica-period` | `10` | yes | Seconds between the primary's PINGs to replicas |
| `enable-debug-command` | `no` | no | `yes` allows DEBUG; tests turn it on |
| `metrics-port` | `0` | no | Port for Prometheus `/metrics`; `0` = off |

---

## 6. Data model

### 6.1 In memory

**`Server`** holds everything global: config, `dbs[16]`, clients by id, the pub/sub hub, waiters, stats, `dirty` (changes since the last save), `lastSave`, `lruClock`, `runId`, replication state, persistence state (AOF handle and buffer, the running snapshot job, the rewrite buffer), and `cmdTime` (the clock reading for the running command).

**`Db`** is one database and the only door to its keys:
- `dict: Dict<RObj>` maps key → object; `expires: Dict<number>` maps key → expiry in Unix milliseconds.
- `watched: Map<key, Set<Client>>`, `blockingKeys: Map<key, Client[]>` (FIFO), `readyKeys: Set<key>`.
- `lookupRead(key)` returns the object or null, expires lazily, updates LRU/LFU and counts hits and misses. `peek(key)` does the same without touching LRU/LFU or stats; TYPE, TTL, EXISTS and OBJECT use it.
- `lookupWrite(key)` returns the object or null, expires lazily, and runs the copy-on-write hook (section 9.8) before the caller changes anything.
- `add(key, obj)`, `setKey(key, obj, { keepTtl })` (drops the TTL unless `keepTtl`), `delete(key)` → boolean.
- `setExpire(key, ms)`, `removeExpire(key)` → boolean, `getExpire(key)` → ms or -1.
- `signalModifiedKey(key)` touches WATCH, marks the key ready for blocked clients, updates memory accounting, and does `server.dirty++`.
- Every method that replaces or removes a value, or changes a TTL, runs the copy-on-write hook first. `add` and `setKey` stamp new objects for a running snapshot job.

**`RObj`** is `{ type, value, lru, savedEpoch }`:
- `type` is `'string' | 'list' | 'hash' | 'set' | 'zset'`. The value is a byte string, a `Quicklist`, a `Dict<string>`, a `Dict<true>`, or `{ dict: Dict<number>, zsl: Skiplist }`.
- `lru` holds the LRU clock (seconds, 24 bits) or, under an LFU policy, `(minutes << 8) | counter`.
- `savedEpoch` is the snapshot marker (section 9.8).
- Encodings are worked out when asked (OBJECT ENCODING), never stored.

**`Client`**: id, socket, address, name, `db` index, `resp` (2 or 3), `authenticated`, parser; flags `multi`, `dirtyCas` (a watched key changed), `dirtyExec` (a queueing error), `subscribed`, `blocked`, `monitor`, `replica`, `primaryLink`, `closeAfterReply`; queued commands; watched keys; channels and patterns; blocking state (keys, timer, BLMOVE target); output queue and its byte count; soft-limit start time; `createdAt`, `lastInteraction`, `lastCommand`; `woff` (replication offset after its last write, for WAIT); replica fields (state, listening port, ack offset, ack time).

**Replication state**: `role`, `replid`, `replid2`, `secondReplidOffset`, `masterReplOffset`, `backlog`, the replicas (on a primary); `primaryHost`, `primaryPort`, link and handshake state, `processedOffset` (on a replica).

### 6.2 On disk

Every file lives in `dir`.

| File | Format | Written by |
|---|---|---|
| `dump.mrdb` | Binary snapshot (section 11.2) | SAVE, BGSAVE, save points, SHUTDOWN, DEBUG RELOAD |
| `appendonly.aof` | RESP commands (section 11.1) | Every write while `appendonly yes`; replaced by rewrites |
| `temp-<pid>-<n>.mrdb`, `temp-rewrite-<pid>.aof` | Same formats, unfinished | Jobs in progress; leftovers are deleted at startup |

---

## 7. Conventions

### 7.1 Byte strings *(ADR)*
- The parser turns bulk strings into byte strings with `buf.toString('latin1', start, end)`: every byte becomes one character.
- Lengths (STRLEN, APPEND, GETRANGE) count bytes, which is `s.length`.
- Comparisons (sorted-set members, lex ranges) use plain `<`, which compares bytes for byte strings.
- Hashing and sampling work on the byte string directly.
- A test round-trips every byte value 0–255, and invalid UTF-8 such as `\xff\xfe`, through SET/GET, the AOF and a snapshot.

### 7.2 Numbers
- **Integers** follow Redis's strict rules: optional `-`, digits, no `+`, no spaces, no leading zeros except `0` itself (so `-0` and `007` are invalid), within signed 64 bits. Anything else → `ERR value is not an integer or out of range`.
- **INCR, DECR, INCRBY, DECRBY and HINCRBY** do their math in `BigInt`, so values up to `9223372036854775807` work exactly. *(ADR)*
- **Indexes and counts** (LRANGE, GETRANGE, LIMIT, COUNT) accept any int64, then are clamped to a safe JS number before use.
- **Floats** accept what Redis accepts: decimals, exponents, and `inf`, `+inf`, `-inf` in any case. `nan` and empty strings → `ERR value is not a valid float`.
- **Float output** is the shortest string that round-trips (`String(n)`), with `inf` and `-inf` for infinities. Check it against the reference and record any difference.
- **INCRBYFLOAT and HINCRBYFLOAT**: Redis computes in 80-bit long doubles; we have 64-bit doubles, so the last digits can differ (`0.1 + 0.2`). Print results without exponent notation. The differential test sticks to multiples of 0.25, which are exact in both. *(ADR)*

### 7.3 Replies

Handlers reply through `ctx.reply`, which writes RESP2 or RESP3 depending on the client:

| Builder | RESP2 | RESP3 |
|---|---|---|
| `ok()`, `simple(s)` | `+OK` | same |
| `error(msg)` | `-ERR …` (or the code at the start of `msg`) | same |
| `integer(n)` (number or bigint) | `:n` | same |
| `bulk(s)` | `$len` + bytes | same |
| `nullBulk()` | `$-1` | `_` |
| `array(items)` | `*n` | same |
| `nullArray()` | `*-1` | `_` |
| `map(pairs)` | flat array of 2n items | `%n` |
| `set(items)` | array | `~n` |
| `double(x)` | bulk string | `,x` |
| `bool(b)` | `:1` / `:0` | `#t` / `#f` |
| `verbatim(s)` (INFO, CLIENT LIST) | bulk string | `=len` + `txt:` + text |
| `push(items)` (pub/sub messages) | array | `>n` |

Where Redis replies with a map or a set in RESP3 (HGETALL, CONFIG GET, HELLO, SMEMBERS, SINTER…), use that builder. WITHSCORES replies are a flat array in RESP2 and an array of `[member, score]` pairs in RESP3.

### 7.4 Errors and limits

Handlers throw `ReplyError`; the dispatcher turns it into an error reply. These are the expected strings for Redis 7.4. When in doubt, ask the reference server; it wins.

| Situation | Reply |
|---|---|
| Unknown command | `-ERR unknown command 'foo', with args beginning with: 'a' 'b' ` (each arg quoted; note the trailing space) |
| Wrong argument count | `-ERR wrong number of arguments for 'get' command` (lowercase; `'config\|get'` for subcommands) |
| Unknown subcommand | `-ERR unknown subcommand 'foo'. Try CONFIG HELP.` |
| Bad syntax or clashing options | `-ERR syntax error` |
| Not an integer | `-ERR value is not an integer or out of range` |
| Not a float | `-ERR value is not a valid float` |
| Integer overflow | `-ERR increment or decrement would overflow` |
| Float result is NaN or infinite | `-ERR increment would produce NaN or Infinity` |
| Wrong type | `-WRONGTYPE Operation against a key holding the wrong kind of value` |
| Bad TTL | `-ERR invalid expire time in 'set' command` (with the command's name) |
| RENAME or LSET on a missing key | `-ERR no such key` |
| LSET out of range | `-ERR index out of range` |
| SELECT out of range | `-ERR DB index is out of range` |
| Bad score range | `-ERR min or max is not a float` |
| Bad lex range | `-ERR min or max not valid string range item` |
| Nested MULTI | `-ERR MULTI calls can not be nested` |
| EXEC or DISCARD without MULTI | `-ERR EXEC without MULTI` / `-ERR DISCARD without MULTI` |
| WATCH inside MULTI | `-ERR WATCH inside MULTI is not allowed` |
| Aborted transaction | `-EXECABORT Transaction discarded because of previous errors.` |
| RESP2 subscriber mode | `-ERR Can't execute 'get': only (P\|S)SUBSCRIBE / (P\|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context` |
| Not authenticated | `-NOAUTH Authentication required.` |
| Wrong password | `-WRONGPASS invalid username-password pair or user is disabled.` |
| AUTH with no password set | `-ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?` |
| Write on a replica | `-READONLY You can't write against a read only replica.` |
| Over the memory limit | `-OOM command not allowed when used memory > 'maxmemory'.` |
| AOF write failing | `-MISCONF Errors writing to the AOF file: <reason>` |
| Unsupported HELLO version | `-NOPROTO unsupported protocol version` |
| Too many clients | `-ERR max number of clients reached` |
| BGSAVE while a job runs | `-ERR Background save already in progress` |

**Protocol errors** (the reply is sent, then the connection closes): `-ERR Protocol error: invalid multibulk length`, `invalid bulk length`, `expected '$', got 'x'`, `unbalanced quotes in request`, `too big inline request`, `unauthenticated multibulk length`, `unauthenticated bulk length`.

**Limits:** arrays of at most 1,048,576 items (10 before AUTH); bulks of at most `proto-max-bulk-len` (16 KB before AUTH); inline lines and header lines of at most 64 KB; unparsed input of at most `client-query-buffer-limit` (past it, the client is closed without a reply and a warning is logged).

### 7.5 Time
- Read the clock once per command into `server.cmdTime` (once per EXEC for the whole transaction), so a key can't expire halfway through a command.
- TTLs are absolute Unix milliseconds (`Date.now()`).
- Durations (SLOWLOG, INFO) use `process.hrtime.bigint()`.
- The LRU clock is `Math.floor(Date.now() / 1000) & 0xFFFFFF`, refreshed by serverCron.

### 7.6 Names on the wire

In code and docs, say primary and replica. On the wire, keep Redis's words where Redis uses them: `role:master` / `role:slave` in INFO, `master` / `slave` in ROLE, REPLICAOF plus its SLAVEOF alias, `CLIENT KILL TYPE replica` (and `slave`). Report `redis_version:7.4.0` in INFO and HELLO so client libraries enable the right features (Valkey, a Redis fork, does the same), plus our own `miniredis_version`.

### 7.7 IDs
- `run_id` and replication IDs: 40 random hex characters (`crypto.randomBytes(20)`).
- Client IDs count up from 1; SLOWLOG IDs count up from 0.

### 7.8 Logging

Redis's format: `<pid>:<role> <dd Mon yyyy HH:MM:SS.mmm> <level> <message>`, with role `M` (primary) or `S` (replica) and level `.` debug, `-` verbose, `*` notice, `#` warning. Example: `4120:M 12 Nov 2026 01:05:00.123 * Ready to accept connections tcp`. Never log values, passwords or whole commands at notice level or above.

### 7.9 Command table and handlers

```ts
interface CommandSpec {
  name: string;                 // lowercase: 'zadd', or 'config|get' for a subcommand
  arity: number;                // like Redis: 3 = exactly 3 words incl. the name; -3 = at least 3
  flags: CommandFlag[];         // 'write' | 'readonly' | 'denyoom' | 'admin' | 'pubsub'
                                // | 'blocking' | 'noauth' | 'nomulti' | 'stale'
  firstKey: number; lastKey: number; step: number;  // key positions, for COMMAND INFO
  handler: (ctx: CommandContext) => void;           // synchronous, always
  subcommands?: Record<string, CommandSpec>;
}
```

`CommandContext` gives a handler `server`, `client`, `db`, `argv` (byte strings), `reply`, and three propagation helpers: `rewritePropagation(argv)`, `alsoPropagate(argv)` and `preventPropagation()` (section 9.5). COMMAND INFO builds Redis 7's 10-item entries from these specs.

---

## 8. Command reference

Flags: **w** write, **r** read-only, **m** may use memory (`denyoom`), **a** admin, **p** pub/sub, **b** blocking, **n** allowed before AUTH. Arity follows Redis: `2` = exactly two words including the name, `-3` = at least three. **†** = left for me to write by hand after the build days (section 21); don't build these.

### 8.1 Strings
| Command | Arity | Flags | Notes |
|---|---|---|---|
| GET | 2 | r | |
| SET | -3 | w m | `NX`/`XX`, `GET`, `EX`/`PX`/`EXAT`/`PXAT`/`KEEPTTL`; clashing options → syntax error; TTL ≤ 0 → invalid expire time; a plain SET drops the old TTL |
| SETNX † | 3 | w m | |
| SETEX † | 4 | w m | propagate as `SET … PXAT` |
| PSETEX † | 4 | w m | propagate as `SET … PXAT` |
| GETSET † | 3 | w m | |
| GETDEL | 2 | w | |
| GETEX | -2 | w | `EX`/`PX`/`EXAT`/`PXAT`/`PERSIST` |
| MGET | -2 | r | missing or non-string keys → nil, never WRONGTYPE |
| MSET | -3 | w m | an odd number of arguments → wrong-arguments error |
| MSETNX † | -3 | w m | |
| APPEND | 3 | w m | |
| STRLEN | 2 | r | |
| INCR, DECR | 2 | w m | BigInt; the stored value must be a strict integer |
| INCRBY, DECRBY | 3 | w m | |
| INCRBYFLOAT | 3 | w m | propagate as `SET key <result> KEEPTTL` |
| GETRANGE | 4 | r | negative indexes count from the end |
| SETRANGE | 4 | w m | pads with zero bytes; offset < 0 → `ERR offset is out of range`; too long → `ERR string exceeds maximum allowed size (proto-max-bulk-len)` |

### 8.2 Keys, expiry and databases
| Command | Arity | Flags | Notes |
|---|---|---|---|
| DEL, UNLINK | -2 | w | UNLINK behaves like DEL here |
| EXISTS | -2 | r | counts repeats: `EXISTS a a` → 2 |
| TYPE | 2 | r | `string`, `list`, `set`, `zset`, `hash` or `none` |
| KEYS | 2 | r | full scan by design; skips expired keys |
| SCAN | -2 | r | `MATCH`, `COUNT` (default 10), `TYPE`; cursor in section 10.2 |
| RENAME | 3 | w | keeps the TTL; renaming a key to itself → OK |
| RENAMENX † | 3 | w | |
| EXPIRE, PEXPIRE | -3 | w | `NX`/`XX`/`GT`/`LT`; a deadline in the past deletes the key |
| EXPIREAT, PEXPIREAT | -3 | w | same options |
| TTL, PTTL | 2 | r | -2 no key, -1 no TTL |
| PERSIST | 2 | w | |
| EXPIRETIME, PEXPIRETIME † | 2 | r | |
| RANDOMKEY | 1 | r | picks again if it lands on an expired key |
| TOUCH † | -2 | r | |
| DBSIZE | 1 | r | |
| FLUSHDB, FLUSHALL | -1 | w | `ASYNC`/`SYNC` accepted, both run now; abort a running snapshot job |
| SELECT | 2 | | 0–15 |

### 8.3 Lists
| Command | Arity | Flags | Notes |
|---|---|---|---|
| LPUSH, RPUSH | -3 | w m | |
| LPUSHX, RPUSHX † | -3 | w m | |
| LPOP, RPOP | -2 | w | optional count; a negative count → `ERR value is out of range, must be positive` |
| LLEN | 2 | r | |
| LRANGE | 4 | r | |
| LINDEX | 3 | r | |
| LSET | 4 | w m | |
| LINSERT | 5 | w m | `BEFORE`/`AFTER`; pivot missing → -1; key missing → 0 |
| LREM | 4 | w | count > 0 from the head, < 0 from the tail, 0 all |
| LTRIM | 4 | w | |
| LPOS † | -3 | r | |
| LMOVE | 5 | w m | `LEFT`/`RIGHT` twice; the same key rotates |
| RPOPLPUSH † | 3 | w m | |
| BLPOP, BRPOP | -3 | w b | timeout in seconds, may be fractional; 0 = forever |
| BLMOVE | 6 | w m b | |

### 8.4 Hashes
| Command | Arity | Flags | Notes |
|---|---|---|---|
| HSET | -4 | w m | field/value pairs; returns how many fields were new |
| HSETNX † | 4 | w m | |
| HGET | 3 | r | |
| HMGET | -3 | r | |
| HMSET † | -4 | w m | |
| HDEL | -3 | w | |
| HEXISTS | 3 | r | |
| HLEN | 2 | r | |
| HKEYS, HVALS | 2 | r | |
| HGETALL | 2 | r | a map in RESP3 |
| HINCRBY | 4 | w m | `ERR hash value is not an integer` |
| HINCRBYFLOAT | 4 | w m | `ERR hash value is not a float`; propagate as `HSET` |
| HSTRLEN † | 3 | r | |
| HSCAN | -3 | r | `MATCH`, `COUNT` |
| HRANDFIELD † | -2 | r | |

### 8.5 Sets
| Command | Arity | Flags | Notes |
|---|---|---|---|
| SADD | -3 | w m | |
| SREM | -3 | w | |
| SISMEMBER | 3 | r | |
| SMISMEMBER † | -3 | r | |
| SMEMBERS | 2 | r | a set in RESP3 |
| SCARD | 2 | r | |
| SPOP | -2 | w | optional count; propagate as `SREM` (or `DEL` if the set empties) |
| SRANDMEMBER | -2 | r | a negative count may repeat members |
| SMOVE † | 4 | w | |
| SINTER, SUNION, SDIFF | -2 | r | |
| SINTERSTORE, SUNIONSTORE, SDIFFSTORE | -3 | w m | an empty result deletes the destination |
| SINTERCARD † | -3 | r | |
| SSCAN | -3 | r | `MATCH`, `COUNT` |

### 8.6 Sorted sets
| Command | Arity | Flags | Notes |
|---|---|---|---|
| ZADD | -4 | w m | `NX`/`XX`, `GT`/`LT`, `CH`, `INCR` (returns the new score, or nil when NX/XX stops it) |
| ZINCRBY | 4 | w m | NaN result → `ERR resulting score is not a number (NaN)` |
| ZSCORE | 3 | r | |
| ZMSCORE † | -3 | r | |
| ZCARD | 2 | r | |
| ZCOUNT | 4 | r | |
| ZLEXCOUNT † | 4 | r | |
| ZRANGE | -4 | r | `BYSCORE`/`BYLEX`, `REV`, `LIMIT offset count`, `WITHSCORES` |
| ZRANGEBYSCORE, ZREVRANGEBYSCORE | -4 | r | |
| ZRANGEBYLEX | -4 | r | |
| ZREVRANGEBYLEX † | -4 | r | |
| ZREVRANGE | -4 | r | |
| ZRANK, ZREVRANK | -3 | r | optional `WITHSCORE` |
| ZREM | -3 | w | |
| ZREMRANGEBYRANK, ZREMRANGEBYSCORE | 4 | w | |
| ZREMRANGEBYLEX † | 4 | w | |
| ZPOPMIN, ZPOPMAX | -2 | w | optional count |
| ZRANDMEMBER † | -2 | r | |
| ZSCAN | -3 | r | `MATCH`, `COUNT` |
| ZUNIONSTORE, ZINTERSTORE | -4 | w m | `WEIGHTS`, `AGGREGATE SUM\|MIN\|MAX`; plain sets count with score 1; a NaN sum becomes 0 |

Score ranges: `1.5`, `(1.5` (exclusive), `-inf`, `+inf`. Lex ranges: `[a` (inclusive), `(a` (exclusive), `-`, `+`.

### 8.7 Pub/sub
| Command | Arity | Flags | Notes |
|---|---|---|---|
| SUBSCRIBE, PSUBSCRIBE | -2 | p | |
| UNSUBSCRIBE, PUNSUBSCRIBE | -1 | p | no arguments = everything |
| PUBLISH | 3 | p | returns the number of receivers; propagated to replicas only |
| PUBSUB | -2 | p | `CHANNELS [pattern]`, `NUMSUB [channel …]`, `NUMPAT` |

### 8.8 Transactions
| Command | Arity | Flags | Notes |
|---|---|---|---|
| MULTI | 1 | | |
| EXEC | 1 | | |
| DISCARD | 1 | | |
| WATCH | -2 | | |
| UNWATCH | 1 | | |

### 8.9 Connection and server
| Command | Arity | Flags | Notes |
|---|---|---|---|
| PING | -1 | | in RESP2 subscriber mode replies `["pong", arg or ""]` |
| ECHO | 2 | | |
| QUIT | -1 | n | replies OK, then closes |
| HELLO | -1 | n | `HELLO [2\|3] [AUTH user pass] [SETNAME name]`; replies with server, version, proto, id, mode, role, modules |
| AUTH | -2 | n | `AUTH pass` or `AUTH default pass` |
| CLIENT | -2 | | `ID`, `SETNAME`, `GETNAME`, `SETINFO` (client libraries send it on connect), `LIST`, `INFO`, `KILL` (`ID`, `ADDR`, `TYPE`), `HELP` |
| COMMAND | -1 | | `COUNT`, `INFO`; `DOCS` replies with an error and `redis-cli` falls back to its built-in help, as it does with older servers |
| CONFIG | -2 | a | `GET pattern …`, `SET name value …`, `RESETSTAT`, `HELP` |
| INFO | -1 | | section 13.1; a verbatim string in RESP3 |
| TIME | 1 | | |
| LASTSAVE | 1 | | |
| SAVE | 1 | a | blocks the server by design |
| BGSAVE | -1 | a | |
| BGREWRITEAOF | 1 | a | scheduled if another snapshot job is running |
| SHUTDOWN | -1 | a | `SAVE` / `NOSAVE` |
| DEBUG | -2 | a | `DIGEST`, `DIGEST-VALUE`, `SLEEP`, `RELOAD`, `LOADAOF`, `SET-ACTIVE-EXPIRE`; needs `enable-debug-command yes` |
| SLOWLOG | -2 | a | `GET [n]`, `LEN`, `RESET` |
| MONITOR | 1 | a | |
| MEMORY | -2 | | `USAGE key` |
| OBJECT | -2 | | `ENCODING`, `FREQ`, `IDLETIME`, `REFCOUNT` (always 1) |

**DEBUG DIGEST** is our own: 40 hex characters, the XOR of the SHA-1 of every key's (db, key, type, value in canonical form, expiry), so key order doesn't matter; all zeros for an empty dataset. Unordered collections are sorted before hashing. It's only comparable between MiniRedis servers.

### 8.10 Replication
| Command | Arity | Flags | Notes |
|---|---|---|---|
| REPLICAOF, SLAVEOF | 3 | a | `host port` or `NO ONE` |
| ROLE | 1 | | |
| WAIT | 3 | | `numreplicas timeout-ms` |
| PSYNC | -3 | a | the primary side of section 9.13 |
| REPLCONF | -1 | a | `listening-port`, `capa`, `ACK`, `GETACK` |

---

## 9. Core flows

### 9.1 Command lifecycle
1. **Read.** On `data`, the client's parser takes the chunk (section 10.1). If unparsed input passes `client-query-buffer-limit`, close the client and log a warning.
2. **Next command.** While the client isn't blocked or closing, take the next complete command `{ argv, bytes }`.
3. **Dispatch** (`commands/dispatch.ts`), in this order:
   1. Look up `argv[0]` lowercased. Unknown → error (inside MULTI, also flag the transaction).
   2. Check the arity. Wrong → error (inside MULTI, also flag it).
   3. With `requirepass` set, an unauthenticated client may only run `noauth` commands → `-NOAUTH`.
   4. A RESP2 client with subscriptions may only run the subscriber commands (section 9.11).
   5. Inside MULTI, everything except EXEC, DISCARD, MULTI, WATCH and QUIT is queued with `+QUEUED` (section 9.10).
   6. On a replica, `write` commands from normal clients → `-READONLY`.
   7. With `maxmemory` set and a `denyoom` command: evict (section 9.4); still over → `-OOM`.
   8. Set `server.cmdTime = Date.now()`, start a timer, run the handler. A `ReplyError` becomes an error reply. Any other exception is logged with its stack and answered with `-ERR internal error`; the server keeps running, and the bug gets a test.
   9. Record the duration for SLOWLOG and stats; feed MONITOR clients (never admin commands; AUTH and HELLO arguments redacted).
   10. Propagate (section 9.5): flush the command's records to the AOF buffer and the replication stream.
   11. Serve blocked clients whose keys became ready (section 9.12).
4. **Schedule `beforeSleep`.** Any code that queues a reply or a propagation record (including timers and the cron) calls `scheduleBeforeSleep()`, which sets at most one `setImmediate` per loop turn. *(ADR)*
5. **`beforeSleep`**, once per turn, in this order: send `REPLCONF GETACK *` if a WAIT started this turn; write the AOF buffer with `fs.writeSync` (and `fs.fsyncSync` with `always`); send queued stream bytes to replicas; send every client's queued replies with `socket.cork()`, the writes, then `socket.uncork()`, so each client gets one `writev`; close clients marked close-after-reply; enforce output buffer limits.

**serverCron** runs every `1000 / hz` ms: refresh the LRU clock; active expiry (9.3); incremental rehashing (1 ms per db) and dict shrink checks; save points and auto AOF rewrite; the `everysec` fsync; idle timeouts and soft output limits; replication chores (ACKs, PINGs, timeouts, reconnects, keepalive newlines); ops-per-second sampling; a scheduled BGREWRITEAOF.

**Sockets:** call `setNoDelay(true)` and `setKeepAlive(true, tcp-keepalive × 1000)` on every connection.

### 9.2 Client states
| State | Entered by | What it may do | Left by |
|---|---|---|---|
| Normal | Connecting | Everything, subject to the checks in 9.1 | |
| Unauthenticated | Connecting while `requirepass` is set | `noauth` commands: AUTH, HELLO, QUIT | A correct AUTH, or HELLO with AUTH |
| In MULTI | MULTI | EXEC, DISCARD and QUIT run; MULTI and WATCH reply with errors; the rest are queued | EXEC, DISCARD |
| Subscribed (RESP2) | SUBSCRIBE, PSUBSCRIBE | (P)SUBSCRIBE, (P)UNSUBSCRIBE, PING, QUIT | Unsubscribing from everything |
| Blocked | BLPOP, BRPOP, BLMOVE or WAIT with nothing ready | Nothing; later input waits in its parser | Served, timed out, killed or disconnected |
| Monitor | MONITOR | Receives the command feed | Disconnecting |
| Replica (on a primary) | PSYNC | Sends REPLCONF; receives the stream; never gets replies | Disconnecting |
| Primary link (on a replica) | The handshake | Its commands are applied without replies, except `REPLCONF GETACK` | The link dropping |

### 9.3 Expiry
1. **Lazy.** Every lookup checks `expires`. A key is expired when `cmdTime > expireAt`. On a primary: delete it, count `expired_keys`, propagate `DEL key` (ahead of the command's own record), and carry on as if the key were missing. On a replica: carry on as if it were missing, but don't delete it.
2. **Active**, each serverCron tick on a primary, unless `DEBUG SET-ACTIVE-EXPIRE 0`: for each db with TTLs, sample 20 entries from `expires`, delete the expired ones as above, and sample again while more than 5 of the 20 (25%) were expired. Stop when the tick's budget is spent (25% of the tick: 25 ms at `hz 10`), and resume at the same db next tick. This is the classic algorithm from Redis's EXPIRE docs; Redis 6+ tunes it further with `active-expire-effort`.
3. A deadline in the past (a negative EXPIRE, a past EXPIREAT) deletes the key at once and propagates `DEL`.
4. GT and LT treat a key without a TTL as having an infinite one.
5. Replacing a value (plain SET, GETSET) drops its TTL; KEEPTTL keeps it; RENAME carries it over.

### 9.4 Eviction
Runs before every `denyoom` command while `maxmemory > 0` and `usedMemory > maxmemory`. Replicas ignore `maxmemory`.

| Policy | Candidates | Evicted first |
|---|---|---|
| `noeviction` | none | nothing; the command gets `-OOM` |
| `allkeys-lru`, `volatile-lru` | all keys / keys with a TTL | longest idle |
| `allkeys-lfu`, `volatile-lfu` | all keys / keys with a TTL | lowest LFU counter (after decay) |
| `allkeys-random`, `volatile-random` | all keys / keys with a TTL | a random one, no pool |
| `volatile-ttl` | keys with a TTL | soonest expiry |

1. For each db, sample `maxmemory-samples` keys from `dict` (allkeys) or `expires` (volatile) and score them: idle time for LRU, `255 − counter` for LFU, how soon the key expires for TTL.
2. Insert them into the eviction pool: 16 slots, sorted by score, keeping the best 16 seen so far across rounds.
3. Take the best entry. If its key still exists, delete it: propagate `DEL`, count `evicted_keys`, call `signalModifiedKey`. If it's gone, drop it and take the next.
4. Repeat until under the limit. If no candidate exists (say, a volatile policy with no TTLs), stop; the command gets `-OOM`.

**LRU:** every lookup except `peek` sets `obj.lru = server.lruClock`. Idle seconds = `(lruClock − obj.lru) mod 2^24`.

**LFU** (Redis's algorithm): on each access, first decay: `periods = (nowMinutes − ldt) mod 65536 / lfu-decay-time`, `counter = max(0, counter − periods)`. Then increment with probability `1 / ((counter − 5, floored at 0) × lfu-log-factor + 1)`, up to 255. Store `ldt = nowMinutes & 0xFFFF`. New keys start at 5. That's how 8 bits can tell a key read a million times from one read a thousand times.

### 9.5 Propagation
- A `write` command that changed data (`server.dirty` grew) is propagated as it arrived, unless its handler rewrote it with `rewritePropagation()`, added records with `alsoPropagate()`, or called `preventPropagation()`. A command that changed nothing propagates nothing.
- Records keep the order they were produced in: a lazy-expiry DEL found during a command comes before the command's own record, and a served blocking pop comes after the push that fed it.
- During EXEC, records are collected and wrapped in `MULTI` … `EXEC`.
- Each sink (the AOF, the replication stream) writes `SELECT n` when a record's db differs from the last db it wrote. Its first record after startup, a rewrite or a full sync always carries a SELECT.
- On a replica, commands from the primary reach its AOF through normal propagation, but its backlog is fed the raw bytes received from the primary, so its offsets match the primary's byte for byte.
- Loading the AOF at startup never propagates.

| Command or event | Propagated as | Why |
|---|---|---|
| `SET k v EX 10` (also SETEX, PSETEX) | `SET k v PXAT <absolute ms>` | A relative TTL would restart on replay |
| EXPIRE, PEXPIRE, EXPIREAT | `PEXPIREAT k <absolute ms>` | Same |
| A deadline already in the past | `DEL k` | The key is already gone |
| `GETEX k EX 10` / `GETEX k PERSIST` | `PEXPIREAT k <abs>` / `PERSIST k` | Same |
| INCRBYFLOAT | `SET k <result> KEEPTTL` | Float math could differ elsewhere |
| HINCRBYFLOAT | `HSET h f <result>` | Same |
| `SPOP s 2` | `SREM s m1 m2` (`DEL s` if it empties) | A random choice must not be made again |
| A served BLPOP / BRPOP / BLMOVE | `LPOP k` / `RPOP k` / `LMOVE src dst …` | The waiting isn't part of the change |
| Lazy or active expiry, eviction | `DEL k` | Replicas and the AOF never expire or evict on their own |
| EXEC with writes | `MULTI`, the writes, `EXEC` | Replay stays atomic |
| PUBLISH | `PUBLISH` to replicas only | The AOF stores data, not messages |
| DEL of a missing key, SET NX that lost, … | nothing | No change, no record |
| Heartbeat | `PING` every `repl-ping-replica-period`, replicas only | Lets replicas notice a dead link |

### 9.6 AOF
**Writing**
1. `propagate()` encodes each record as a RESP array and appends it to the AOF buffer, with SELECT when needed.
2. `beforeSleep` writes the whole buffer with `fs.writeSync`.
3. `always`: `fs.fsyncSync` right after, before any reply goes out. One fsync covers every command of the turn (group commit).
4. `everysec`: serverCron calls `fs.fsync(fd, cb)` (async, on libuv's thread pool, like Redis's background thread) when a second has passed since the last one and none is in flight.
5. `no`: never fsync; the OS flushes when it likes.
6. A failed write or fsync is logged with `#`. With `always`, log and exit, as Redis does: it can no longer keep its promise. Otherwise retry each turn and reject writes with `-MISCONF` until a write succeeds.

**Loading** (section 9.9 decides when)
1. Read the file in chunks through the same RESP parser.
2. Run each command on a fake client: no replies, no propagation, no auth, OOM or read-only checks; SELECT is honoured.
3. If the file ends mid-command, or inside a MULTI with no EXEC: with `aof-load-truncated yes`, truncate the file at the end of the last complete command (or before that MULTI), log a warning, and go on; otherwise refuse to start.
4. Anything else malformed (bad framing mid-file, an unknown command): refuse to start, print the byte offset, never guess.

### 9.7 AOF rewrite
1. Triggered by BGREWRITEAOF, by auto-rewrite (the AOF is more than `auto-aof-rewrite-percentage` above its base size and over `auto-aof-rewrite-min-size`), or by `CONFIG SET appendonly yes`.
2. Start a snapshot job (9.8) with a command sink writing `temp-rewrite-<pid>.aof`: for each key, the fewest commands that rebuild it (SET, RPUSH, HSET, SADD, ZADD, at most 64 items per command), then `PEXPIREAT` if it has a TTL.
3. Meanwhile, every new write still goes to the current AOF (durability doesn't pause) and also to the rewrite buffer. The rewrite buffer starts with no selected db, so its first record carries a SELECT.
4. When the job finishes, in one synchronous step: append the rewrite buffer to the temp file, fsync it, flush and close the old AOF, rename the temp file over it, fsync the directory, reopen it for appending, record its size as the new base size, clear the buffer. Closing before renaming also keeps Windows happy.
5. If the job fails or is aborted, delete the temp file; the old AOF is untouched.
6. One job at a time: a BGREWRITEAOF during another job is scheduled for when it ends and replies `+Background append only file rewriting scheduled`.

### 9.8 Snapshots and copy-on-write *(ADR)*

Node can't `fork()`, so MiniRedis can't get a free point-in-time copy from the OS the way Redis does. Instead, one engine walks the keyspace in small slices while clients keep writing, and saves a key's old value just before anything changes it.

**The hook.** Every `Db` method that changes or removes an existing key, or its TTL, calls this first:

```ts
function beforeChange(db: Db, key: string, obj: RObj): void {
  const job = server.snapshotJob;
  if (job && obj.savedEpoch !== job.epoch) {
    job.sink.write(db.id, key, obj, db.getExpire(key)); // the value as it was when the job started
    obj.savedEpoch = job.epoch;
  }
}
```

`Db.add` and `Db.setKey` stamp every object they insert with the running job's epoch, so keys born after the start are skipped.

**The walk.** For each db the job keeps a SCAN cursor (section 10.2). Each slice (`setImmediate`, at most 2 ms) writes every entry whose `savedEpoch` isn't the job's epoch, then stamps it. SCAN visits every key that exists for the whole job, and every other key was saved by the hook before it changed or disappeared. So each key is written exactly once, with its value from the moment the job started, while rehashing and resizing carry on.

**Lifecycle**
1. Start: `epoch = ++server.snapshotEpoch`; note `masterReplOffset` (for a full sync); open the sink.
2. Run slices until every db is walked. If a file sink has more than 8 MB waiting, skip work until it drains.
3. Finish: the sink writes its end (EOF and CRC for binary), then the job's own completion: rename for BGSAVE, swap for a rewrite, send for a full sync.
4. Abort (FLUSHDB, FLUSHALL, DEBUG RELOAD, SHUTDOWN, an I/O error): the sink deletes its temp output; replicas waiting on a full sync are disconnected and retry.
5. One job at a time: BGSAVE (or SAVE) during another job → `-ERR Background save already in progress`; BGREWRITEAOF → scheduled; a replica that needs a full sync waits for the next job.

| Sink | Used by | Output |
|---|---|---|
| Binary file | BGSAVE, save points | `temp-<pid>-<n>.mrdb`, renamed to `dump.mrdb` |
| Commands file | AOF rewrite | `temp-rewrite-<pid>.aof` |
| Binary memory | Replica full sync | Buffers, sent as `$<len>\r\n<bytes>` |

Records written by the hook arrive out of order, so a sink writes a SELECT whenever the db changes.

**SAVE** writes the same format synchronously, with no job. **DEBUG RELOAD** is SAVE, then loading the file into fresh databases and swapping them in.

**Save points:** serverCron starts a BGSAVE when, for any `seconds changes` pair, `dirty ≥ changes` and `now − lastSave ≥ seconds`. After a failed BGSAVE, wait 5 seconds before trying again. On success, subtract the `dirty` value the job started with and set `lastSave = now`.

**The honest cost:** the hook serialises a whole value at once, so changing a huge list during a BGSAVE costs one pause the size of that list, and memory grows with the values saved early, like Redis's copied pages.

### 9.9 Startup and recovery
1. Parse flags and the config file; create `dir`; delete leftover temp files.
2. If `appendonly yes` and the AOF exists: load it (9.6). If `appendonly yes`, there's no AOF but there is a snapshot: load the snapshot, then start a rewrite so the AOF holds the data. Otherwise, if a snapshot exists, load it. Otherwise start empty.
3. A snapshot is checked (magic, version, CRC-64) before it's trusted. A bad file stops startup with a clear error and its byte offset; MiniRedis never starts empty and later overwrites good data on disk.
4. A primary skips keys that are already expired while loading.
5. Open the listener, log `Ready to accept connections tcp`, start serverCron, and start the replica link if `replicaof` is set.

### 9.10 Transactions and WATCH
1. MULTI sets the flag and replies OK.
2. Inside MULTI, each command except EXEC, DISCARD, MULTI, WATCH and QUIT is checked (exists, arity, auth, not `nomulti`, not READONLY or OOM) and queued with `+QUEUED`. A failed check replies with its error and sets `dirtyExec`.
3. WATCH (outside MULTI) registers the client in `db.watched`. `signalModifiedKey` sets `dirtyCas` on every watcher of that key; FLUSHDB and FLUSHALL do it for watchers of keys that existed. A watched key that has expired by EXEC also counts as changed.
4. EXEC: `dirtyExec` → `-EXECABORT …`; `dirtyCas` → null array; otherwise run every queued command in order with one `cmdTime`, collecting the replies into one array. Errors inside are ordinary replies; nothing rolls back. Propagate `MULTI`, the records, `EXEC` if anything was written. Unwatch everything and clear the state.
5. Blocking commands inside a transaction don't block: an empty list gives null at once.
6. DISCARD drops the queue, unwatches and replies OK.

### 9.11 Pub/sub
1. SUBSCRIBE adds the client to a channel; PSUBSCRIBE to a glob pattern (`utils/glob.ts`). Each confirmation is `["subscribe", channel, count]`, where `count` is the client's total of channels plus patterns.
2. PUBLISH sends `["message", channel, payload]` to each subscriber and `["pmessage", pattern, channel, payload]` for every matching pattern of every client, then replies with the number of messages sent.
3. RESP2: a client with any subscription may only run (P)SUBSCRIBE, (P)UNSUBSCRIBE, PING and QUIT; PING replies `["pong", arg or ""]`. RESP3: messages are push frames and every command is allowed.
4. UNSUBSCRIBE with no arguments leaves every channel; with no subscriptions at all it replies `["unsubscribe", nil, 0]`.
5. PUBLISH is propagated to replicas, so their subscribers hear it too, but never to the AOF.
6. A subscriber that stops reading is cut off by the `pubsub` output limit.

### 9.12 Blocking commands
1. `BLPOP k1 k2 … timeout`: if any key has elements, pop from the first such key at once, exactly like LPOP, and propagate `LPOP key`.
2. Otherwise the client blocks: it joins `db.blockingKeys` for each key, gets a timer unless the timeout is 0 (one Node timer per client; Node keeps timers in a heap already *(ADR)*), and its remaining pipelined input waits in its parser.
3. A push to a key with waiters puts the key in `readyKeys` through `signalModifiedKey`. After the current command (or the whole EXEC), the dispatcher serves each ready key: while it has elements, pop for its waiting clients in arrival order. Each served client gets `[key, value]`, loses its timer and its other registrations, and its pop is propagated after the push that fed it. Then its buffered input runs.
4. Timeout: reply with a null array, unblock, run its buffered input.
5. Disconnect or CLIENT KILL: remove it from every list and clear its timer.
6. BLMOVE works the same way, pushing into its destination when served.

### 9.13 Replication

**Handshake**
| # | Replica sends | Primary replies |
|---|---|---|
| 1 | `PING` | `+PONG` |
| 2 | `AUTH <masterauth>` (only if set) | `+OK` |
| 3 | `REPLCONF listening-port <port>` | `+OK` |
| 4 | `REPLCONF capa psync2` | `+OK` |
| 5 | `PSYNC <replid> <processedOffset + 1>`, or `PSYNC ? -1` the first time | `+FULLRESYNC <replid> <offset>` or `+CONTINUE <replid>` |

**The backlog** is a ring buffer of `repl-backlog-size` bytes holding the newest part of the replication stream. It's created the first time a replica needs one and never freed *(ADR)*; its first byte has offset `masterReplOffset + 1`. Every propagated record goes into it once, and `masterReplOffset` grows by the record's byte length.

**Full sync**
1. When a snapshot job can start for this replica, the primary replies `+FULLRESYNC <replid> <masterReplOffset>` and starts the job with a memory sink. From that moment, every new stream byte is also queued for this replica. While it waits, the primary sends it a bare `\n` every second so the link doesn't time out; the replica ignores those.
2. When the job finishes, the primary sends `$<len>\r\n` and the snapshot bytes (no trailing CRLF), then the queued stream. The replica is now online.
3. The replica reads the `$<len>` line and exactly `len` raw bytes, checks the CRC, loads them into fresh databases and swaps them in, sets `processedOffset` to the offset from `+FULLRESYNC`, starts its own backlog there, and switches to streaming.

**Partial sync**
1. The primary accepts if the replid matches its `replid` (or its `replid2`, with the requested offset ≤ `secondReplidOffset`) and `backlogFirstByte ≤ requested ≤ masterReplOffset + 1`.
2. It replies `+CONTINUE <replid>` and sends the backlog from the requested offset to the end. The replica is online at once.
3. Otherwise it falls back to a full sync. INFO counts `sync_full`, `sync_partial_ok` and `sync_partial_err`.

**Steady state**
1. Each record goes once into the backlog and to every online replica.
2. The replica applies the primary's commands as a privileged client: no replies (except to `REPLCONF GETACK`), no READONLY, OOM or auth checks, no bulk size limit. After each complete command, `processedOffset += bytes`, and the same bytes go into its own backlog.
3. Every second the replica sends `REPLCONF ACK <processedOffset>`; the primary stores it with the time (`lag` in INFO).
4. No traffic for `repl-timeout` seconds drops the link. The replica retries every second, with PSYNC from its offset.

**WAIT**
1. `WAIT n timeout` replies at once if `n` replicas have acknowledged the client's `woff`. Otherwise the client blocks, and at the end of the turn the primary sends `REPLCONF GETACK *` to every replica.
2. Each ACK re-checks the waiting clients. Reply with the number of replicas that reached the offset once enough have, or when the timeout ends (0 = forever).

**Promotion**
1. `REPLICAOF NO ONE` on a replica: close the link, keep the data, move `replid` to `replid2` with `secondReplidOffset = processedOffset + 1`, pick a new `replid`, and become a primary.
2. The old primary's other replicas can now `PSYNC <old replid> <offset>` against it and get `+CONTINUE`, because the new primary's backlog holds the stream they shared.
3. `REPLICAOF host port` on a primary closes its replicas' connections; they reconnect and sync again.

Redis also has a diskless `$EOF:` variant of the payload; we only implement the length-prefixed form.

### 9.14 Shutdown
On SHUTDOWN, SIGTERM or SIGINT:
1. Stop accepting connections; abort any snapshot job (deleting its temp file).
2. With `appendonly yes`, flush and fsync the AOF.
3. Unless `NOSAVE`, if save points are configured or `SAVE` was given, run a synchronous SAVE. If it fails, stay up and reply `-ERR Errors trying to SHUTDOWN. Check logs.`
4. Flush pending replies, close every socket, log `MiniRedis is now ready to exit, bye bye...`, and exit with code 0.

---

## 10. Data structures

### 10.1 RESP parser
- Input is `Buffer` chunks from the socket. Keep a list of unread chunks and a read position; never concatenate everything on each chunk.
- If a command starts with `*`, read an array: `*<n>\r\n`, then n times `$<len>\r\n<len bytes>\r\n`. A count of 0 or less is skipped like an empty line, as Redis does. Anything else is an inline command: one line up to `\n` (a trailing `\r` dropped), split on spaces with Redis's quoting rules (double quotes allow `\n`, `\r`, `\t`, `\"`, `\\` and `\xHH`; single quotes are literal except `\'`). Empty lines are skipped.
- A bulk over 32 KB gets one `Buffer.allocUnsafe(len)`, filled as chunks arrive; smaller ones are sliced directly. Each becomes a byte string once, at the end.
- Header lines over 64 KB, non-digits in a length, a missing `\r\n` after a bulk, and every limit in section 7.4 are protocol errors.
- Output: `{ argv: string[], bytes: number }` per command, where `bytes` is exactly how many input bytes the command used. Replicas count offsets with it.

### 10.2 Dict
- Two tables, `t0` and `t1`: arrays of chained buckets, sizes powers of two from 4. `rehashIdx = -1` when not rehashing.
- Hash: MurmurHash3 (x86, 32-bit) over the byte string, seeded with a random 32-bit value at startup so nobody can craft keys that all collide. Redis uses SipHash with a random key for the same reason. *(ADR)*
- **Grow** when `used ≥ size` and not already rehashing: allocate `t1` at twice the size. **Shrink** when `size > 4` and `used < size / 10` (checked by serverCron and after deletes): allocate `t1` at the next power of two ≥ `used`, minimum 4.
- **Rehash step:** while rehashing, every get, set and delete first moves one bucket from `t0` to `t1`, skipping at most 10 empty buckets. serverCron also spends up to 1 ms per db per tick moving buckets 100 at a time. When `t0` is empty, `t1` becomes `t0`.
- While rehashing, lookups check `t0` then `t1`; inserts go to `t1`.
- `randomEntries(n)` starts at a random bucket and walks forward collecting entries until it has `n` or has visited `n × 10` buckets, like Redis's `dictGetSomeKeys`. `randomEntry()` retries random buckets until one is non-empty.
- A full walk (KEYS, SAVE) pauses rehashing and allows no changes meanwhile; tests assert that.

**SCAN cursor** (Redis's reverse-binary trick, with 32-bit cursors). Not rehashing:

```ts
const m0 = t0.length - 1;
visitBucket(t0, v & m0);
v |= ~m0; v = rev32(v); v = (v + 1) >>> 0; v = rev32(v);
```

While rehashing, with `small` and `big` the smaller and bigger table and `m0`, `m1` their masks:

```ts
visitBucket(small, v & m0);
do {
  visitBucket(big, v & m1);
  v |= ~m1; v = rev32(v); v = (v + 1) >>> 0; v = rev32(v);
} while (v & (m0 ^ m1));
```

`rev32` reverses all 32 bits and returns an unsigned number. Cursor 0 starts and ends a scan. A key present for the whole scan is returned at least once; a key can be returned twice. SCAN with `COUNT n` keeps stepping until it has `n` entries or has taken `n × 10` steps, then drops expired keys and applies `MATCH` and `TYPE`.

### 10.3 Skip list and zset
- Levels 1–32. A new node starts at level 1 and gains a level with probability 1/4, through `utils/random.ts`.
- A node has `member`, `score`, `backward`, and `levels[i] = { forward, span }`. The list has a 32-level header node, `tail`, `length` and `level`.
- Order: by score, then by member bytes.
- Operations: `insert`; `delete`; `updateScore` (moves the node in place when its order doesn't change, else delete + insert); `rank(score, member)`, 1-based, by summing spans along the search path; `byRank(rank)`; first and last node in a score range or a lex range; `deleteRangeByScore`, `ByRank` and `ByLex`, which return the deleted members so the zset's dict can drop them too.
- `check()`, used by tests: order, backward links, spans and length all agree.
- A zset is a `Dict` of member → score (O(1) ZSCORE) plus the skip list (order and ranks), always changed together.

### 10.4 Quicklist
- A doubly linked list of nodes, each holding a JS array of at most `list-max-node-items` items (default 128 *(ADR)*), with `length` and `nodeCount` kept up to date.
- Push and pop at either end touch only the end node; a full end node gets a new neighbour.
- LINDEX and LSET walk from the nearer end, skipping whole nodes by their counts.
- Inserting into a full node splits it in two. After deletes, a node merges with a neighbour when both fit in one node; empty nodes are removed.
- LRANGE and LTRIM walk node by node and never copy the whole list into one array first.

### 10.5 Memory estimates *(ADR)*
- Each data structure keeps a running byte estimate, updated in O(1) per change: item bytes plus a fixed overhead per item.
- Each key adds a fixed overhead plus its key bytes; a TTL adds another.
- `Db` remembers each key's last estimate; `signalModifiedKey` adds the difference to `server.usedMemory`, and delete subtracts the key's estimate.
- Measure the overhead constants with `bench/calibrate-memory.ts`: insert 1M items of each kind and divide the growth in `process.memoryUsage().heapUsed` by 1M.
- `used_memory` in INFO is this estimate; `used_memory_rss` is the process's real RSS.

---

## 11. File formats

### 11.1 AOF
Plain RESP arrays of bulk strings, exactly the propagated records:

```text
*2\r\n$6\r\nSELECT\r\n$1\r\n0\r\n
*3\r\n$3\r\nSET\r\n$6\r\nuser:1\r\n$5\r\nalice\r\n
*3\r\n$9\r\nPEXPIREAT\r\n$6\r\nuser:1\r\n$13\r\n1794500000000\r\n
```

- `SELECT` whenever the db changes; the first record of a file always carries one.
- Transactions appear as `MULTI` … `EXEC`.
- No checksum: the parser detects a cut-off tail (section 9.6).

### 11.2 Snapshot (`dump.mrdb`) *(ADR)*
All fixed-size integers are little-endian. A **varint** is unsigned LEB128 (7 bits per byte, low bits first, the high bit set on every byte but the last). A **string** is a varint byte length followed by the bytes.

| Part | Bytes |
|---|---|
| Magic | `MINIREDIS` (9 ASCII bytes) |
| Version | `0001` (4 ASCII digits) |
| Aux field (any number) | `0xFA`, string name, string value: `miniredis-ver`, `ctime` (Unix seconds), `used-mem` |
| Select db | `0xFE`, varint db number |
| Expiry for the next key | `0xFC`, 8-byte Unix milliseconds |
| Key and value | type byte, string key, value |
| End | `0xFF` |
| Checksum | 8-byte CRC-64 of every byte before it |

| Type byte | Value |
|---|---|
| `0` string | string |
| `1` list | varint count, then that many strings, head to tail |
| `2` set | varint count, then that many strings |
| `3` zset | varint count, then that many (string member, 8-byte IEEE-754 double score) |
| `4` hash | varint count, then that many (string field, string value) |

The opcodes and type numbers deliberately mirror Redis's RDB, but the file isn't RDB-compatible: RDB uses its own length encoding and compact types. The loader checks the magic and version, reads every record into fresh databases, verifies the checksum at the end, and swaps the new databases in only if everything checks out; any mismatch fails with its byte offset.

### 11.3 CRC-64
CRC-64 with the Jones polynomial, reflected, as in Redis's `crc64.c`. Make it table-driven with two `Uint32Array` tables (high and low halves), so the hot loop never touches `BigInt`. Test vector: `crc64("123456789") = 0xe9c6d914c4b8d9ca`.

---

## 12. Safety checklist

- [ ] Binds to `127.0.0.1` by default; Compose publishes ports on `127.0.0.1` only.
- [ ] `requirepass` compared in constant time: `crypto.timingSafeEqual` on SHA-256 digests, so the lengths always match.
- [ ] Before AUTH: only `noauth` commands, arrays of at most 10 items, bulks of at most 16 KB.
- [ ] The protocol limits in section 7.4, query and output buffer limits, `maxclients`.
- [ ] `dir` and `dbfilename` can't change at runtime. The classic attack on open Redis servers points `dir` at `~/.ssh` and saves a key file there.
- [ ] DEBUG is off unless `enable-debug-command yes`.
- [ ] MONITOR and the logs never show AUTH or HELLO passwords (`(redacted)`).
- [ ] The fuzzer runs in CI; no input crashes or hangs the server.
- [ ] The Docker image runs as a non-root user with only `/data` writable.
- [ ] No `eval`, `new Function` or dynamic `import` anywhere.

---

## 13. Observability

### 13.1 INFO
`INFO` (or `INFO all` / `everything`) returns every section below; `INFO <section>` one of them. The format is `# Server\r\nfield:value\r\n…`, with sections separated by a blank line. ioredis reads `loading:0` from INFO when it connects, so that field exists from step 5 on.

| Section | Fields |
|---|---|
| server | `redis_version` (7.4.0), `miniredis_version`, `redis_mode:standalone`, `os`, `arch_bits`, `process_id`, `run_id`, `tcp_port`, `uptime_in_seconds`, `uptime_in_days`, `hz`, `executable`, `config_file`, `node_version` |
| clients | `connected_clients`, `blocked_clients`, `maxclients` |
| memory | `used_memory`, `used_memory_human`, `used_memory_rss`, `used_memory_peak`, `maxmemory`, `maxmemory_human`, `maxmemory_policy` |
| persistence | `loading`, `rdb_changes_since_last_save`, `rdb_bgsave_in_progress`, `rdb_last_save_time`, `rdb_last_bgsave_status`, `aof_enabled`, `aof_rewrite_in_progress`, `aof_rewrite_scheduled`, `aof_last_bgrewrite_status`, `aof_last_write_status`, `aof_current_size`, `aof_base_size` |
| stats | `total_connections_received`, `total_commands_processed`, `instantaneous_ops_per_sec`, `rejected_connections`, `expired_keys`, `evicted_keys`, `keyspace_hits`, `keyspace_misses`, `pubsub_channels`, `pubsub_patterns`, `sync_full`, `sync_partial_ok`, `sync_partial_err` |
| replication | `role`, `connected_slaves`, `slaveN:ip=…,port=…,state=…,offset=…,lag=…`, `master_replid`, `master_replid2`, `master_repl_offset`, `second_repl_offset`, `repl_backlog_active`, `repl_backlog_size`, `repl_backlog_first_byte_offset`, `repl_backlog_histlen`; on a replica also `master_host`, `master_port`, `master_link_status`, `master_last_io_seconds_ago`, `master_sync_in_progress`, `slave_repl_offset`, `slave_read_only` |
| cpu | `used_cpu_sys`, `used_cpu_user` (from `process.cpuUsage()`) |
| keyspace | `db0:keys=…,expires=…,avg_ttl=…` for each non-empty db |

### 13.2 SLOWLOG
Entries are `[id, unix seconds, microseconds, [args…], "ip:port", client name]`. At most 32 args are kept (the last one says `... (N more arguments)`), each cut at 128 bytes with `... (N more bytes)`.

### 13.3 MONITOR
One line per command, as Redis prints it: `+1794500000.123456 [0 127.0.0.1:52555] "SET" "user:1" "alice"`, with arguments quoted and escaped. Admin commands are left out; AUTH and HELLO arguments show as `(redacted)`.

### 13.4 CLIENT LIST and CLIENT INFO
One line per client: `id=… addr=… laddr=… name=… age=… idle=… flags=… db=… sub=… psub=… multi=… qbuf=… omem=… cmd=… resp=…`.

### 13.5 `/metrics`
When `metrics-port` is set, `node:http` serves Prometheus text format:
- `miniredis_connected_clients`, `miniredis_blocked_clients`
- `miniredis_commands_processed_total`, `miniredis_command_calls_total{cmd="get"}`, `miniredis_command_duration_seconds_sum{cmd="get"}`
- `miniredis_keyspace_hits_total`, `miniredis_keyspace_misses_total`, `miniredis_expired_keys_total`, `miniredis_evicted_keys_total`
- `miniredis_used_memory_bytes`, `miniredis_keys{db="0"}`
- `miniredis_replication_offset`, `miniredis_connected_replicas`
- `miniredis_last_save_timestamp_seconds`, `miniredis_aof_last_write_ok`

### 13.6 Logs
The format is in section 7.8. At notice level, log: startup and readiness, what was loaded (keys and seconds), saves and rewrites, replicas connecting and dropping, full and partial syncs, clients cut off by limits, and shutdown.

---

## 14. Build steps

Each step: plan → tests → code → everything green → walkthrough → commit. Step 1 is by hand; the rest are Claude Code. Every step reads sections 0, 3, 4 and 7 plus its own "Read" list.

### Phase 0: Setup
- [ ] **1. Repo and tooling (by hand, the night before Day 1).** On Windows, work inside WSL2. Install Node 26, Docker, and the Redis command-line tools (`brew install redis` on macOS, `sudo apt install redis-tools` on Ubuntu/WSL; only `redis-cli` and `redis-benchmark` are used). `git init`; `npm init -y`; set `"type": "module"`, `"engines": { "node": ">=24" }` and the scripts below; dev-install `typescript tsx @types/node vitest @vitest/coverage-v8 fast-check ioredis eslint @eslint/js typescript-eslint prettier`; `tsconfig.json` (`strict`, target ES2023, module NodeNext, `noEmit`, covering `src`, `tests` and `bench`) and `tsconfig.build.json` (extends it, `src` only, emits to `dist/`); `eslint.config.js`; `.prettierrc`; `.gitignore` and `.dockerignore` (`node_modules`, `dist`, `data`, `coverage`); `vitest.config.ts` with projects `unit`, `property`, `integration`, `differential`, `crash`, `fuzz`, `replication`; a placeholder `src/index.ts`; this file as `docs/SPEC.md`; the plan doc exported to `docs/PLAN.md`; `CLAUDE.md` (below).
  *Done when:* `npm run typecheck` and `npm test` pass with no tests yet.
- [ ] **2. Docker and CI skeleton.** `Dockerfile`, `docker/healthcheck.js` and `docker-compose.yml` exactly as in section 16 (the image builds once step 5 exists); `.github/workflows/ci.yml` with install, lint, typecheck and unit tests (the rest of section 17 joins as suites appear).
  *Read:* 16, 17.
  *Done when:* `docker compose up -d redis` then `docker compose exec redis redis-cli ping` prints `PONG`, and CI is green on GitHub.

```json
"scripts": {
  "dev": "tsx watch src/index.ts",
  "build": "tsc -p tsconfig.build.json",
  "start": "node dist/index.js",
  "typecheck": "tsc --noEmit",
  "lint": "eslint . && prettier --check .",
  "format": "prettier --write .",
  "test": "vitest run --passWithNoTests --project unit --project property --project integration",
  "test:diff": "vitest run --project differential",
  "test:crash": "npm run build && vitest run --project crash",
  "test:fuzz": "vitest run --project fuzz",
  "test:repl": "vitest run --project replication",
  "test:all": "npm test && npm run test:diff && npm run test:crash && npm run test:fuzz && npm run test:repl",
  "bench": "bash bench/run.sh"
}
```

Test knobs are environment variables: `SEED` and `OPS` (differential), `KILLS` (crash), `CASES` (fuzz).

`CLAUDE.md`:

```markdown
# MiniRedis
The spec is docs/SPEC.md. Before every session, read its sections 0, 3, 4 and 7,
then the sections your step lists under "Read". Follow section 0 exactly.
docs/SPEC.md wins over every other file, including docs/PLAN.md.
```

### Phase 1: RESP, the dict and the server
- [ ] **3. RESP parser and encoder.** `protocol/parser.ts` (section 10.1), `protocol/encoder.ts` (section 7.3), `protocol/errors.ts` (section 7.4). Pure modules.
  *Read:* 10.1, 15.1.
  *Done when:* encoder tests cover every builder in RESP2 and RESP3; a 1,000-command pipeline fed one byte at a time parses exactly like the same bytes in one chunk, with the right `bytes` for each command; a 64 MB bulk sent in 1 KB chunks parses in under 2 seconds; every protocol error in section 7.4 has an input that produces it.
- [ ] **4. Dict.** `datastructures/dict.ts` (section 10.2), `utils/hash.ts`, `utils/random.ts`.
  *Read:* 10.2, 15.4.
  *Done when:* growth from 0 to 1M keys and back down never moves more than one bucket per operation; the dict matches a JS `Map` under random operation sequences; SCAN returns every key that existed throughout, even with inserts, deletes, growth and shrinking in between; `randomEntries` only returns live entries.
- [ ] **5. Server, clients and dispatcher.** `config.ts` (section 5: file, flags, units, CONFIG GET/SET machinery), `server.ts`, `client.ts`, `event-loop.ts`, a `cron.ts` skeleton, `propagate.ts` (records and sinks; none attached yet, tests attach a recording sink), `registry.ts`, `dispatch.ts` (section 9.1), `logger.ts`, a first `Db` and `RObj`. Commands: PING, ECHO, QUIT, SELECT, GET, SET (no options yet), DEL, COMMAND, CONFIG, CLIENT (ID, SETNAME, GETNAME, SETINFO), TIME, and a minimal INFO (`redis_version`, `miniredis_version`, `run_id`, `tcp_port`, `uptime_in_seconds`, `loading:0`). Graceful close on SIGTERM. `tests/helpers/` starts a server on port 0 with a temp `dir`.
  *Read:* 5, 6.1, 8.9, 9.1, 9.2, 13.1.
  *Done when:* `redis-cli -p 6380 set a 1` then `get a` print `OK` and `"1"`; `redis-benchmark -p 6380 -t ping_inline,ping_mbulk,set,get -n 100000 -P 16 -q` finishes with no errors; an ioredis test connects, runs SET/GET and a 100-command pipeline, and gets its replies in order.

### Phase 2: Keyspace, strings, expiry and the referee
- [ ] **6. Strings and keys.** The full `Db` (section 6.1; the WATCH and snapshot hooks are no-ops for now), `utils/numbers.ts`, `utils/glob.ts`, every non-† command in sections 8.1 and 8.2 except the TTL ones, plus SCAN with `MATCH`, `COUNT` and `TYPE`.
  *Read:* 6.1, 8.1, 8.2, 10.2.
  *Done when:* number tests cover int64 edges and the strict rules (`-0`, `007`, `+1` and `" 1"` rejected); `SET k 9223372036854775806`, INCR, then INCR again overflows; glob tests cover classes, ranges, escapes, and a pathological pattern (`*a*a*a*a*a*a*b` against 10,000 `a`s) that finishes in under 50 ms; integration tests cover every command's happy path and its errors; all 256 byte values round-trip through SET/GET.
- [ ] **7. Expiry.** `expires` and TTLs in `Db`, lazy expiry in every lookup, the active cycle (section 9.3), the TTL commands in section 8.2 with `NX`/`XX`/`GT`/`LT`, the TTL options of SET and GETEX, absolute-time propagation (section 9.5), and DEBUG `DIGEST`, `DIGEST-VALUE`, `SLEEP` and `SET-ACTIVE-EXPIRE` (the digest grows as types are added).
  *Read:* 8.1, 8.2, 8.9, 9.3, 9.5.
  *Done when:* 100,000 keys with a 1-second TTL are gone within 3 seconds without being read; with active expiry off, GET on an expired key returns nil and DBSIZE drops by one; the recording sink shows `EXPIRE k 10` as `PEXPIREAT k <absolute ms>`, `SET k v EX 10` as `SET k v PXAT <absolute ms>`, and a lazily expired key as `DEL k` ahead of the command that found it.
- [ ] **8. Differential harness.** `tests/differential/` (section 15.3) against the Redis container; added to CI with a Redis service.
  *Read:* 15.3.
  *Done when:* `OPS=10000 npm run test:diff` reports zero diffs for strings and keys, and rerunning with the printed `SEED` replays the run exactly.

### Phase 3: Data types
- [ ] **9. Lists.** `datastructures/quicklist.ts` (section 10.4) and every non-†, non-blocking command in section 8.3 (BLPOP and friends are step 18). DEBUG DIGEST and the generator cover lists.
  *Read:* 8.3, 10.4.
  *Done when:* quicklist property tests against a plain array pass (push and pop at both ends, insert, remove, trim, index, with splits and merges); differential runs with lists show zero diffs.
- [ ] **10. Hashes and sets.** Every non-† command in sections 8.4 and 8.5, on `Dict`; the HINCRBYFLOAT and SPOP propagation rewrites; empty collections delete their key.
  *Read:* 8.4, 8.5, 9.5.
  *Done when:* differential runs with hashes and sets show zero diffs; the recording sink shows `SPOP s 2` as `SREM s <m1> <m2>`.
- [ ] **11. Sorted sets.** `skiplist.ts` and `zset.ts` (section 10.3) and every non-† command in section 8.6.
  *Read:* 8.6, 10.3.
  *Done when:* `check()` passes after 100,000 random inserts, deletes and score updates; a benchmark shows ZRANK time growing roughly with log n from 10,000 to 1,000,000 members; differential runs with sorted sets show zero diffs.

### Phase 4: Persistence (built on Day 3, after phase 5)
- [ ] **12. AOF.** The AOF sink, `beforeSleep` writes and the fsync policies, loading at startup with truncated-tail handling, `-MISCONF`, DEBUG LOADAOF.
  *Read:* 9.5, 9.6, 9.9, 11.1.
  *Done when:* after a random mix of commands (every type, TTLs, transactions, served BLPOPs), `DEBUG LOADAOF` leaves DEBUG DIGEST unchanged; after `EXPIRE k 100`, a 2-second wait and DEBUG LOADAOF, TTL is at most 98; an AOF cut off mid-command loads with a warning and is truncated; garbage mid-file stops startup with its byte offset; with `appendfsync always`, a spy on `fsyncSync` sees the fsync before the reply is written.
- [ ] **13. Snapshots: the copy-on-write engine, SAVE and BGSAVE.** `snapshot-job.ts`, `snapshot-format.ts`, `crc64.ts`, `files.ts`; SAVE, BGSAVE, LASTSAVE, save points, DEBUG RELOAD, startup order.
  *Read:* 9.8, 9.9, 11.2, 11.3.
  *Done when:* the CRC-64 test vector passes; DEBUG RELOAD leaves DEBUG DIGEST unchanged for every type, with TTLs and binary data; 100 BGSAVEs taken while 50 clients run the transfer transaction (section 15.5) all load with `A + B` unchanged; during a BGSAVE of 1M keys no PING takes over 50 ms (record the real maximum); one flipped byte makes loading fail with its offset.
- [ ] **14. AOF rewrite.** BGREWRITEAOF on the engine with a command sink, the rewrite buffer and the swap, auto-rewrite, and `CONFIG SET appendonly yes|no` at runtime.
  *Read:* 9.7, 11.1.
  *Done when:* after 100,000 INCRs on one key, a rewrite leaves an AOF of a few commands and a restart keeps the value; rewrites taken under the transfer load keep `A + B` unchanged after a restart; turning the AOF on at runtime produces a file that restores the whole dataset.
- [ ] **15. Crash tests.** `tests/crash/` (section 15.5), against the built server in child processes.
  *Read:* 15.5.
  *Done when:* `KILLS=50 npm run test:crash` passes for all three fsync modes, snapshot-only mode, and kills during BGSAVE and during an AOF rewrite.

### Phase 5: Transactions, pub/sub and blocking (built on Day 2, before phase 4)
Everything here goes through `propagate()` from step 5, so persistence and replication pick it up automatically when they arrive, and their tests must include transactions and served blocking pops.

- [ ] **16. Transactions.** MULTI, EXEC, DISCARD, WATCH and UNWATCH (section 9.10), with WATCH touched by every change path, including expiry, flushes and eviction; EXEC propagates as `MULTI` … `EXEC`.
  *Read:* 8.8, 9.10.
  *Done when:* EXEC returns null when another client changes, expires or flushes a watched key; queue-time errors give EXECABORT and run-time errors don't roll back, both matching Redis in the differential test; 50 clients running the transfer transaction keep `A + B` constant.
- [ ] **17. Pub/sub.** `pubsub/hub.ts` and the commands in section 8.7: RESP2 subscriber mode, RESP3 push messages, PUBLISH propagated to replicas only.
  *Read:* 8.7, 9.11.
  *Done when:* two `redis-cli` terminals exchange messages through SUBSCRIBE and PSUBSCRIBE; PUBLISH counts receivers correctly with overlapping patterns; an ioredis subscriber test passes; a subscribed RESP2 client gets the subscriber-mode error for GET and `["pong", ""]` for PING.
- [ ] **18. Blocking commands.** `blocking/waiters.ts`, BLPOP, BRPOP and BLMOVE (section 9.12).
  *Read:* 8.3, 9.12.
  *Done when:* BLPOP returns within 10 ms of another client's push; three waiters on one key are served in arrival order; a 0.1-second timeout returns a null array after about 0.1 seconds; the recording sink shows the push before the pop; a blocked client's pipelined commands run only after it unblocks; inside MULTI, BLPOP on an empty list returns null at once.

### Phase 6: Memory and eviction
- [ ] **19. Memory accounting and eviction.** Per-structure byte counters, `usedMemory`, `bench/calibrate-memory.ts`, `maxmemory` with all 8 policies, the LRU clock, the LFU counter, the eviction pool, OBJECT and MEMORY USAGE, replicas ignoring `maxmemory`.
  *Read:* 9.4, 10.5.
  *Done when:* with `maxmemory 50mb` and `allkeys-lru`, writing 200 MB of keys keeps `used_memory` within 50 MB plus one command's size; with `noeviction`, SET gets `-OOM` while DEL and GET still work; in a hot-set test (10% of keys get 90% of reads), `allkeys-lru` and `allkeys-lfu` beat `allkeys-random`'s hit rate by at least 20 points; the LFU increment and decay math has unit tests.

### Phase 7: Replication
- [ ] **20. Primary side.** Replication ID and offset, the backlog, the replication sink with SELECT tracking, PSYNC (full sync through the engine's memory sink, partial sync from the backlog), replica states and output limits, REPLCONF, heartbeat PINGs and keepalive newlines, WAIT, ROLE, INFO replication, CLIENT KILL.
  *Read:* 8.10, 9.13.
  *Done when:* a raw-socket fake replica gets `+FULLRESYNC`, a snapshot payload with a valid checksum, then the live stream; reconnecting with its offset gets `+CONTINUE` and exactly the bytes it missed; an offset outside the backlog gets a full sync; WAIT returns the number of fake replicas that acknowledged the client's offset.
- [ ] **21. Replica side.** REPLICAOF host port and NO ONE, the handshake state machine, loading the snapshot, applying the stream with byte-exact offsets, the replica's own backlog, ACKs every second, reconnecting with PSYNC, read-only mode, hiding expired keys, promotion; the Compose `replication` profile.
  *Read:* 9.13, 15.7.
  *Done when:* every test in section 15.7 passes, and `docker compose --profile replication up` shows two replicas with `master_link_status:up`.

### Phase 8: Hardening and observability
- [ ] **22. RESP3, auth and limits.** HELLO and AUTH, RESP3 reply types for every command (section 7.3), the unauthenticated limits, `maxclients`, the idle timeout, query and output buffer limits per client class, and the fuzzer (section 15.6).
  *Read:* 7.3, 7.4, 12, 15.6.
  *Done when:* `redis-cli -3 -p 6380` shows HGETALL as a map, SMEMBERS as a set and ZSCORE as a double; `CASES=1000000 npm run test:fuzz` passes; a subscriber that never reads is disconnected while server memory stays flat; an unauthenticated client can't send a 1 MB bulk; with `maxclients 10`, the 11th client gets `-ERR max number of clients reached`.
- [ ] **23. Observability and shutdown.** Full INFO, SLOWLOG, MONITOR, CLIENT LIST and INFO, `/metrics`, Redis-style logs, SHUTDOWN and SIGTERM.
  *Read:* 9.14, 13.
  *Done when:* `DEBUG SLEEP 0.02` appears in SLOWLOG; MONITOR shows another client's commands with AUTH redacted and admin commands left out; `curl localhost:<metrics-port>/metrics` lists the metrics in section 13.5; SIGTERM with save points configured writes a snapshot that loads.

### Phase 9: Proof and polish
- [ ] **24. Benchmarks and one optimisation.** `bench/run.sh`, `bench/memory.ts` and `bench/RESULTS.md` (section 18); profile, fix the top hotspot, publish before/after. This step can move to Day 11 and be done by hand.
  *Read:* 18.
  *Done when:* `RESULTS.md` has the machine, the versions, the exact commands, the comparison tables and one before/after optimisation.
- [ ] **25. Docs and the study kit.** The README (section 22); `docs/ARCHITECTURE.md` with Mermaid diagrams (architecture, command lifecycle, replication handshake); `docs/DIFFERENCES.md` (section 19); an ADR for every choice tagged *(ADR)* in this file (most already exist from their steps); `docs/INTERVIEW.md`, answering every question in section 23 with `file:line` references into this code; `docs/EXERCISES.md`, turning section 21's break-it table and the † commands into exercises with hints.
  *Read:* 19, 21, 22, 23.
  *Done when:* someone could run, test and benchmark the project from the README alone, and every question in section 23 has an answer that points at real code.

---

## 15. Tests

### 15.1 Unit (Vitest)
- Parser: every type and limit, byte-at-a-time equivalence, `bytes` per command, inline quoting, every protocol error.
- Encoder: every builder in RESP2 and RESP3.
- Numbers: strict int64 parsing, BigInt edges, float parsing (`inf`, `-inf`, exponents; `nan` rejected) and formatting.
- Glob: Redis's pattern syntax and the pathological pattern.
- Dict: growth, shrinking, one bucket per step, live-only sampling.
- Skip list: order, ranks, score and lex ranges, `check()` after random operations. Quicklist: splits, merges, index from both ends.
- CRC-64 test vector; snapshot round trip for every type; backlog offsets across wrap-around; LFU increment and decay.

### 15.2 Integration
Against a server started in-process on port 0 with a temp `dir`, through ioredis or the raw RESP client in `tests/helpers/`:
- Every command group: happy paths and the documented errors.
- A 1,000-command pipeline keeps reply order.
- Transactions and WATCH with two clients; pub/sub with patterns; blocking with several clients.
- RESP3 through `HELLO 3` on the raw client.
- AUTH and the unauthenticated limits, `maxclients`, the idle timeout.

### 15.3 Differential harness
- **Setup:** Redis 7.4 from Compose (a service container in CI) on port 6379; MiniRedis in-process on a random port; `FLUSHALL` on both before each run.
- **Client:** a small RESP client in `tests/helpers/` that keeps each reply's raw bytes and parsed value, so binary data and reply types are compared exactly.
- **Generator:** weighted random commands drawn only from what MiniRedis has registered, so † commands join automatically once written. About 20 keys across 3 databases, so keys collide and WRONGTYPE happens; values from a small alphabet plus every byte value; short `MULTI` … `EXEC` blocks; about 5% deliberately broken calls (wrong arity, non-integers, bad options) so error replies get compared too.
- **Comparison:** replies must be equal, except:
  - Unordered replies (KEYS, SMEMBERS, SINTER, SUNION, SDIFF, HKEYS, HVALS, HGETALL as pairs) are compared as sorted lists.
  - TTL and PTTL: -1 and -2 exactly; positive values within 1 s and 100 ms.
- **Never generated** (they have their own tests): random commands (SPOP, SRANDMEMBER, RANDOMKEY, HRANDFIELD, ZRANDMEMBER), SCAN cursors, OBJECT, MEMORY, INFO, DEBUG, CONFIG, CLIENT, blocking commands, pub/sub, persistence and replication commands. Generated TTLs are at least 100 seconds, so nothing expires mid-run. INCRBYFLOAT and HINCRBYFLOAT use multiples of 0.25.
- **SCAN completeness:** a full SCAN on both servers returns the same set of keys.
- **Seeds:** every run prints its seed; `SEED=81723 OPS=20000 npm run test:diff` replays it exactly. On a mismatch, print the last 20 commands, both replies and the seed.
- **The rule:** a diff gets fixed in MiniRedis, never by loosening the harness, unless it's one of the exceptions above (then it goes in `DIFFERENCES.md`).

### 15.4 Property (fast-check)
- `Dict` against a JS `Map`, `Skiplist` against a sorted array, `Quicklist` against an array: random operation sequences, then compare contents and run the invariant checks.
- SCAN: start a scan, interleave random inserts, deletes and resizes, finish it; every key present throughout must have been returned.
- Model-based server tests with `fc.commands()` and `fc.asyncModelRun()`: string, list, hash and set commands against a tiny in-memory model, through a real client.

### 15.5 Crash
- Spawn the built server in a child process with a temp `dir`, run writer clients, kill it with SIGKILL at a random moment, restart it, check.
- **AOF, all three fsync modes:** every acknowledged write is there. SIGKILL ends the process, not the machine: bytes already handed to the OS survive in its page cache, which is why all three modes pass and why fsync only matters for power loss. The walkthrough must explain this.
- **Snapshot only:** the restarted server holds one consistent snapshot: the transfer invariant holds and no key is half-written.
- **Kill during BGSAVE or AOF rewrite:** the previous file still loads.
- **The transfer invariant:** 50 clients loop on `MULTI`, `DECRBY A n`, `INCRBY B n`, `EXEC`. After any restart, and in any snapshot or rewritten AOF, `A + B` equals the starting total.
- `KILLS=50` locally, `KILLS=10` in CI.

### 15.6 Fuzz
- **Inputs:** random bytes; valid commands with one byte flipped, inserted or deleted; frames cut at every position; huge lengths (`*2147483648`, `$9999999999`); negative bulk lengths; inline lines with unbalanced quotes; 70 KB inline lines; oversized frames before AUTH; deep pipelines.
- **Checks:** each case uses a fresh connection with a 1-second deadline. The server must answer, reply with an error and close, or wait for more data; afterwards a new connection must still get `PONG`; the heap must stay bounded (checked every 10,000 cases).
- `CASES=100000` in CI, `CASES=1000000` locally or nightly.

### 15.7 Replication
An in-process primary and two replicas on random ports:
- Random writes (every type, TTLs, transactions, served BLPOPs), then `WAIT 2 5000`: DEBUG DIGEST is equal on all three.
- `CLIENT KILL TYPE replica` on the primary: the replicas reconnect with `sync_partial_ok` up by one and `sync_full` unchanged.
- With `repl-backlog-size 16kb`, kill the link and write 1 MB: the reconnect is a full sync.
- A replica rejects writes with `-READONLY`, and hides an expired key before the primary's DEL arrives.
- Promotion: `REPLICAOF NO ONE` on replica 1, then `REPLICAOF <replica 1>` on replica 2, gets `+CONTINUE`.

### 15.8 Performance checks
Run locally; the numbers go in `bench/RESULTS.md`: the 64 MB bulk parse, PING latency during a 1M-key BGSAVE, ZRANK at 10,000 vs 1,000,000 members, and dict growth to 1M keys with one bucket moved per operation.

---

## 16. Docker

`Dockerfile` (no runtime dependencies, so the final image has no `node_modules`):

```dockerfile
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/dist ./dist
COPY docker/healthcheck.js ./healthcheck.js
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 6380
HEALTHCHECK --interval=5s --timeout=3s --retries=5 CMD ["node", "healthcheck.js"]
ENTRYPOINT ["node", "dist/index.js", "--bind", "0.0.0.0", "--dir", "/data"]
```

`docker/healthcheck.js` (an inline `PING`, so it also exercises the inline parser):

```js
import net from 'node:net';
const s = net.connect(6380, '127.0.0.1');
s.setTimeout(1500, () => process.exit(1));
s.on('error', () => process.exit(1));
s.on('connect', () => s.write('PING\r\n'));
s.on('data', (d) => process.exit(/^(\+PONG|-NOAUTH)/.test(d.toString()) ? 0 : 1));
```

`docker-compose.yml`. Both servers run with the same persistence settings, so benchmarks are fair:

```yaml
services:
  miniredis:
    build: .
    ports: ["127.0.0.1:6380:6380"]
    volumes: ["miniredis-data:/data"]
    command: ["--appendonly", "yes", "--appendfsync", "everysec", "--save", ""]

  redis:   # the reference: differential tests, benchmarks, and the CLI tools
    image: redis:7.4
    ports: ["127.0.0.1:6379:6379"]
    command: ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec",
              "--save", "", "--protected-mode", "no"]

  replica1:
    build: .
    profiles: ["replication"]
    ports: ["127.0.0.1:6381:6380"]
    command: ["--replicaof", "miniredis", "6380"]
    depends_on:
      miniredis: { condition: service_healthy }

  replica2:
    build: .
    profiles: ["replication"]
    ports: ["127.0.0.1:6382:6380"]
    command: ["--replicaof", "miniredis", "6380"]
    depends_on:
      miniredis: { condition: service_healthy }

volumes:
  miniredis-data:
```

---

## 17. CI (GitHub Actions)

**On every push and pull request**
1. `npm ci` with the npm cache on Node 26, then lint, typecheck and build.
2. `npm test` with coverage; upload the coverage report.
3. The differential suite against a `redis:7.4` service container, with `OPS=20000`.
4. The crash suite (`KILLS=10`), the replication suite, and the fuzzer (`CASES=100000`).
5. `docker build`, to prove the image builds.

**On merge to main, after the steps above pass**
6. Push the image to GHCR, tagged with the commit SHA and `latest`. Image names must be lowercase, so use `ghcr.io/${GITHUB_REPOSITORY,,}` in bash; the job needs `packages: write` permission.

**Also**
- `nightly.yml` (optional): `OPS=200000`, `CASES=1000000`, `KILLS=50`. Scheduled workflows in public repos switch off after 60 days without repository activity.
- Branch protection: checks must pass before merging to main.
- Dependabot for npm (dev dependencies) and GitHub Actions.
- A CI badge in the README.

MiniRedis isn't deployed: most free hosts only route HTTP, not raw TCP, and a public database with no password is a bad idea anyway. The demo is `docker compose up`, the GHCR image and the README GIF.

---

## 18. Benchmarks

Compare against Redis on the same machine, both in Compose with the same persistence settings, and run the tool from inside the Redis container so neither side gets a networking advantage:

```bash
docker compose up -d --build miniredis redis
T=ping_inline,ping_mbulk,set,get,incr,lpush,rpush,lpop,rpop,sadd,hset,spop,zadd,zpopmin,lrange_100,mset
docker compose exec -T redis redis-benchmark -h redis     -p 6379 -n 200000 -c 50 -t $T --csv > bench/redis.csv
docker compose exec -T redis redis-benchmark -h miniredis -p 6380 -n 200000 -c 50 -t $T --csv > bench/miniredis.csv
# then both again with -P 16 (pipelining)
```

`bench/run.sh` does all of this and writes the tables. `bench/RESULTS.md` records:
- The machine (CPU, cores, RAM, OS), the Docker, Node and Redis versions, and the exact commands.
- Per test: ops/sec for both, the ratio, and p50 and p99 latency for both (from `--csv`); then the same with `-P 16`.
- Memory for 1M keys with 100-byte values (`bench/memory.ts`): `used_memory` from both, and RSS from `docker stats --no-stream`.
- Restart time with 1M keys, from the AOF and from a snapshot.
- Replica lag under load: `master_repl_offset` minus the replica's offset, sampled every second during a benchmark.
- One optimisation: profile with `node --cpu-prof` (open the `.cpuprofile` in Chrome DevTools) or `npx 0x`, fix the top hotspot (usual suspects: a `Buffer.concat` per chunk, one `socket.write` per reply, string conversions, per-command array allocations), and show before/after numbers.

Redis will win. The interesting part is explaining where and why: C against a garbage-collected runtime, compact encodings against full structures, `fork()` against copying in code.

---

## 19. Differences from Redis

Start `docs/DIFFERENCES.md` with this table, and add a row whenever the differential test forces a decision.

| Area | Redis 7.4 | MiniRedis |
|---|---|---|
| OBJECT ENCODING | listpack, intset, quicklist, hashtable, skiplist, int, embstr, raw | the same names minus listpack and intset |
| SCAN family on small collections | everything in one call | paged like big ones |
| SCAN cursors; KEYS, SMEMBERS and HGETALL order | from SipHash | from our hash: different values and order |
| INCRBYFLOAT, HINCRBYFLOAT | 80-bit long doubles | 64-bit doubles; last digits can differ |
| Largest bulk string | 512 MB | 64 MB (V8's string limit) |
| Memory numbers | measured by the allocator | estimates (section 10.5) |
| Snapshot file | RDB | our own format (section 11.2) |
| AOF | multi-part directory, optional RDB preamble | one file of commands |
| BGSAVE | `fork()` and OS copy-on-write | time slices and copy-on-write in code |
| DEBUG DIGEST | Redis's algorithm | ours; compare MiniRedis with MiniRedis only |
| Replication | with any Redis, chained replicas | MiniRedis only, no chains |
| Auth | ACL users | one password |
| INFO | dozens of fields | the fields in section 13.1 |

---

## 20. Five-day schedule

Claude Code builds on days 1–5. Studying needs only an editor, the walkthroughs and the study kit, so it continues after Pro ends.

| Day | Work |
|---|---|
| Night before | Step 1 by hand: tools installed, repo, `CLAUDE.md`, `docs/SPEC.md`, `docs/PLAN.md`, Docker running |
| 1 | Steps 2–8 (phases 0–2) |
| 2 | Steps 9–11, then 16–18 (phases 3 and 5) |
| 3 | Steps 12–15 (phase 4) |
| 4 | Steps 19–21 (phases 6 and 7) |
| 5 | Steps 22, 23 and 25; step 24 if there's time |
| 6–7 | Study phases 0–3 and 5 (section 21) |
| 8–10 | Study phases 4 and 7 |
| 11 | Study phases 6, 8 and 9; step 24 by hand if it wasn't done |
| 12–13 | † commands by hand, rewrites from scratch, interview drills |

- Phase 5 comes before phase 4 on purpose, so persistence gets a whole day. Nothing breaks: everything goes through `propagate()` from step 5.
- If a day runs over, finish it the next morning. If you're still behind, cut in this order: step 22's RESP3 extras, step 23's MONITOR and `/metrics`, then step 19. Never cut steps 8, 12–15, 20–21 or 25.
- When the usage limit hits, read the walkthroughs of what was just built until it resets.

---

## 21. Understanding the code

**Days 6–7: trace**
- Run `npm run dev -- --loglevel verbose`, open `redis-cli -p 6380 monitor` in a second terminal, and send commands from a third.
- Set breakpoints in `parser.ts`, `dispatch.ts` and `event-loop.ts` (`node --inspect` with VS Code) and follow `SET a 1` from socket bytes to the `+OK` reply.
- Redraw the architecture and the command lifecycle on paper from memory.
- For each module, write one sentence on why it exists.

**Days 8–10: the hard parts**
- Persistence: watch the crash test kill and restart the server; open the AOF in an editor; run `xxd data/dump.mrdb | head` and decode the first records by hand using section 11.2.
- Copy-on-write: step through `beforeChange` while a BGSAVE runs and another client writes.
- Replication: `docker compose --profile replication up`, run MONITOR on a replica, drop the link with `CLIENT KILL TYPE replica`, and find `+CONTINUE` in the logs.

**Break it, watch the test fail, then fix it**

| # | Break this | The test that should fail |
|---|---|---|
| 1 | Make the parser assume a whole command arrives in one chunk | Byte-at-a-time parser test |
| 2 | Concatenate the whole input buffer on every chunk | 64 MB bulk test (too slow) |
| 3 | Decode bulk strings as UTF-8 | All-256-bytes round trip |
| 4 | Use `Number` instead of `BigInt` in INCR | Differential: `SET k 9007199254740993`, then INCR |
| 5 | Drop `v \|= ~m0` from the SCAN cursor | SCAN completeness property test |
| 6 | Skip the expiry check in `lookupRead` | Expired-key test with active expiry off |
| 7 | Propagate EXPIRE as it arrived | TTL after a delayed DEBUG LOADAOF comes back longer |
| 8 | Send replies before writing the AOF in `beforeSleep` | Crash test loses acknowledged writes |
| 9 | Remove the copy-on-write hook | Transfer invariant in BGSAVE snapshots |
| 10 | Write `dump.mrdb` in place instead of temp + rename | Kill-during-BGSAVE crash test |
| 11 | Forget `signalModifiedKey` in INCR | WATCH test |
| 12 | Serve BLPOP waiters before propagating the push | Replica digest mismatch |
| 13 | Count the replica offset per TCP chunk instead of per command | Partial resync corrupts the replica |

**Days 12–13: by hand, no AI**
- Write the 25 † commands. Start with SETEX and PSETEX (they need a propagation rewrite) and SMOVE (two keys and WATCH). Registering each one adds it to the differential generator.
- Rewrite the RESP parser, the skip list and the dict from an empty file, without looking, until their tests pass.
- Write the README's design decisions in your own words.
- Answer every question in section 23 out loud, without notes, then check yourself against `docs/INTERVIEW.md`.
- Rehearse the 5-minute demo: a primary and two replicas in Compose, writes through `redis-cli`, `kill -9` on the primary, the restart with the data back, and a replica's partial resync in the logs.

---

## 22. README checklist

- [ ] A one-line pitch and badges: CI, test count, "differential-tested against Redis 7.4".
- [ ] A short GIF: `redis-cli` and `redis-benchmark` against MiniRedis, then `kill -9` and the data coming back.
- [ ] Quick start: `docker compose up`, or `docker run -p 6380:6380 ghcr.io/<you>/miniredis`, then `redis-cli -p 6380`.
- [ ] The results table against Redis, naming the machine, with a link to `bench/RESULTS.md`.
- [ ] Mermaid diagrams: architecture, command lifecycle, replication handshake.
- [ ] The commands implemented, grouped, with a link to `DIFFERENCES.md`.
- [ ] How it's tested: the suites and the commands that run them.
- [ ] Design decisions: links to the ADRs, the fork-less snapshot first.
- [ ] Limitations (section 19) in plain words.
- [ ] How it was built: designed by you, built with Claude Code, reviewed, tested and studied by you.
- [ ] "Redis is a trademark of Redis Ltd. MiniRedis is an independent learning project, not affiliated with it."
- [ ] A repo name that won't be confused with the popular Go testing library also called miniredis, for example `miniredis-ts`.

---

## 23. Interview prep

**Questions to answer without notes**

*Core design*
- Why is Redis single-threaded, and why is it still fast? Where does MiniRedis spend its time?
- What happens, step by step, when `redis-cli` sends `SET a 1`?
- How does your parser handle half a command? A thousand commands in one packet?
- What is pipelining, and why does it multiply throughput?
- Why are your keys `latin1` byte strings instead of normal JS strings? Why BigInt for INCR?

*Data structures*
- Why a skip list for sorted sets and not a balanced tree? How does ZRANK run in O(log n)?
- What is incremental rehashing, and what problem does it solve?
- How does SCAN avoid missing keys while the table resizes? Why can it return a key twice?
- How do keys expire if nobody reads them? Why sample instead of checking every key?

*Durability*
- AOF vs snapshot: what does each lose in a crash? What does `appendfsync everysec` really promise?
- Your crash test uses `kill -9`. Why doesn't that test fsync, and what would?
- How does an AOF rewrite avoid losing writes that arrive while it runs?
- Redis uses `fork()` for BGSAVE. You couldn't. What did you do instead, and what does it cost?
- Why must a relative EXPIRE be written down as PEXPIREAT? Why is INCRBYFLOAT replicated as SET?

*Distribution and concurrency*
- How does a replica catch up after a 5-second disconnect without a full copy?
- Why don't replicas expire keys themselves?
- Is replication strongly consistent? What does WAIT guarantee, and what doesn't it?
- How does WATCH work? Does MULTI/EXEC roll back?
- What happens to a client's pipelined commands after its BLPOP blocks?
- What happens when a pub/sub subscriber stops reading?

*Memory, security and proof*
- How does approximate LRU work, and why not exact LRU? How can LFU count with 8 bits?
- Why can't `dir` change at runtime?
- How did you prove MiniRedis is correct, and what can the differential test not catch?
- Where is MiniRedis slower than Redis, and why?
- How would you scale it?

**Short answer to "what did you build?"**
> MiniRedis is a Redis-compatible in-memory database I built from scratch in TypeScript, with no runtime dependencies. The real redis-cli, redis-benchmark and ioredis talk to it unchanged. It has hash tables with incremental rehashing, skip lists for sorted sets, TTL expiry, LRU and LFU eviction, an append-only log and point-in-time snapshots that survive kill -9, and primary–replica replication with partial resync. I tested it by replaying random commands against real Redis and comparing every reply. Real Redis is C, uses fork for snapshots, has compact encodings, clustering, scripting and much more. I focused on the core that decides whether data is correct, durable and fast.

**Real Redis vs this project**

| Area | Real Redis | MiniRedis |
|---|---|---|
| Runtime | C with its own allocator | TypeScript on Node, with V8's garbage collector |
| Threads | Main thread, optional I/O threads, background threads for fsync and freeing | One thread; libuv's pool runs the async fsync |
| Snapshots | `fork()` and the OS's copy-on-write | Time slices and copy-on-write in code |
| Small collections | Compact encodings (listpack, intset) | Always full structures |
| Files | RDB and multi-part AOF | Own snapshot format and one AOF file |
| Scale-out | Cluster (16,384 hash slots), Sentinel failover | One primary, replicas, manual promotion |
| Extensibility | Lua, Functions, modules | None |
| Data types | Also Streams, HyperLogLog, geo, bitmaps | Strings, lists, hashes, sets, sorted sets |
| Security | ACL users, TLS | One password, no TLS |

**Scaling answer:** shard keys across processes with hash slots (CRC16 of the key, mod 16,384, as in Redis Cluster) and redirect clients with MOVED; add read replicas; fail over automatically with a Sentinel-style monitor that promotes a replica (promotion already works); move socket parsing and reply encoding to worker threads, because one Node process can't share its keyspace across threads; keep each shard small enough that snapshots and rehashing stay quick.

---

## 24. Stretch goals (after the study days)

- HyperLogLog: PFADD, PFCOUNT, PFMERGE, counting unique items in 12 KB.
- Streams: XADD, XRANGE, XREAD with blocking.
- Cluster mode: hash slots, MOVED and ASK redirects, CLUSTER SLOTS.
- Keyspace notifications.
- Load real RDB files, so MiniRedis can start from a Redis dump.
- An AOF with a snapshot preamble, or Redis 7's multi-part AOF.
- Diskless full sync streamed straight to the socket.
- ACL users; TLS with `node:tls`.
- Bitmaps and BITFIELD.
- Point the payment gateway's rate limiter (INCR + EXPIRE) at MiniRedis, so your two projects run together.
