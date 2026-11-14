# Step 23: Observability and shutdown

## What this step built

The server can now be looked at while it runs and stopped without losing data. INFO has every section of spec 13.1, SLOWLOG keeps the slow commands, MONITOR streams other clients' commands (credentials redacted), CLIENT LIST/INFO describe each connection, and `/metrics` serves Prometheus text on `metrics-port`. SHUTDOWN, SIGTERM and SIGINT now save first when save points exist, and stay up if the save fails.

## One real command's path

`DEBUG SLEEP 0.02` from a client while another client runs MONITOR:

1. `Server.onData` (`src/server/server.ts`) parses it and `dispatch` (`src/commands/dispatch.ts:60`) passes the checks, then `call` runs it.
2. `call` stamps `client.lastCommand` before the handler (so CLIENT INFO shows the running command), takes `startMs` and the hrtime, and runs `debugCommand` (`src/commands/debug.ts:140`), which blocks for 20 ms.
3. Back in `call`, step 9 records `commandStats`, then `server.slowlog.pushIfNeeded` (`src/observability/slowlog.ts`) logs it because 20,000 µs ≥ `slowlog-log-slower-than`, with the argv passed through `redactArgv`.
4. `feedMonitors` (`src/observability/monitor.ts`) skips it: DEBUG is `admin`. For a non-admin command it formats one line and queues it on every monitor with `server.queueReply`, so it leaves in the same `beforeSleep` as everything else.
5. `SLOWLOG GET` (`src/commands/server.ts`, `slowlogGetCommand`) replies newest first from `SlowLog.newest`.

## Key functions and why each exists

- **`SlowLog.pushIfNeeded` / `trimArgs`**: keep a bounded copy of the arguments (32 args, 128 bytes each) so one huge SET can't pin its value in the log.
- **`redactArgv`**: one place that hides AUTH and HELLO ... AUTH credentials; SLOWLOG and MONITOR both use it (spec 12).
- **`feedMonitors`**: builds the line once, only when a monitor exists, after the command ran (as Redis 7 does).
- **`clientInfoLine`**: one pure function for CLIENT LIST and CLIENT INFO, so the field order lives in one place.
- **`genInfoString` / `SECTIONS`**: each section is a function of the Server; `INFO a b` and `INFO all` share it.
- **`renderMetrics` / `MetricsServer`**: reads Server state; a scrape never walks the keyspace.
- **`shutdownServer`** (`src/server/shutdown.ts`): the fallible steps first, then closing (ADR 0018).
- **`Server.sampleOps`**: the 16-sample average behind `instantaneous_ops_per_sec`.

## Trade-offs, and what Redis does differently

- INFO has only spec 13.1's sections; Redis has commandstats, errorstats and more (`server.c`: `genRedisInfoString`).
- SHUTDOWN doesn't wait for replicas (`shutdown-timeout`, `server.c`: `finishShutdown`).
- `/metrics` has no Redis counterpart; it is ours. Everything is in `docs/DIFFERENCES.md`.
- Redis feeds monitors from `call()` in `server.c` after the command; so do we, which is why `SELECT 3` shows db 3.

## The single most important line

`if (!shutdownServer(server)) { ... stopping = false; }` in `src/index.ts`, together with the early `return false` after a failed `saveSnapshot` in `shutdown.ts`. Deleting the check makes a failed save exit anyway; "a failing save keeps the server up" in `tests/integration/observability.test.ts` fails.

## Quiz

1. Why does MONITOR show the AUTH line as `"AUTH" "(redacted)"` but the slow log must also redact it?
2. Why is `client.lastCommand` set before the handler runs?
3. Why does `Server.close()` never save, when SHUTDOWN does?

<details>
<summary>Answers</summary>

1. Both are logs a reader other than the client can see (spec 12). If only MONITOR redacted, `SLOWLOG GET` would show the password to any admin. `redactArgv` is called for both.
2. CLIENT INFO describes the client that asked, and its `cmd=` field should be `client|info`, the command running, as Redis's `lastcmd` is. Setting it after would show the previous command.
3. Tests and other callers stop servers with `close()` constantly and must not write snapshots into their directories; the save belongs to the "shut down for good" path, and has to run before anything is closed so it can fail safely.

</details>
