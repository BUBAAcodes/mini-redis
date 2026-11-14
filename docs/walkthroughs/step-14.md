# Step 14: AOF rewrite

## What this step built

BGREWRITEAOF replaces a long AOF with the fewest commands that rebuild the same data. It runs on step 13's copy-on-write engine with a command encoder, while a rewrite buffer collects every write made meanwhile. When the walk is done, one synchronous step appends the buffer to the temp file, fsyncs it and renames it over the old AOF. Around that sit auto-rewrite, rewrites scheduled behind a BGSAVE or an EXEC, and `CONFIG SET appendonly yes|no` at runtime. There is also the startup case "no AOF but a snapshot": both wait for a rewrite before any AOF file exists.

## One real command's path

`BGREWRITEAOF` on 100k keys, while another client runs `INCRBY A 5`:

1. `dispatch` → `bgrewriteaofCommand` (`dispatch.ts:162`, `commands/server.ts:220`). No job is running and we're not inside EXEC, so it calls `startAofRewrite` (`:231`, `aof-rewrite.ts:187`). That opens `temp-rewrite-<pid>.aof` through `FileSnapshotSink` with an `AofCommandWriter` and a `FileCommit` (`aof-rewrite.ts:196`–`203`). It attaches a `RewriteBuffer` to the propagator (`:212`) and creates the job (`snapshot-job.ts:110`).
2. Slices walk the dbs (`snapshot-job.ts:162`, `:179`). `AofCommandWriter.writeKey` (`aof-rewrite.ts:48`) turns each key into `SET`/`RPUSH`/`SADD`/`HSET`/`ZADD` commands of at most 64 items, then `PEXPIREAT`. `FileSnapshotSink.pump` writes the commands asynchronously.
3. `INCRBY A 5` arrives between slices. `lookupWrite` runs the hook (`database.ts:310` → `snapshot-job.ts:132`), which writes `SET A <old>` into the temp file first. The command's record then goes through `Propagator.emit` (`propagate.ts:130`) to both sinks: the live `Aof` and `RewriteBuffer.append` (`aof-rewrite.ts:153`). In `beforeSleep` (`event-loop.ts:52`) `Aof.flush` (`aof.ts:116`) writes it to the old file before the reply goes out, so durability never pauses.
4. When the walk ends, `sink.end` (`snapshot-job.ts:191`) drains the queue and `finish` (`:331`) fsyncs the temp file on the thread pool. Then everything is synchronous. `beforeClose` (`:344` → `aof-rewrite.ts:196`) detaches the buffer, appends it and calls `fsyncSync`. The temp file is closed, and `commit` → `swapAof` (`aof-rewrite.ts:239`) runs `old.close()` (`:245`), `renameSync` (`:249`) and `fsyncDirSync` (`:251`), then reopens the AOF through `server.setAof` (`:260`, `server.ts:265`).
5. `rewriteDone` (`aof-rewrite.ts:269`) sets `aof_last_bgrewrite_status:ok`. The next write lands in the new file, under a fresh SELECT.

## Key functions and why each exists

- **`FileSnapshotSink` + `SinkEncoder` + `FileCommit` (`snapshot-job.ts:229`–`264`)**: step 13's sink with its format and its last step pulled out. BGSAVE passes `SnapshotWriter` and a commit that renames. The rewrite passes the command writer and the swap. The async queue, abort safety and cleanup are written once.
- **`RewriteBuffer` (`aof-rewrite.ts:149`)**: the writes the snapshot can't contain. It's attached in the same synchronous step that starts the job, so every write after the start is in it exactly once. `encodeRecord` (`aof.ts:57`) is shared with the AOF.
- **`swapAof` (`aof-rewrite.ts:239`)**: spec 9.7 step 4. If the rename fails, it reopens whatever file is now at the path, so the server never ends up with no AOF.
- **`server.aofState` / `startAppendOnly` (`server.ts`, `aof-rewrite.ts:286`)**: `wait-rewrite` means no AOF is written until a rewrite has produced one. At startup with no AOF but a snapshot, the snapshot is loaded and then rewritten (`server.ts:197`).
- **`aofRewriteCron` (`aof-rewrite.ts:318`, `cron.ts:66`)**: runs a scheduled rewrite first, then auto-rewrite (`needsAutoRewrite`, `:172`). After a failure it waits 5 s, as Redis's `aofRewriteLimited` does.
- **`SnapshotJobOptions.onAbort` (`snapshot-job.ts:158`)**: a flush or a reload aborts a walking rewrite; this makes it start over rather than silently never finish.

## Trade-offs, and what Redis does differently

- **Redis 6** (`aof.c`, `rewriteAppendOnlyFileBackground`) forks a child and streams the rewrite buffer to it through pipes, so the final append is small. Ours keeps the whole buffer in memory until the swap. **Redis 7** has no buffer at all: it starts a new incremental file and swaps a manifest (ADR 0009, 0012).
- **Rule 3 over spec 9.8 step 5.** The reference replies to BGSAVE during a rewrite with `Another child process is active (AOF?)…`, and `BGSAVE SCHEDULE` gets `Background saving scheduled`. SAVE simply runs. We match it.
- **FLUSHALL** stops a BGSAVE even after its walk, but not a rewrite past its walk: its record goes into the buffer, so the result is still exact.
- **`CONFIG SET appendonly yes`** can't fail here: it replies OK and retries. Redis returns an error (`docs/DIFFERENCES.md`).

Tests: `tests/unit/aof-rewrite.test.ts` (6) and `tests/integration/aof-rewrite.test.ts` (11), which cover every "Done when" item. The transfer test runs 20 rewrites under 50 clients and then restarts.

## The single most important line

`aof-rewrite.ts:212`: `detach = server.propagator.attach(buffer);`. Without it, every write made during the rewrite is in the old file but not in the new one, and the swap throws it away. Deleting it fails three tests in `tests/integration/aof-rewrite.test.ts`: "keeps every type, … with writes made during the rewrite", "CONFIG SET appendonly yes writes a file that restores the whole dataset", and the transfer test, where A and B come back from before the last transfers.

## Quiz

1. A rewrite starts. Mid-walk, a client runs `DEL k` on a key the walk hasn't reached. Which records for `k` end up in the new AOF, and in what order?
2. Why may `CONFIG SET appendonly yes` not simply open `appendonly.aof` and start appending, as startup does?
3. The swap closes the old AOF before the rename. The old AOF's buffer may still hold records from this turn. Why aren't they lost, and why aren't they written twice in the new file?

<details>
<summary>Answers</summary>

1. `SET k <old value>` (and its PEXPIREAT), written by the hook into the temp file before the delete. Then `DEL k`, from the rewrite buffer, which is appended after every walked key at the swap. Replaying gives "no k", the current state.
2. Startup trusts an existing AOF over the snapshot. A file holding only the writes since the switch would win at the next start and lose the rest of the dataset. A stale file from an earlier run would replay old data. So the AOF waits (`wait-rewrite`) until a rewrite has written the whole dataset.
3. Every record went to both sinks when it was propagated, so it's already in the rewrite buffer, which was appended to the temp file. `old.close()` writes the same records to the old file, which is about to be replaced, so they land once in the new file.

</details>
