# ADR 0012: AOF rewrite through the snapshot engine, a rewrite buffer, and waiting for it before an AOF exists

**Status:** accepted (step 14)

## Context

Spec 9.7 rewrites the single-file AOF (ADR 0009) in the background. Redis 6 did this with a forked child writing the dataset, plus a rewrite buffer in the parent that collected every write made meanwhile and appended it to the child's file before the rename. Redis 7 avoids the buffer: it opens a new incremental file and swaps a manifest. We have neither fork nor a manifest. We do have the copy-on-write engine from step 13 (ADR 0010).

Turning the AOF on is the dangerous moment. Startup prefers the AOF over the snapshot whenever an AOF file exists (spec 9.9). If `CONFIG SET appendonly yes` simply opened `appendonly.aof` and started appending, a crash before the rewrite finished would leave a file holding only the newest writes. The next start would load that and ignore the snapshot, losing everything else. A file left behind by an earlier run with the AOF on is just as bad: appending to it would replay stale data underneath the new writes.

## Decision

- **The rewrite is a snapshot job** with a command sink (`AofCommandWriter`): SET, RPUSH, SADD, HSET, ZADD with at most 64 items each, then PEXPIREAT. The hook and the walk give the point-in-time copy (rule 9), as for BGSAVE. The file sink is shared: an encoder plus a commit step (`FileSnapshotSink`, `FileCommit`).
- **A rewrite buffer** (`RewriteBuffer`), a propagation sink attached in the same synchronous step that starts the job. Every write after the start goes both to the live AOF and to the buffer. Its first record carries a SELECT.
- **The swap is one synchronous step** after the temp file's async fsync: append the buffer → fsync → detach the buffer → close the old AOF (which writes what it still buffers) → rename → fsync the directory → open the new file as the AOF, with `baseSize` = its size. No record can arrive in the middle, so the file is the snapshot plus every later write, in order. If the rename fails, the old file is reopened and keeps taking writes.
- **Wait-rewrite** (`server.aofState`, Redis's `AOF_WAIT_REWRITE`): turning the AOF on, at runtime or at a start with a snapshot and no AOF, opens no AOF until a rewrite has produced one holding the whole dataset. Until then writes go only to the rewrite buffer. A failed attempt is retried by serverCron after 5 seconds.
- **Aborts reschedule.** FLUSHDB, FLUSHALL (while walking), DEBUG RELOAD and DEBUG LOADAOF abort the job (spec 9.8 step 4). A rewrite then schedules itself again, unless the AOF was turned off. FLUSHALL no longer aborts a rewrite that is past its walk: the FLUSHALL record reaches its buffer like any other write.
- **Replies match Redis 7.4** (checked against the reference). This means two departures from spec 9.8 step 5. BGSAVE during a rewrite gets `Another child process is active (AOF?)…`, and is scheduled with SCHEDULE. SAVE runs beside a rewrite.

## Consequences

- One engine and one file sink serve BGSAVE and the rewrite. The full sync in step 20 adds only a memory sink.
- The buffer costs memory in proportion to the writes made during the rewrite, as in Redis 6. Records are stored once per sink, so a write during a rewrite is encoded twice.
- While the AOF waits for its first rewrite, acknowledged writes aren't on disk yet. Redis has the same window.
- The hook serialises a big value all at once, so changing a huge key mid-rewrite costs one pause the size of that key, as for BGSAVE (ADR 0010).
