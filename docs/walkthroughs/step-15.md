# Step 15: crash tests

## What this step built

`tests/crash/` starts the built server (`dist/index.js`) in a child process, runs 61 writer clients against it, kills it with SIGKILL at a random moment, and restarts it on the same `dir`. Each restart is checked against what the clients were told before the kill. Six scenarios run `KILLS` cycles each (50 locally, 10 in CI): the AOF under `always`, `everysec` and `no`, snapshots only, a kill during BGSAVE, and a kill during BGREWRITEAOF. No server code changed: the only failures while building it were bugs in the harness. It does fail once write-before-reply is broken (see the last section).

## One real command's path

One writer's `INCR ctr:3` under `appendfsync everysec`, then `kill -9`:

1. The writer loop marks the command in flight (`harness.ts:234`) and sends it. The server runs it and propagates it to the AOF buffer (step 12).
2. In `beforeSleep`, `this.writeAof()` (`src/server/event-loop.ts:55`) calls `Aof.flush`. Its `fs.writeSync` (`src/persistence/aof.ts:121`) puts the bytes in the kernel's page cache. Only after that does the reply go out.
3. The writer reads `:42` and records it as acknowledged (`harness.ts:237`).
4. The test sends SIGKILL (`aof.test.ts:30` → `harness.ts:96`). No shutdown code runs. The fsync scheduled by serverCron may never happen.
5. `CrashServer.start` (`harness.ts:66`) spawns a new process on the same `dir`. `Server.start` removes leftover temp files (`server.ts:193`) and opens and loads the AOF (`server.ts:200`). If the file ends mid-command, it's cut back at the last whole command (`aof.ts:400`).
6. `verify(c, 'acked')` (`aof.test.ts:37` → `harness.ts:164`) requires `ctr:3` to be 42, or 43 if a later INCR was still in flight (`harness.ts:174`).

## Key functions and why each exists

- **`CrashServer` (`harness.ts:66`, `:96`)**: the real entry point in a real process, because SIGKILL is the only honest crash. It waits for `Ready to accept connections tcp`, which is logged only after loading. If the server exits first (a damaged file), the test fails with the server's output.
- **`Workload.run` (`harness.ts:214`)**: three kinds of load whose guarantees are exact. 10 INCR writers each have at most one command in flight. 50 clients run the transfer transaction (`MULTI / DECRBY A n / INCRBY B n / EXEC`). One filler rewrites a hash with one HSET, or a list with `MULTI / DEL / RPUSH / EXEC`, always putting the same value in every field or item.
- **`Workload.verify` (`harness.ts:164`)**: A + B always equals the total. No hash or list has mixed values, which would mean it was half-written. DBSIZE is exact. The counters are checked by durability level: `acked` (AOF: nothing acknowledged is lost), `snapshot` (some point in time at or after the last load), or `unchanged` (a BGSAVE killed before its rename: exactly the previous file).
- **`leftoverTemps` (`kill-during-job.test.ts:92`)**: if a temp file is still on disk after the kill, the job died before its rename. That's how the test knows which durability to expect, and it requires at least half the kills to land mid-job. In local runs, 10/10 BGSAVE kills and 7/10 rewrite kills landed mid-job. A 100,000-key pad makes each job take about 0.8–1 s under load.

## Why all three fsync modes pass, and what fsync is for

SIGKILL ends the process, not the machine. Once `write()` returns, the bytes are in the kernel's page cache, which belongs to the OS and not to the process. The kernel writes them to disk later whether or not the process is alive. So under SIGKILL, `no` is as safe as `always`. The only things lost are writes still in MiniRedis's own memory, which rule 8 forbids for anything already acknowledged. fsync protects against a different failure: power loss or a kernel panic, when the page cache itself is lost. Then `always` loses nothing acknowledged, `everysec` up to about a second, and `no` whatever the OS hadn't flushed (often about 30 s on Linux). A test can't cut the power, so this suite proves rule 8 and the file-replacement order, and the fsync code is checked by the step 12 `fsyncSync` spy.

## Trade-offs, and what Redis does differently

Redis's `tests/integration/aof.tcl` and `rdb.tcl` mostly build damaged files by hand and check that loading them works or fails. `tests/unit/other.tcl` and `aof-multi-part.tcl` restart under load. Redis can also slow its child down with `rdb-key-save-delay`, so a kill lands mid-job every time. We have no such knob, so we pad the keyspace and time the kills, and the test reports how many landed mid-job. `SEED` replays the kill delays and the filler's choices, but not the exact moment the OS schedules each kill, so a crash run can't be replayed byte for byte the way the differential test can.

Also fixed: `tests/integration/aof-rewrite.test.ts` checked `TTL > 990` after a test that takes over 10 s under the full suite. It now allows exactly the elapsed time.

## The single most important line

`src/server/event-loop.ts:55`, `this.writeAof();` before the reply loop. Moving it after the replies (tried with `setTimeout(() => this.writeAof(), 50)`) fails all three `tests/crash/aof.test.ts` cases with `ctr:0 lost an acknowledged write`. That's rule 8, proven by a real kill.

## Quiz

1. A writer's last INCR was sent but never answered when the server died. Why is either value (acknowledged or acknowledged + 1) correct after a restart?
2. Under `appendfsync no`, the suite never loses a write. Name the failure in which `no` would lose acknowledged writes and `always` wouldn't.
3. During a kill mid-BGSAVE, how does the test know whether to expect exactly the old data or possibly newer data?

<details>
<summary>Answers</summary>

1. The server may have run the INCR and written it to the AOF, then died before the reply reached the client, or died before running it at all. The client can't tell which, so both are valid outcomes. Real Redis clients have the same ambiguity and need idempotent retries.
2. Power loss or a kernel crash: the page cache is gone, so bytes that were `write()`n but not fsynced are lost. Under `always`, every acknowledged write was fsynced before its reply.
3. It looks for a `temp-*` file on disk after the kill. A file still there means the job died before `renameSync` (`snapshot-job.ts:420`), so `dump.mrdb` is untouched and must load exactly as before. No file means the rename happened, and a newer point in time is allowed.

</details>
