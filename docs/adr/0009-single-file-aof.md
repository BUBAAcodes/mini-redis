# ADR 0009: One AOF file, written once per turn, never left with half a command

**Status:** accepted (step 12)

## Context

Since 7.0, Redis keeps its AOF as a directory (`appenddirname`) with a manifest, a base file (often an RDB preamble) and incremental files. A rewrite starts a new incremental file and swaps the manifest, so no rewrite buffer is needed. Before 7.0 Redis used one file, and a rewrite buffered new writes in memory until it could append them to the rewritten file. Spec 9.6, 9.7 and 11.1 describe the single file. The snapshot format isn't RDB (spec 11.2), so there is no RDB preamble to share with Redis anyway.

A write can also fail partway: `writeSync` may return fewer bytes than asked, and the next call throws (ENOSPC, EIO). Left alone, the file would end in half a command. The next startup would treat that as a cut-off tail (spec 9.6, Loading, step 3) and drop it only if `aof-load-truncated yes`, and every later write would be appended after the broken bytes, which makes the file unloadable.

## Decision

- **One file**, `dir/appendfilename`, holding exactly the propagated records as RESP arrays (spec 11.1), opened with `O_APPEND`. Step 14's rewrite will buffer writes during the job and swap the file in one synchronous step (spec 9.7.4).
- **One write per event-loop turn.** `propagate()` only appends to a string buffer. beforeSleep writes it all with `writeSync`, before any reply, then calls `fsyncSync` once under `always`, so the turn's commands share one fsync (group commit). `everysec` uses async `fs.fsync` from serverCron.
- **Short writes are cut back.** On a failed write that got partway, `ftruncateSync(fd, sizeBefore)` removes the partial bytes, the whole buffer is kept, and the write is retried every turn and every cron tick. If `ftruncate` also fails, the written prefix is counted and only the rest is retried, so nothing is written twice. This is Redis's own `flushAppendOnlyFile` logic.
- **Under `always`, a failed write or fsync is fatal**, as in Redis: the server has promised that every acknowledged write is on disk. Otherwise writes (and PING) get `-MISCONF` until a write succeeds.

## Consequences

- No manifest to load or keep consistent. A file copied out of `dir` is a complete, replayable history.
- The AOF can't be read by Redis's tools (`redis-check-aof` expects the 7.x layout), and Redis 7 can't load ours as an AOF directory. That's acceptable because the snapshot isn't RDB either (`docs/DIFFERENCES.md`).
- The rewrite (step 14) must keep a rewrite buffer in memory for the whole job, like Redis 6. A long rewrite under heavy writes costs memory in proportion to the writes made during it.
- One `writeSync` per turn blocks the thread for the time the kernel takes to copy the bytes. Under `everysec` Redis also delays a write for up to 2 seconds while a background fsync is still running (`aof_flush_postponed_start`), to avoid stalling on a busy disk. We always write; see `docs/DIFFERENCES.md`.
