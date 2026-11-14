# ADR 0013: Memory as running estimates

**Status:** accepted (step 19)

## Context

`maxmemory` (spec 9.4) needs to know, before every write, how much memory the dataset uses. Redis asks its allocator: `zmalloc_used_memory()` is a counter that jemalloc's wrappers update on every allocation and free, so it's exact and O(1). JavaScript has no such counter per object. `process.memoryUsage().heapUsed` covers the whole heap, garbage and all. Its value jumps whenever the collector runs, and reading it costs far too much to do once per command. `v8.getHeapSnapshot()` can size individual objects, but it walks the whole heap.

## Decision

Memory is an estimate kept as running totals (spec 10.5):

- **Per structure.** Each structure counts its payload bytes as it changes, in O(1) per change. A `Dict` counts its key bytes, plus value bytes when the values are byte strings (hashes). A `Quicklist` keeps a count per node and a total, so LTRIM can drop a whole node without walking it. A `ZSet` uses its dict's count.
- **Per value.** `objectBytes(obj)` (`src/storage/memory.ts`) is the payload plus a fixed overhead per item, plus a fixed overhead for the empty structure.
- **Per key.** `entryBytes(key, obj, hasTtl)` adds the key's bytes and a fixed per-key overhead, plus a per-TTL overhead when the key has one.
- **Per db.** Each object remembers the estimate last counted for it (`RObj.memBytes`). `Db` adjusts its `usedMemory` when a key is inserted, replaced, deleted, renamed or flushed, or its TTL changes. `signalModifiedKey` adds the difference after a command changes a value in place. `Server.usedMemory` sums the dbs.
- **The constants** are measured by `bench/calibrate-memory.ts`. It inserts a million items of each kind and divides the heap growth by a million, then subtracts the payload bytes.

`used_memory` in INFO and MEMORY USAGE report the estimate, and `maxmemory` is enforced against it. `used_memory_rss` is the real RSS, so the two can be compared.

## Consequences

- Checking the limit costs 16 additions per denyoom command, and an eviction's effect is known at once. There's no waiting for the collector to notice freed memory, which would otherwise make a loop evict far more than needed.
- The estimate isn't the heap. It leaves out client buffers, the AOF and rewrite buffers, the backlog, V8's own overhead, and garbage not yet collected. A server at `maxmemory 50mb` can have an RSS well above 50 MB. Redis also leaves replica output buffers and the AOF buffers out of its eviction check (`freeMemoryGetNotCountedMemory`), but its `used_memory` counts everything else it allocates.
- The constants are averages from one Node version on one platform. They include each structure's table slack at a typical load factor, so a dict that has just doubled is under-counted for a while. Rerun the calibration after upgrading Node or changing a structure.
- The running total is only correct if every change goes through `Db` (rule 5). The accounting test in `tests/integration/memory.test.ts` checks this. It runs a random mix of commands on every type and compares each key's `memBytes`, and each db's total, against a recount from scratch.
- `memBytes` costs one number per key. That beats a second `key → estimate` dict, which would cost about 150 bytes per key.
