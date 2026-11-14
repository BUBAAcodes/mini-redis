# Step 19: Memory accounting and eviction

## What this step built

Every data structure now counts its own bytes, every `Db` keeps a running total of its keys' estimates, and `Server.usedMemory` adds the totals up (ADR 0013). With `maxmemory` set, the dispatcher evicts before each denyoom command, using one of the 8 policies (`src/storage/eviction.ts`): approximate LRU and LFU through a 16-slot pool, random, or soonest TTL. If it can't get under the limit, the reply is `-OOM`. OBJECT (ENCODING, FREQ, IDLETIME, REFCOUNT, HELP), MEMORY USAGE, INFO's `# Memory` section and `bench/calibrate-memory.ts`, which measured the overhead constants, are new too.

## One real command's path

`SET k v` arrives while `maxmemory 50mb`, `allkeys-lru` and 50.1 MB used:

1. `dispatch` sees `maxmemory > 0`. `deniedOnOom` (`dispatch.ts:122`) finds SET flagged `denyoom`, so `performEvictions` runs (`dispatch.ts:90`, `eviction.ts:139`). This happens before MISCONF and the MULTI queueing, where Redis checks it.
2. `performEvictions` sees `usedMemory` over the limit and calls `pickFromPool` (`eviction.ts:173`). For each non-empty db, `Db.evictionSample` (`database.ts:273`) draws 5 keys from consecutive buckets. `score` (`eviction.ts:164`) works out each key's idle seconds from its `lru` field, and `EvictionPool.insert` (`eviction.ts:99`) keeps the best 16 seen so far.
3. The pool's best entry is popped. `isEvictionCandidate` (`database.ts:290`) confirms the key is still there. `evictKey` (`eviction.ts:213`) then calls `Db.delete`, which takes the key's `memBytes` back out of the total through `unaccount` (`database.ts:424`), propagates `DEL` at once, and calls `signalModifiedKey`, so a WATCH on that key fails.
4. Under the limit now, so the result is `ok` and SET runs. `setKey` (`database.ts:123`) gives the new object an LRU stamp (`stampNew`, `database.ts:409`), and `account` (`database.ts:417`) adds its `entryBytes` to the db's total. SET's own record is propagated after the DEL.
5. If no key could be picked (a volatile policy with no TTLs, or `noeviction`), the result is `fail`, `reject` replies `-OOM`, and nothing changes (rule 4).

## Key functions and why each exists

- **`Dict.bytes`, `Quicklist.bytes`** (`dict.ts:115`, `quicklist.ts:60`): payload counts updated on every change, so a value's estimate is O(1). Quicklist nodes keep their own counts, so LTRIM drops whole nodes without walking them.
- **`objectBytes` / `entryBytes`** (`memory.ts`): payload plus measured overheads per item, per key and per TTL.
- **`Db.account` / `unaccount`** (`database.ts:417`, `:424`): recount one key and add the difference. They're called from `add`, `setKey`, `delete`, `rename`, the TTL methods, lazy and active expiry, and `signalModifiedKey` (`database.ts:383`), which catches in-place changes such as HSET or LPUSH.
- **`Db.touch`** (`database.ts:392`): called on every lookup except `peek`. Under LRU it stores the clock; under LFU it runs `lfuTouch` (`eviction.ts:64`): decay one step per `lfu-decay-time` minutes, then increment with probability 1/((c−5)·factor+1).
- **`EvictionPool`** (`eviction.ts:92`): sorted, deduplicated, keeps the best 16 across rounds. It's cleared when the policy changes, because LRU, LFU and TTL scores can't be compared.
- **`Server.scheduleEviction`** (`server.ts:336`): runs the next eviction slice in the next loop turn when a slice used its 0.5 ms, or when `maxmemory` or the policy changed. serverCron also runs a slice every tick while memory is over the limit (`cron.ts:66`).
- **`Waiters.deniedOnOom`** (`waiters.ts:176`): a served BLMOVE meets the memory check again, as in Redis. This answers the question step 18 left open (checked against `redis:7.4`: the client gets `-OOM` and the source keeps the item).

## Trade-offs, and what Redis does differently

- **Estimates vs the allocator.** Redis's `used_memory` is jemalloc's counter (`zmalloc.c`): exact, and it includes everything Redis allocates. Ours covers keys, values and TTLs, with constants measured on Node 26 (ADR 0013). A sorted set's fixed cost is 2.3 KB, because our skip list's head node holds all 32 levels from the start. Redis's `zslCreate` also allocates all 32 levels, but in C each level is 16 bytes.
- **When eviction runs.** Redis's `processCommand` calls `performEvictions` before every command while `maxmemory` is set. We run it only where a command could be refused: denyoom commands, an EXEC holding one, and a served BLMOVE. serverCron and the eviction timer cover the rest. Both refuse the same commands, which was checked against the reference, including the MULTI cases. That's a row in `docs/DIFFERENCES.md`.
- **The hot-set test.** "10% of keys get 90% of reads" can be run two ways. Read-through, where a miss SETs the key back, is the independent reference model, where LRU barely beats random. In a simulation, LRU scored 72% against random's 65% with the cache the size of the hot set. So `tests/integration/eviction.test.ts` uses a fixed dataset under insert pressure, with a new key written after every read. There LRU keeps the hot keys and random loses them: random 11%, LRU 74%, LFU 81%. The test drives the LRU clock itself, a tick per 1,000 reads, because the real clock ticks once a second, like Redis's.
- **Sampling.** Redis's `evictionPoolPopulate` uses `dictGetSomeKeys` and caches a key's sds in each pool slot. We use `Dict.randomEntries`, with the same consecutive-bucket walk, and plain strings.

Tests: `tests/unit/eviction.test.ts` covers the LFU math against redis.conf's table, idle-time wrap-around and pool ordering. `tests/unit/memory.test.ts` checks the counters against a recount under 20,000 random operations, plus `bytesToHuman`. `tests/integration/memory.test.ts` keeps the accounting exact through 4,000 random commands of every type, DEBUG RELOAD and expiry, and covers OBJECT, MEMORY USAGE and INFO. `tests/integration/eviction.test.ts` covers every "Done when" item, each volatile policy, the MULTI and EXEC OOM rules, propagation, WATCH, the served BLMOVE, cron eviction and AOF loading.

## The single most important line

`dispatch.ts:90`: `if (performEvictions(server) === 'fail') {`. It's rule 14 in one line: evict first, then refuse. Making the condition `false` fails the noeviction test ("refuses denyoom commands with -OOM …") and the 200 MB `allkeys-lru` test in `tests/integration/eviction.test.ts`. The rest of that file then fails too, because the shared client is left holding unread replies (checked by disabling the line).

## Quiz

1. Why does `Db.signalModifiedKey` recount the key's estimate, when `setKey` and `delete` already adjust the total?
2. Under `allkeys-lfu`, a key is read 1,000 times, then nobody touches it for 30 minutes (default `lfu-decay-time 1`, `lfu-log-factor 10`). Roughly what does OBJECT FREQ say before and after the 30 minutes?
3. With `maxmemory` set and `noeviction`, a client queues `SET a 1` in MULTI while memory is under the limit. Another client then fills memory past the limit. What does EXEC reply, and why does EXEC itself get checked?

<details>
<summary>Answers</summary>

1. Most writes change a value in place: HSET adds a field to a dict already stored under the key, and LPUSH adds to its quicklist. No `Db` method sees that change, so the total would drift. `signalModifiedKey` is the one call rule 5 guarantees after every change. It recounts in O(1), because each structure keeps its own byte count, and adds the difference to the total (`database.ts:383`).
2. About 18 before (redis.conf's table: 1,000 hits at factor 10). After 30 minutes, `lfuDecrAndReturn` takes off one per minute, so about 0. The decay is applied when the key is next read, or when OBJECT FREQ or the pool asks, not by a background job.
3. `-EXECABORT Transaction discarded because of: OOM command not allowed when used memory > 'maxmemory'.` and nothing runs. `deniedOnOom` (`dispatch.ts:122`) treats an EXEC whose queue holds a denyoom command as denyoom itself, as Redis's `is_denyoom_command` does. Memory can cross the limit between queueing and EXEC, and checking each queued command as it runs would break the transaction's all-or-nothing.

</details>
