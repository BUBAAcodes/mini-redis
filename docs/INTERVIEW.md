# Interview prep

Every question from spec section 23, answered in a few sentences, each pointing at the code
that makes the answer true. Say the answer out loud first, then check it here. The links are
checked by `tests/unit/docs-refs.test.ts`, so if the code moves, that test fails until this
file follows it.

## Core design

### Why is Redis single-threaded, and why is it still fast? Where does MiniRedis spend its time?

A command is a few hundred nanoseconds of work on data already in memory, so the costs that
matter are system calls and cache misses, not CPU parallelism. One thread means no locks and
no races: every command sees and leaves the data consistent, and MULTI is atomic for free. It
stays fast by never waiting (non-blocking sockets, one event loop) and by batching: many
commands per read, one write per client per loop turn. MiniRedis copies that design: every
command runs synchronously from the socket's data callback,
[`processInput` server.ts:501](../src/server/server.ts#L501), and replies leave once per turn
in [`beforeSleep` event-loop.ts:54](../src/server/event-loop.ts#L54). The step 24 profile
(see [RESULTS.md](../bench/RESULTS.md)) puts the time in the kernel's socket writes, hashing
keys ([`murmur3_32` hash.ts:17](../src/utils/hash.ts#L17)), turning bytes into strings, and
the dispatcher's per-command bookkeeping.

### What happens, step by step, when `redis-cli` sends `SET a 1`?

1. The bytes arrive in a `data` event and go to the client's parser:
   [`onData` server.ts:493](../src/server/server.ts#L493) →
   [`feed` parser.ts:115](../src/protocol/parser.ts#L115).
2. [`processInput` server.ts:501](../src/server/server.ts#L501) pulls complete commands and
   hands each to [`dispatch` dispatch.ts:62](../src/commands/dispatch.ts#L62), which checks,
   in Redis's order: the command exists, arity, auth, memory, MISCONF, READONLY, subscriber
   mode, MULTI.
3. [`call` dispatch.ts:188](../src/commands/dispatch.ts#L188) reads the clock once, runs
   `setCommand`, records stats and SLOWLOG, feeds MONITOR.
4. `setCommand` goes through `Db`:
   [`lookupWrite` database.ts:106](../src/storage/database.ts#L106) (lazy expiry,
   copy-on-write), then `setKey` and
   [`signalModifiedKey` database.ts:398](../src/storage/database.ts#L398) (WATCH, blocked
   clients, `dirty++`).
5. [`propagator.end` dispatch.ts:250](../src/commands/dispatch.ts#L250) appends the record
   to the AOF buffer and the replication stream.
6. At the end of the loop turn, [`writeAof` event-loop.ts:63](../src/server/event-loop.ts#L63)
   hands the AOF bytes to the OS, and only then does
   [`writeClient` event-loop.ts:75](../src/server/event-loop.ts#L75) send `+OK`.

### How does your parser handle half a command? A thousand commands in one packet?

The parser keeps a queue of the socket's own chunks plus a read position, never concatenating
them. [`parse` parser.ts:132](../src/protocol/parser.ts#L132) returns `null` the moment
anything is incomplete; the multibulk state (arguments left, the current bulk length) stays in
the object, and the line-end search resumes where it stopped
([`find` parser.ts:253](../src/protocol/parser.ts#L253)), so half a command costs nothing
extra when the rest arrives. A thousand commands in one packet is the same loop running a
thousand times before `beforeSleep`; each command reports its exact byte count, which a replica
needs for its offset. The tests feed a 1,000-command pipeline one byte at a time
([parser.test.ts:296](../tests/unit/parser.test.ts#L296)) and a 64 MB bulk in 1 KB chunks
([parser.test.ts:325](../tests/unit/parser.test.ts#L325)).

### What is pipelining, and why does it multiply throughput?

The client sends many commands without waiting for each reply. Without it, every command costs
a full network round trip and two system calls on each side; with it, one read brings in
dozens of commands and one write returns all their replies. MiniRedis gets the batching
because replies queue on the client ([client.ts](../src/server/client.ts)) and leave in a
single write per turn ([`writeClient` event-loop.ts:75](../src/server/event-loop.ts#L75)).
In the benchmarks `-P 16` multiplies throughput several times, for both servers.

### Why are your keys `latin1` byte strings instead of normal JS strings? Why BigInt for INCR?

Redis keys and values are arbitrary bytes, and decoding them as UTF-8 would corrupt anything
that isn't valid UTF-8 (`\xff\xfe` becomes replacement characters). With latin1, every byte
maps to exactly one character, so lengths are byte counts and comparisons are byte comparisons
([ADR 0001](adr/0001-byte-strings-latin1.md)); the conversion happens once, in the parser:
[`toString` parser.ts:178](../src/protocol/parser.ts#L178). INCR works on signed 64-bit
integers, and a JS number is only exact up to 2^53, so `SET k 9007199254740993` then INCR would
silently be wrong. [`incrDecr` strings.ts:253](../src/commands/strings.ts#L253) does the math in
BigInt and [`addInt64` numbers.ts:27](../src/utils/numbers.ts#L27) reports overflow exactly
where Redis does ([ADR 0004](adr/0004-incr-bigint.md)).

## Data structures

### Why a skip list for sorted sets and not a balanced tree? How does ZRANK run in O(log n)?

A skip list gives the same expected O(log n) as a balanced tree with much simpler code: no
rotations, inserts and deletes only rewire neighbours, and range scans are a walk along level 0. Node heights come from coin flips,
[`randomLevel` skiplist.ts:122](../src/datastructures/skiplist.ts#L122) (p = 1/4, as in
Redis). ZRANK is O(log n) because every forward link stores its span, the number of level-0
nodes it skips; [`rank` skiplist.ts:202](../src/datastructures/skiplist.ts#L202) sums spans
along the search path. The dict next to it ([zset.ts](../src/datastructures/zset.ts)) makes
ZSCORE O(1).

### What is incremental rehashing, and what problem does it solve?

Growing a hash table means moving every entry into a bigger table. Doing that at once for
millions of keys would freeze the server for a long time. Instead the dict keeps two tables
while it resizes, and every operation moves one bucket,
[`rehash` dict.ts:199](../src/datastructures/dict.ts#L199); lookups check both tables, and
inserts go to the new one. serverCron also rehashes for 1 ms per tick, so an idle server
finishes too. Growth and shrinking start in
[`expandIfNeeded` dict.ts:435](../src/datastructures/dict.ts#L435) and
[`maybeShrink` dict.ts:186](../src/datastructures/dict.ts#L186).

### How does SCAN avoid missing keys while the table resizes? Why can it return a key twice?

The cursor counts with its bits reversed:
[`nextCursor` dict.ts:62](../src/datastructures/dict.ts#L62) sets the bits above the mask
(`v |= ~mask`), reverses, adds one, reverses back. Incrementing the high bits first means that
when the table doubles, every bucket already visited maps to buckets the cursor has also
passed, and when it halves, the unvisited ones are still ahead. So every key present for the
whole scan is returned. A key can come back twice when the table shrinks mid-scan: two small
buckets merge into one bucket the cursor still has to visit. That's why SCAN promises "at
least once", and why a property test checks exactly that promise
([dict.test.ts:137](../tests/property/dict.test.ts#L137)).

### How do keys expire if nobody reads them? Why sample instead of checking every key?

Every lookup checks the deadline first (lazy expiry):
[`expireIfNeeded` database.ts:333](../src/storage/database.ts#L333). Keys nobody reads are
found by the active cycle, [`activeExpireCycle` expiry.ts:21](../src/storage/expiry.ts#L21):
ten times a second it samples 20 keys with a TTL, deletes the expired ones, and goes again
while more than 25% of a sample was expired, within a time budget. Checking every key would
cost O(n) per tick and stall the loop with millions of keys (rule 10); sampling estimates how
much expired garbage there is and spends effort only when it's a lot.

## Durability

### AOF vs snapshot: what does each lose in a crash? What does `appendfsync everysec` really promise?

A snapshot loses everything since it was taken, which can be minutes with the default save
points. The AOF loses at most what wasn't yet on disk. With `always`, nothing acknowledged
([`flush` aof.ts:116](../src/persistence/aof.ts#L116) fsyncs before any reply). With
`everysec`, about the last second, and only on power loss or a kernel crash: the bytes were
already handed to the OS before the reply, so a process crash loses nothing. With `no`,
whatever the OS hadn't flushed. The fine print: `everysec` is a target, not a guarantee. If the
disk is slow and an fsync is still running, writes keep going without waiting for it, as in
Redis.

### Your crash test uses `kill -9`. Why doesn't that test fsync, and what would?

`kill -9` ends the process, not the machine. Every byte passed to `write()` is already in the
kernel's page cache, which survives the process, so the AOF is complete after a restart in all
three fsync modes ([aof.test.ts:18](../tests/crash/aof.test.ts#L18)). What it does test is rule
8: replies leave only after `writeSync` handed the AOF bytes to the OS. Testing fsync means
losing the page cache: power-cutting a VM, or a fault-injection filesystem such as dm-flakey or
LazyFS that drops unsynced writes, then checking that every write acknowledged under `always`
is still there.

### How does an AOF rewrite avoid losing writes that arrive while it runs?

The rewrite is a snapshot job writing commands to a temp file. Meanwhile every new write still
goes to the old AOF, so durability doesn't pause, and also into a
[`RewriteBuffer` aof-rewrite.ts:149](../src/persistence/aof-rewrite.ts#L149). When the job
finishes, [`swapAof` aof-rewrite.ts:239](../src/persistence/aof-rewrite.ts#L239) appends the
buffer to the temp file, fsyncs it, closes the old file, renames the temp file over it and
fsyncs the directory, all in one synchronous step, so no write can slip between the two
files. If anything fails, the temp file is deleted and the old AOF is untouched.

### Redis uses `fork()` for BGSAVE. You couldn't. What did you do instead, and what does it cost?

Copy-on-write in code ([ADR 0010](adr/0010-copy-on-write-snapshots.md)). Each job has an epoch.
It walks every db with a SCAN cursor in slices of at most 2 ms, writing every key not yet
stamped with the epoch ([snapshot-job.ts:99](../src/persistence/snapshot-job.ts#L99)).
Before `Db` changes or deletes a key, it calls
[`save` snapshot-job.ts:135](../src/persistence/snapshot-job.ts#L135) (from
[`save` database.ts:388](../src/storage/database.ts#L388)), which writes the old value first
if it isn't stamped yet. New keys are stamped at birth, so they're skipped. The cost: the hook
serialises a whole value at once, so changing a huge list during a BGSAVE is one pause the
size of that list; memory grows with the values saved early; and the walk shares the one
thread with clients, so a BGSAVE slows commands down, where Redis's child runs on another
core.

### Why must a relative EXPIRE be written down as PEXPIREAT? Why is INCRBYFLOAT replicated as SET?

Propagated commands are replayed later (AOF load) or elsewhere (replicas). `EXPIRE k 100`
replayed an hour later would give the key another 100 seconds; the absolute time is the same
whenever it's applied: [`rewritePropagation` keys.ts:218](../src/commands/keys.ts#L218), and
SET's options become `PXAT` at [strings.ts:159](../src/commands/strings.ts#L159). INCRBYFLOAT
becomes `SET k <result> KEEPTTL` ([strings.ts:308](../src/commands/strings.ts#L308)) because
float formatting and rounding could differ on another machine or version, and a replica must
end up with exactly the primary's bytes. SPOP becomes SREM for the same reason: a random choice
must be made only once ([sets.ts:127](../src/commands/sets.ts#L127)).

## Distribution and concurrency

### How does a replica catch up after a 5-second disconnect without a full copy?

The primary keeps the newest `repl-backlog-size` bytes of the stream in a ring buffer
([backlog.ts](../src/replication/backlog.ts),
[ADR 0014](adr/0014-replication-backlog.md)). The replica reconnects with
`PSYNC <replid> <offset+1>`;
[`tryPartialResync` primary.ts:236](../src/replication/primary.ts#L236) accepts if the replid
matches and the offset is still in the backlog
([`contains` backlog.ts:52](../src/replication/backlog.ts#L52)), answers `+CONTINUE` and sends
[`readFrom` backlog.ts:74](../src/replication/backlog.ts#L74). Five seconds of writes fit in
the default 1 MB unless the write rate is high; otherwise it's a full sync.

### Why don't replicas expire keys themselves?

If a replica deleted keys on its own clock, its data would depend on timing and could diverge
from the primary's, for instance a key the primary had just refreshed with a new EXPIRE. So
only the primary expires, and it propagates a `DEL`. A replica hides an expired key from
clients (rule 7) but keeps it until that DEL arrives:
[`expireIfNeeded` database.ts:333](../src/storage/database.ts#L333) returns "missing" for
clients and deletes nothing on a replica. The stream from the primary still sees the key.

### Is replication strongly consistent? What does WAIT guarantee, and what doesn't it?

No: replication is asynchronous. The primary replies before any replica has the write, so a
primary crash can lose acknowledged writes, and a read from a replica can be stale.
[`waitCommand` replication.ts:78](../src/commands/replication.ts#L78) blocks until N replicas
have acknowledged the client's last write offset, or the timeout ends. It guarantees that
those replicas received and applied the write; it doesn't make the write durable on their
disks, doesn't roll anything back if fewer replicas answer, and doesn't stop a failover from
promoting a replica that never got it.

### How does WATCH work? Does MULTI/EXEC roll back?

[`watchCommand` transactions.ts:61](../src/commands/transactions.ts#L61) registers the client
against the key. Every change goes through
[`signalModifiedKey` database.ts:398](../src/storage/database.ts#L398), which calls
[`touchWatchedKey` watch.ts:63](../src/storage/watch.ts#L63) and flags each watcher. Expiry,
flushes and eviction count too. At EXEC, a flagged client gets a null array and nothing runs:
optimistic locking, check-and-set. EXEC doesn't roll back: if a queued command fails at run
time (WRONGTYPE, say), the others still run. Errors caught while queueing (unknown command,
wrong arity) abort the whole transaction with EXECABORT instead.
[`execCommand` transactions.ts:28](../src/commands/transactions.ts#L28).

### What happens to a client's pipelined commands after its BLPOP blocks?

They wait, unparsed, in the client's parser.
[`processInput` server.ts:501](../src/server/server.ts#L501) stops its loop while
`client.blocked` is set, so nothing after the BLPOP runs, and replies keep their order
(rule 12). When the BLPOP is served
([`handleClientsBlockedOnKeys` waiters.ts:134](../src/blocking/waiters.ts#L134)) or times
out, the client is queued with
[`queueUnblocked` server.ts:418](../src/server/server.ts#L418), and its remaining input runs
from the next `beforeSleep`, never nested inside the command that unblocked it; the replies
still leave in order.

### What happens when a pub/sub subscriber stops reading?

Its replies pile up in Node's socket buffer, because
[`publish` hub.ts:70](../src/pubsub/hub.ts#L70) keeps queuing messages for it. After every
write, [`enforceOutputLimit` limits.ts:33](../src/server/limits.ts#L33) measures what's still
queued against the `pubsub` class of `client-output-buffer-limit` (32 MB hard, 8 MB for 60 s
soft) and disconnects the client past it. One slow consumer can't make the server's memory
grow without bound ([ADR 0016](adr/0016-output-limits-after-write.md)).

## Memory, security and proof

### How does approximate LRU work, and why not exact LRU? How can LFU count with 8 bits?

Exact LRU needs a linked list through every key, updated on every access: two pointers per key
and pointer-chasing writes on every read. Approximate LRU stores a 24-bit clock in each object
([`touch` database.ts:407](../src/storage/database.ts#L407)). At eviction time it samples
`maxmemory-samples` keys and keeps the idlest in a 16-slot pool across rounds
([`EVPOOL_SIZE` eviction.ts:27](../src/storage/eviction.ts#L27),
[`performEvictions` eviction.ts:139](../src/storage/eviction.ts#L139)), which comes very close
to exact LRU for a fraction of the cost. LFU's counter is logarithmic:
[`lfuLogIncr` eviction.ts:57](../src/storage/eviction.ts#L57) increments with probability
`1 / ((counter − 5) × lfu-log-factor + 1)`, so it takes about a million hits to reach 255, and
[`lfuDecrAndReturn` eviction.ts:45](../src/storage/eviction.ts#L45) decays it by one per
`lfu-decay-time` minutes, so old popularity fades.

### Why can't `dir` change at runtime?

`dir` is where the AOF, the snapshot and the temp files of running jobs live. Changing it
mid-flight would leave an open AOF in one place and a rewrite renaming into another, and the
next restart would look in the wrong folder. It is also a classic attack: Redis's
`CONFIG SET dir` plus `dbfilename` let anyone who could connect write a file anywhere, such as
`~/.ssh/authorized_keys`. So it's immutable
([`dir` config.ts:345](../src/config.ts#L345)).

### How did you prove MiniRedis is correct, and what can the differential test not catch?

Several layers ([tests](../tests)): unit tests per module; property tests of the dict, skip
list and quicklist against plain models; integration tests per command group; the
differential test, which sends the same random commands to Redis 7.4 and to MiniRedis and
compares every reply byte for byte (the [`Generator`](../tests/differential/generator.ts#L367)
and [`repliesMatch`](../tests/differential/compare.ts#L43)); crash tests that `kill -9`
writers and check every acknowledged write; a fuzzer; and replication tests comparing
`DEBUG DIGEST`. The differential test can't catch what it never generates: random commands,
timing (expiry, blocking), persistence and replication, behaviour under concurrency, and
performance. It also can't catch a bug Redis and MiniRedis share, or a difference both happen to
hide, such as the same reply reached by different internal states.

### Where is MiniRedis slower than Redis, and why?

Everywhere, by a factor that depends on how much of the cost is ours
([RESULTS.md](../bench/RESULTS.md)). Without pipelining, both servers mostly wait on the
network, and MiniRedis does 25–69% of Redis's throughput. With `-P 16` the cost per command
decides, and MiniRedis does 24–63%, typically about a third. It uses 3.6× the memory per
key. The reasons: V8 allocates objects for every argument, reply and command context and has
to collect them, where Redis's C reuses its own buffers; Redis keeps small collections in
compact listpacks and intsets, where we always build hash tables and skip lists (the widest
gaps are SADD, ZPOPMIN and RPUSH); hashing in JS is slower than SipHash in C; replies go
through Node's stream machinery; and our BGSAVE shares the one thread, where Redis's runs in a
forked child. The profile's next target is hashing: a SET hashes its key five times, three of
them in an empty `expires` dict.

### How would you scale it?

Shard keys across processes with hash slots (CRC16 of the key mod 16,384, as Redis Cluster
does) and redirect clients with `MOVED`. Add read replicas for read-heavy loads. Fail over
automatically with a Sentinel-style monitor that promotes a replica; promotion with `replid2`
already works ([`shiftReplid` primary.ts:318](../src/replication/primary.ts#L318)). Move
socket parsing and reply encoding to worker threads, since one Node process can't share its
keyspace across threads. Keep each shard small enough that snapshots and rehashing stay quick.

## The short answer to "what did you build?"

> MiniRedis is a Redis-compatible in-memory database I built from scratch in TypeScript, with
> no runtime dependencies. The real redis-cli, redis-benchmark and ioredis talk to it
> unchanged. It has hash tables with incremental rehashing, skip lists for sorted sets, TTL
> expiry, LRU and LFU eviction, an append-only log and point-in-time snapshots that survive
> kill -9, and primary–replica replication with partial resync. I tested it by replaying random
> commands against real Redis and comparing every reply. Real Redis is C, uses fork for
> snapshots, has compact encodings, clustering, scripting and much more. I focused on the core
> that decides whether data is correct, durable and fast.

## Real Redis vs this project

| Area              | Real Redis                                                                  | MiniRedis                                       |
| ----------------- | --------------------------------------------------------------------------- | ----------------------------------------------- |
| Runtime           | C with its own allocator                                                    | TypeScript on Node, with V8's garbage collector |
| Threads           | Main thread, optional I/O threads, background threads for fsync and freeing | One thread; libuv's pool runs the async fsync   |
| Snapshots         | `fork()` and the OS's copy-on-write                                         | Time slices and copy-on-write in code           |
| Small collections | Compact encodings (listpack, intset)                                        | Always full structures                          |
| Files             | RDB and multi-part AOF                                                      | Own snapshot format and one AOF file            |
| Scale-out         | Cluster (16,384 hash slots), Sentinel failover                              | One primary, replicas, manual promotion         |
| Extensibility     | Lua, Functions, modules                                                     | None                                            |
| Data types        | Also Streams, HyperLogLog, geo, bitmaps                                     | Strings, lists, hashes, sets, sorted sets       |
| Security          | ACL users, TLS                                                              | One password, no TLS                            |
