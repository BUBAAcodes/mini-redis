# Step 12: AOF

## What this step built

`src/persistence/aof.ts`: the first real propagation sink. It buffers every record as RESP, writes the buffer once per event-loop turn before any reply, and fsyncs it under `always` (one fsync per turn) or from serverCron under `everysec`. The loader replays the file at startup and for DEBUG LOADAOF through the normal dispatcher, on a socketless client, with propagation, expiry, stats and blocked-client serving switched off. It truncates a cut-off tail and refuses anything else malformed, naming its byte offset. A failed write makes writes and PING answer `-MISCONF` until a retry succeeds, and under `always` it is fatal.

## One real command's path

`SET a 1` with `appendonly yes` and `appendfsync always`:

1. `dispatch` passes its checks. The disk-error check (`dispatch.ts:85`) finds `aof.error` null. `call` (`dispatch.ts:146`) runs `setCommand` (`strings.ts:132`), whose `db.setKey` reaches `signalModifiedKey`, so `server.dirty++` (`database.ts:251`).
2. Step 10: `dirty` grew and SET is a write, so `propagator.end` (`dispatch.ts:185`, `propagate.ts:91`) emits `{ db: 0, argv }` (`propagate.ts:95`). `emit` hands it to each sink (`propagate.ts:121`) and schedules beforeSleep.
3. `Aof.append` (`aof.ts:96`) sees db 0 differ from `lastDb` (-1 after startup), so it adds `SELECT 0`, then `*3 $3 SET $1 a $1 1`, to its string buffer. Nothing touches the disk yet.
4. `processInput` queues the client's `+OK` (`server.ts:304`).
5. In beforeSleep (`event-loop.ts:48`), the AOF goes first (`event-loop.ts:55`). `Aof.flush` (`aof.ts:107`) turns the buffer into one Buffer and loops `writeSync` until all of it is written (`aof.ts:112`), then calls `fsyncSync` (`aof.ts:126`). Only then does `writeClient` send `+OK` (`event-loop.ts:56`). That's rule 8.

After a restart, `Server.start` creates `dir` (`server.ts:153`), and `openAof` (`server.ts:209`) runs `loadAof` (`aof.ts:252`). It feeds 1 MB chunks to a multibulk-only `RespParser`. Each command is checked (`aof.ts:294`), then run with `dispatch` (`aof.ts:296`) on the AOF client, which skips every client check (`dispatch.ts:77`). Only then does the listener open.

## Key functions and why each exists

- **`Aof.append` / `flush` (`aof.ts:96`, `:107`)**: buffering separates "the command changed data" from "the bytes are on disk". So a 1,000-command pipeline costs one `writeSync` and, under `always`, one fsync (group commit).
- **`Aof.writeFailed` (`aof.ts:181`)**: a short write is cut back with `ftruncate` (`aof.ts:193`), so the file never ends in half a command. The buffer is kept and retried, from beforeSleep and from `Aof.cron` (`aof.ts:142`), so recovery happens even when no client is writing. It's also where `always` becomes fatal (ADR 0009).
- **`Aof.cron` / `backgroundFsync` (`aof.ts:142`, `:216`)**: the `everysec` fsync runs on libuv's thread pool, at most one at a time, only when bytes were written since the last one. Its callback only sets flags.
- **`loadAof` (`aof.ts:252`)**: tracks `offset` (the end of the last complete command) and `beforeMulti`. A tail cut mid-command (`parser.pending`) or an unfinished MULTI is truncated by `truncateTail` (`aof.ts:375`). A `ProtocolError` or an unknown command is fatal, with its offset.
- **`server.loading`**: lazy expiry is off (`database.ts:183`), because the file already holds the DEL for every key that expired. Stats are off, and blocked clients aren't served mid-replay (`dispatch.ts:191`). The propagator is paused (`propagate.ts:116`), so a replay never writes itself back.
- **`Client.denyBlocking`**: a BLPOP in the file must not wait. The same rule already covered MULTI (`lists.ts:246`).
- **`reloadAof` (`aof.ts:325`)**: DEBUG LOADAOF. It flushes first, empties every db (touching WATCH), then loads. As in Redis 7.4 (checked on a throwaway `redis:7.4`), a missing or damaged file replies `ERR Error trying to load the AOF files, check server logs.`, keeps whatever loaded before the damage, and the server stays up.

## Trade-offs, and what Redis does differently

- **Layout.** Redis 7's `aof.c` keeps a directory with a manifest, a base file and incremental files. We keep one file, as Redis 6 did (ADR 0009). Step 14's rewrite must therefore buffer writes in memory during the job.
- **Postponed writes.** Under `everysec`, Redis's `flushAppendOnlyFile` holds a write back for up to 2 s while a bio fsync is still running. We always write at once (`docs/DIFFERENCES.md`).
- **Loading.** Redis's `loadSingleAppendOnlyFile` reads with `fgets`/`fread` and calls each handler directly on a fake client. We go through `dispatch`, so MULTI/EXEC replay through the same code that produced them. The cost is a few flag checks per command.
- **MISCONF.** Like Redis's `writeCommandsDeniedByDiskError`, it covers writes, PING, and an EXEC whose queue holds a write. The reason text comes from a small strerror table (`utils/errno.ts`).
- **Not yet:** a rewrite, `CONFIG SET appendonly` at runtime (step 14), loading a snapshot when there's no AOF (13), and INFO's persistence fields (23).

Tests: `tests/unit/aof.test.ts` has 19 tests: encoding, SELECT tracking, each fsync policy, short and failed writes, fatal under `always`, loading, truncation and damaged files. `tests/integration/aof.test.ts` has 12, covering every "Done when" item. Parser and errors tests cover the multibulk-only mode.

## The single most important line

`event-loop.ts:55`: `this.writeAof();`. Without it, records pile up in the buffer and reach the disk only at a clean shutdown. A `kill -9` loses everything, and replies go out with nothing written (rule 8). Deleting it fails 5 tests in `tests/integration/aof.test.ts`, starting with "appends each write as the propagated record" and "with appendfsync always, the fsync comes before the reply is written". The restart test still passes, which shows why: `close()` flushes the buffer itself.

## Quiz

1. The AOF ends with `MULTI`, `SET b 2`, and half of `SET c 3`. With `aof-load-truncated yes`, where is the file cut, and is `b` set after startup?
2. Why must lazy expiry be off while loading? Give a sequence of records whose replay would build the wrong value if it weren't.
3. Under `everysec`, `writeSync` fails with ENOSPC on one turn. What happens to that turn's replies, the next SET, the next GET, and the buffered bytes once space is freed?

<details>
<summary>Answers</summary>

1. Before the `MULTI`. The cut tail leaves the AOF client in MULTI, so `truncateTail` gets `beforeMulti` rather than `offset` (`aof.ts:302`). The queued `SET b 2` never ran, so `b` isn't set, and the transaction stays all-or-nothing.
2. The file is history: every key that expired got its `DEL` written at the moment it expired. Take `SET k v PXAT <t>`, then `PERSIST k`, written just before `t`. Replayed after `t` with lazy expiry on, `PERSIST` would find `k` expired and delete it, while the original server kept `k` forever. Redis's `keyIsExpired` also returns false while loading.
3. The commands already ran, so their replies go out. Redis does the same, and the AOF can't un-run them. The error is logged with `#`, `aof.error` becomes "No space left on device", and the next SET (and PING) gets `-MISCONF Errors writing to the AOF file: No space left on device`. GET still works. The buffer is kept, and `Aof.cron` retries it every tick. The first successful write clears the error and logs "AOF write error looks solved".

</details>
