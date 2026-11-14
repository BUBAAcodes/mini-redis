# Step 13: Snapshots (the copy-on-write engine, SAVE and BGSAVE)

## What this step built

`snapshot-job.ts` is an engine that walks the keyspace in 2 ms slices while clients keep writing, and still writes every key exactly as it was when the job started. `Db` hands each key's old value to the job just before anything changes it. `snapshot-format.ts` is the binary `dump.mrdb` format: an incremental writer and a loader that checks every length and the CRC-64 and reports damage with its byte offset. On top of these sit SAVE, BGSAVE, LASTSAVE, save points, DEBUG RELOAD, FLUSHALL's save of the empty dataset, and loading `dump.mrdb` at startup.

## One real command's path

`BGSAVE` with 1M keys, while another client runs `INCRBY A 5`:

1. `call` runs `bgsaveCommand` (`dispatch.ts:162`, `server.ts:193`). With no job running and the client not inside EXEC, it calls `startBgsave` (`server.ts:207`, `snapshot-job.ts:389`). That opens `temp-<pid>-<n>.mrdb` through `FileSnapshotSink` (`snapshot-job.ts:239`) and creates the job (`snapshot-job.ts:400`). The constructor takes `epoch = ++snapshotEpoch`, notes `dirtyAtStart`, sets `server.snapshotJob`, and schedules the first slice (`snapshot-job.ts:105`, `:117`). The reply is `+Background saving started`.
2. Each `slice` (`snapshot-job.ts:155`) calls `db.scanStep` with the `visit` callback until 2 ms pass (`:172`). `visit` (`:92`) skips stamped objects. For the rest it calls `sink.write` → `SnapshotWriter.writeKey` (`snapshot-format.ts:104`) and stamps the object with the epoch. `sink.flush` (`snapshot-job.ts:256`) hands the bytes to `pump` (`:281`), which starts an async `fs.writev`.
3. Between slices, `INCRBY A 5` arrives. `incrDecr` gets `A` through `stringForWrite` → `lookupWrite` (`strings.ts:33`). `lookupWrite` calls `beforeChange` (`database.ts:96`, `:309`), which calls `job.save` (`snapshot-job.ts:126`). `A` isn't stamped, so its old value and TTL are written now and the object is stamped. `setKey` then stores a new object, stamped too, so the walk will skip `A` from here on.
4. Once every db is walked, `sink.end` (`snapshot-job.ts:184`) writes `0xFF` and the CRC, drains the queue, and runs `finish` (`:307`): async fsync, then on the main thread `closeSync` and `renameSync` over `dump.mrdb` (`:322`), then an async fsync of the directory (`:327`).
5. `bgsaveDone` (`snapshot-job.ts:406`) subtracts `dirtyAtStart` from `dirty`, which leaves the `INCRBY` counted as unsaved (`:413`). It sets `lastSave` and logs `Background saving terminated with success`.

At the next startup with `appendonly no`, `Server.start` deletes leftover temp files and calls `loadSnapshotFile` (`server.ts:173`, `:177`). `readSnapshot` (`snapshot-format.ts:356`) parses into fresh `Db`s, checks the CRC (`:407`), and only then calls `installSnapshot` → `Db.replaceData` (`database.ts:144`).

## Key functions and why each exists

- **`Db.beforeChange` (`database.ts:309`)**: the one hook every change path goes through: `lookupWrite`, `setKey`, `delete`, `rename` (through its two deletes), `setExpire`, `removeExpire` and expiry. It only works because rule 5 holds: no command touches a dict directly.
- **`SnapshotJob.stamp` (`snapshot-job.ts:135`)**: `add` and `setKey` mark newborn objects as "not part of this snapshot". Without it, a key created mid-walk would be written by the walk.
- **`SnapshotJob.abort` (`snapshot-job.ts:144`)**: FLUSHDB/FLUSHALL (`database.ts:174`, `keys.ts:130`), DEBUG RELOAD and shutdown. It isn't a failure, so `rdb_last_bgsave_status` stays put, as with Redis's `killRDBChild`.
- **`FileSnapshotSink` (`snapshot-job.ts:226`)**: async writes with at most one in flight, and the walk pauses past 8 MB pending. While a write is in flight, an abort only sets a flag; the callback closes the fd and unlinks the temp file. The rename is synchronous and checks `aborted` first, so FLUSHALL's synchronous save can never be overwritten by an older job's file.
- **`SnapshotWriter` / `readSnapshot` (`snapshot-format.ts:78`, `:356`)**: incremental output with a running CRC, so SAVE, slices and the hook share one encoder. `Reader.count` (`:319`) checks a claimed count against the bytes left before any loop runs (rule 11).
- **`Crc64` (`crc64.ts:28`)**: two `Uint32Array` tables and two uint32 halves, so the per-byte loop has no BigInt (spec 11.3).
- **`Propagator.force` / `ctx.forcePropagation`**: FLUSHALL's save resets `dirty`, so "dirty grew" can no longer decide whether to propagate. This is Redis 7.4's `forceCommandPropagation`, and it replaced the old `dirty++` hack.

## Trade-offs, and what Redis does differently

- **No fork.** Redis's `rdbSaveBackground` (`rdb.c`) forks, and the kernel copies touched 4 KB pages. We copy whole values in the hook, so changing a huge list mid-BGSAVE costs one pause the size of that list (ADR 0010).
- **Measured:** a BGSAVE of 1M small strings took about 0.9 s with 800–1,300 PINGs answered, the worst at 10.2–14.7 ms over three runs (limit 50 ms). The 2 ms slices aren't the worst case; GC and buffer allocation are the likely tail.
- **FLUSHDB aborts the job.** Redis's child just finishes with the pre-flush data (`docs/DIFFERENCES.md`). FLUSHALL with save points then writes the empty dataset, as `flushAllDataAndResetRDB` (`db.c`) does.
- **DEBUG RELOAD** (`debug.c`) empties the data and then loads. Ours swaps data in only after a fully checked load.
- **Not yet:** saving at SHUTDOWN (step 23), and "`appendonly yes`, no AOF, a snapshot → load it, then rewrite", which needs step 14.

Tests: `tests/unit/crc64.test.ts` (5), `snapshot-format.test.ts` (12: round trip, every flipped byte, every truncation, crafted bad files), `snapshot-job.test.ts` (21: eight seeded random-write runs between slices, plus hook, abort, backlog, failures and save points), and `tests/integration/snapshot.test.ts` (18, covering every "Done when" item).

## The single most important line

`database.ts:310`: `this.server.snapshotJob?.save(this, key, obj);`. Without it, a BGSAVE is a smear across time: each key is saved whenever the walk happens to reach it. Deleting it fails 11 tests in `tests/unit/snapshot-job.test.ts`, starting with "saves the dataset as it was at the start while random writes land mid-walk", and the integration test "100 BGSAVEs taken while 50 clients run the transfer transaction all keep A + B". In that test, A is saved before a transfer and B after it.

## Quiz

1. A key holds a 3-item list when BGSAVE starts. Mid-walk, a client runs `LPUSH k x`, then `DEL k`, then `SET k v`. What does the snapshot hold for `k`, and which code wrote it?
2. Why does FLUSHALL with save points abort even a job that has finished walking and is only fsyncing, when FLUSHDB aborts only a walking one?
3. SCAN may return a key twice when the table grows mid-scan. Why does that never produce a duplicate record, which would make the file unloadable?

<details>
<summary>Answers</summary>

1. The original 3-item list. `LPUSH` reaches `lookupWrite`, whose hook (`database.ts:96`) writes the unchanged list and stamps it before the push. `DEL` finds it stamped and writes nothing. `SET` stores a new object that `setKey` stamps at birth, so the walk skips it.
2. A finishing job's file still holds the old data, and its rename would land after FLUSHALL's synchronous save of the empty dataset. A restart would then bring back everything FLUSHALL deleted. FLUSHDB writes no file, so only a job that's still walking (and would need the hook for every key in the db) has to go.
3. The walk writes only objects whose `savedEpoch` isn't the job's epoch, and stamps them as it writes (`snapshot-job.ts:93`). The second visit finds the stamp and skips. The loader would reject a duplicate anyway (`duplicate key`).

</details>
