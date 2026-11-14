# ADR 0010: Point-in-time snapshots without fork(), by copy-on-write in code

**Status:** accepted (step 13)

## Context

Redis's BGSAVE calls `fork()`. The child process gets a frozen view of the whole dataset at that instant and writes it out at leisure, while the kernel copies a memory page only when the parent writes to it. Node has no `fork()` that keeps the heap. `child_process.fork()` starts a new, empty process, and worker threads share nothing mutable without copying. Copying the whole dataset first would cost a pause proportional to its size (rule 10) and twice the memory.

Rule 9 still requires a snapshot (BGSAVE, AOF rewrite, replica full sync) to hold every key exactly as it was when the job started, while clients keep writing.

## Decision

One engine in `src/persistence/snapshot-job.ts`, shared by every snapshot kind (spec 9.8):

- **Epochs.** Each job takes `epoch = ++server.snapshotEpoch`. Every `RObj` has a `savedEpoch`.
- **The hook.** Every `Db` method that changes or removes an existing key or its TTL first calls `beforeChange` (`lookupWrite`, `setKey`, `delete`, `rename`, `setExpire`, `removeExpire`, and expiry). If a job is walking and the object isn't stamped with its epoch, the job writes the key out right then, with its old value and TTL, and stamps it. `lookupWrite` counts as a change because its callers mutate lists, hashes, sets and sorted sets in place.
- **Stamping.** `Db.add` and `Db.setKey` stamp every new object with the running epoch, so keys born during the job are never written.
- **The walk.** A SCAN cursor per db, in `setImmediate` slices of at most 2 ms, writes every unstamped entry and stamps it. SCAN returns every key that exists for the whole walk, and every other key was saved by the hook before it changed or went. So each key is written exactly once, with its starting value, while rehashing and resizing carry on.
- **Sinks.** The job only produces `(db, key, obj, expireAt)` records. A sink turns them into the output: the binary file for BGSAVE now, a command file for the rewrite (step 14), memory for a full sync (step 20). A file sink with more than 8 MB waiting pauses the walk.
- **One job at a time**, and FLUSHDB and FLUSHALL abort a job that's still walking. The hook can't save every key at once without a long pause.
- **BGSAVE inside EXEC is scheduled**, as Redis does. A job started mid-transaction would capture the transaction half done.

## Consequences

- No pause proportional to the dataset. A BGSAVE of 1M keys took about 0.9 s, with the worst PING at 10–15 ms on the dev machine (`tests/integration/snapshot.test.ts`).
- **The honest cost.** The hook serialises a whole value at once. Changing a 10M-item list during a BGSAVE costs one pause the size of that list, where Redis would copy only the touched pages. Memory also grows with the values the hook saves early, just as Redis's copied pages grow with writes during the fork.
- Every write path has one extra branch (`snapshotJob?.save`), a no-op when no job runs. It stays correct only because rule 5 holds. A command that mutated a value it got from `lookupRead` would break point-in-time snapshots silently. `tests/unit/snapshot-job.test.ts` drives the differential generator's random commands between slices to catch that.
- The file is written by our own process, so a crash mid-BGSAVE leaves only a `temp-<pid>-<n>.mrdb`, which the next startup deletes. `dump.mrdb` is only ever replaced by rename (rule 8). The rename runs on the main thread after checking the job wasn't aborted, so a later SAVE (or FLUSHALL's save) can never be overtaken by an older job's file.
