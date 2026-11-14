# Step 20: Replication, the primary side

## What this step built

A replica can now sync from MiniRedis. With `PSYNC ? -1` it gets `+FULLRESYNC <replid> <offset>`, a snapshot made by the copy-on-write engine with a memory sink, and then the live stream. If it reconnects with `PSYNC <replid> <offset>` while the bytes it missed are still in the backlog, it gets `+CONTINUE` and exactly those bytes. The stream is one more propagation sink, `src/replication/primary.ts`, feeding a ring-buffer backlog (`src/replication/backlog.ts`, ADR 0014). Around it are REPLCONF, WAIT, ROLE, CLIENT KILL, heartbeat PINGs, keepalive newlines, replica timeouts, the `replica` output limit, and INFO's `# Stats` and `# Replication` sections.

## One real command's path

A client runs `SET k v` with one replica online, then `WAIT 1 0`:

1. `call` runs SET's handler, then `propagator.end` (`src/commands/dispatch.ts:204`) emits its record (`src/server/propagate.ts:124`) to every sink.
2. `Replication.append` (`src/replication/primary.ts:116`) encodes it, with a SELECT first if the stream was in another db. `feed` (`primary.ts:131`) writes it into the ring (`src/replication/backlog.ts:57`), grows `masterReplOffset`, and adds it to the turn's bytes.
3. Back in `call`, the offset grew, so `client.woff` takes the new value (`dispatch.ts:206`).
4. `WAIT 1 0` goes through `waitCommand` (`src/commands/replication.ts:61`) to `Replication.wait` (`primary.ts:366`). No replica has acknowledged `woff` yet, so the client blocks (`client.bwait`) and a GETACK is requested.
5. `beforeSleep` runs in spec order. `requestAcks` (`src/server/event-loop.ts:60` → `primary.ts:153`) feeds `REPLCONF GETACK *` into the stream. Then comes the AOF write (`event-loop.ts:61`), then `writeReplicas` (`event-loop.ts:62` → `primary.ts:160`). Its `flushStream` (`primary.ts:138`) gives the turn's bytes to each online replica, and they go out in one corked write.
6. The replica answers `REPLCONF ACK <offset>`, which `replconfCommand` (`replication.ts:27`) hands to `ack` (`primary.ts:343`). It records the offset, re-checks the WAIT clients and replies `:1`. Then the client's pipelined input runs.

## Key functions and why each exists

- **`ReplicationBacklog`** (`backlog.ts`): a fixed `Buffer` used as a ring, plus the offset of its last byte. `contains(o)` is the whole partial-sync test (`firstByteOffset ≤ o ≤ endOffset + 1`). `readFrom` copies out the missed bytes, and `resize` keeps the newest bytes when `repl-backlog-size` changes.
- **`Replication.psync`** (`primary.ts:187`): flushes the turn first, then tries `tryPartialResync` (`primary.ts:208`): the replid or replid2 must match, and the offset must be in the backlog. Otherwise the replica waits in `wait_bgsave_start`. The first PSYNC calls `createBacklog` (`primary.ts:254`), which, as in Redis, also picks a new replid.
- **`startFullSync`** (`primary.ts:279`): one `fullsync` job for every replica waiting, if no job is running. serverCron retries it every tick. It resets the stream's SELECT tracking (`primary.ts:286`), and each waiting replica gets `+FULLRESYNC` with `job.replOffset`, the offset at the job's first instant.
- **`fullSyncDone`** (`primary.ts:306`) sends `$<len>\r\n`, the snapshot, then the stream queued since `+FULLRESYNC`, and marks the replica online. **`dropSyncing`** (`primary.ts:334`) disconnects the replicas of an aborted job: FLUSHALL, DEBUG RELOAD or shutdown.
- **`cron`** (`primary.ts:418`): every tick, start a waiting full sync. Once a second: PING every `repl-ping-replica-period`, `\n` to replicas still waiting, drop replicas silent past `repl-timeout`, and check soft limits.
- **`checkOutputLimits`** (`primary.ts:455`): what is still queued for a replica, plus what Node's socket buffers (`writableLength`), against the `replica` class's hard and soft limits. Step 22 extends it to the other classes.
- **`Server.killClient`** and the "Replica generated a reply" check in `processInput` (`src/server/server.ts`). A replica must never get a reply, so one whose command produced a reply is dropped, as in Redis (checked against the reference).

## Trade-offs, and what Redis does differently

- **Snapshot in memory.** Redis forks. By default (`repl-diskless-sync yes`) the child streams the RDB through a pipe to the replicas' sockets as `$EOF:<mark>`; otherwise it writes `dump.rdb` and sends `$<len>` (`replication.c`: `startBgsaveForReplication`, `rdb.c`: `rdbSaveToSlavesSockets`). We build the whole snapshot in memory with the copy-on-write engine, then send `$<len>`. That costs memory the size of the payload until it's written, but no disk.
- **Late replicas wait.** Redis attaches a replica that arrives during a disk BGSAVE to it when it can. We make it wait for the next job (spec 9.8), sending `\n` every second so the link stays up.
- **One copy per write.** Redis 7 shares reply blocks between the backlog and every replica (`replicationFeedSlaves` with the `repl_buffer_blocks` list). We encode once into a string and write it into the ring. Once per turn, one `Buffer` from that string goes to every online replica.
- **The backlog is never freed** (ADR 0014). Redis frees it after `repl-backlog-ttl`.
- **`redis-cli --replica`** doesn't work yet. It uses the old `SYNC` command and `REPLCONF rdb-filter-only`, which spec 8.10 doesn't include.

## The single most important line

`primary.ts:146`: `link.pending.push(data);`. While a replica's snapshot is being made, every byte of stream produced after its `+FULLRESYNC` offset is kept for it, then sent right after the snapshot. Without it, the snapshot holds the data as of the offset, the stream resumes later, and every write in between is lost. Deleting the line fails "rebuilds the primary exactly from the payload plus the stream, under concurrent writes" in `tests/integration/replication-primary.test.ts`: the replica's offset never reaches the primary's (checked by deleting it).

## Quiz

1. Why does `psync` call `flushStream()` before it decides between a partial and a full sync?
2. A client runs `MULTI`, `SET k v`, `WAIT 1 1000`, `EXEC`, with one replica online that hasn't acknowledged anything since the SET. What's in the EXEC reply, and why doesn't it wait?
3. A replica sends `PSYNC ? -1` while an AOF rewrite is running. What does it receive, and when?

<details>
<summary>Answers</summary>

1. `feed` puts each record into the backlog and the offset at once, but hands it to the replicas only at the end of the turn. Bytes from earlier in this turn are already in the backlog. A continuing replica gets them from `readFrom`, so it would get them a second time when the turn is flushed. For a full sync, the snapshot already holds their effect, so queueing them would apply them twice. Flushing first sends them only to the replicas that were online before this PSYNC.
2. `[OK, 0]`. Inside a transaction a client can't block (`denyBlocking`, Redis's `CLIENT_DENY_BLOCKING`): EXEC must answer at once. So WAIT replies with the number of replicas that have already acknowledged `woff`, which is 0. In Redis 7.4, `WAIT` inside MULTI returns `0` the same way (checked against the reference).
3. At first, nothing but a bare `\n` every second: one job at a time (spec 9.8), so it sits in `wait_bgsave_start`. On the first serverCron tick after the rewrite ends, `startFullSync` starts a `fullsync` job. The replica then gets `+FULLRESYNC <replid> <offset at that instant>`, more newlines if the job takes a while, `$<len>\r\n` and the snapshot, and then the stream from that offset on.

</details>
