# Step 21: Replication, the replica side

## What this step built

MiniRedis can now follow a primary. `REPLICAOF host port`, or `replicaof` in the config, opens a link. The link goes through the handshake (PING, AUTH, two REPLCONFs, PSYNC) and loads a full-sync payload into fresh databases, or continues with `+CONTINUE`. It then applies the stream through the normal dispatcher, with an offset that counts exactly the bytes applied, and ACKs once a second. A replica is read-only, hides expired keys until its primary's DEL arrives, and on `REPLICAOF NO ONE` becomes a primary that the old primary's other replicas can continue from (`src/replication/replica.ts`, ADR 0015).

## One real command's path

A client runs `SET k v` on the primary while a MiniRedis replica is online:

1. The primary streams `*3\r\n$3\r\nSET…` (step 20). On the replica it arrives at `PrimaryLink.onData` (`src/replication/replica.ts:256`). The link is streaming, so it goes to `applyStream` (`replica.ts:478`), which feeds the client's parser and keeps the raw bytes (`replica.ts:483`).
2. The parser yields `{ argv, bytes }`, and `bytes` joins the uncommitted count (`replica.ts:488`). `dispatch` takes the obeyed path (`src/commands/dispatch.ts:86`), with no READONLY, OOM or MISCONF check. `call` records the link as `server.currentClient` (`dispatch.ts:198`) and runs `setCommand`.
3. SET's propagation record reaches the replica's AOF. `Replication.append` ignores it (`src/replication/primary.ts:134`), because the backlog takes the primary's own bytes instead.
4. The reply is thrown away (`replica.ts:491`). Not in MULTI, so `commit` (`replica.ts:508`) slices exactly `bytes` raw bytes into `feedFromPrimary` (`primary.ts:159`): the backlog and `masterReplOffset` grow.
5. Within a second, `cron` (`replica.ts:528`) calls `sendAck` (`replica.ts:518`). The primary's `ack` (`primary.ts:411`) records the offset and releases any WAIT that needed it.

## Key functions and why each exists

- **`setPrimary` / `unsetPrimary`** (`replica.ts:122`, `replica.ts:150`): REPLICAOF. Following a primary drops any old link, disconnects our own replicas and sets `role` (the logs switch to `S`). Promotion is `shiftReplid` (`primary.ts:317`): the old ID becomes replid2, valid up to `offset + 1`.
- **`readLines` / `onLine`** (`replica.ts:271`, `replica.ts:296`): the handshake as a state machine over reply lines, skipping keepalive newlines. A `-NOAUTH` answer to PING is accepted, since AUTH comes next. REPLCONF errors are "non critical". `-NOMASTERLINK` means "retry later".
- **`psyncArgs`** (`primary.ts:328`): our history if we have a backlog (a replica's, or a primary's own), else `? -1`.
- **`readPayload` / `loadPayload`** (`replica.ts:412`, `replica.ts:426`): collect `$<len>` bytes as they arrive (never allocated up front). Check them with `readSnapshot(…, { now: null })` (`replica.ts:434`), which keeps expired keys for the primary's DELs. Only then abort any job, swap the databases in, take the primary's history (`setPrimaryHistory`, `primary.ts:301`) and rewrite the AOF.
- **`linkLost`** (`replica.ts:234`): remembers the stream's db, since `+CONTINUE` resends no SELECT, then reconnects at once, as Redis 7 does.
- **`Db.expireIfNeeded`** (`src/storage/database.ts:333`): on a replica an expired key is hidden but kept. The primary link still sees it (`database.ts:337`), because the primary may not have expired it yet.

## Trade-offs, and what Redis does differently

- **Load, then swap.** Redis (`replication.c`: `readSyncBulkPayload`) by default writes the RDB to disk, flushes the old data and loads, so a bad payload leaves it empty. We parse into fresh databases in memory and swap only after the CRC matches.
- **Restarts sync fully.** Redis stores the replication ID and offset in the RDB's aux fields (`rdbPopulateSaveInfo`), so a restarted replica can continue. Our snapshot doesn't, so it sends `PSYNC ? -1`.
- **No chains.** Redis replicas serve their own replicas from the same backlog. Ours refuse PSYNC (DIFFERENCES.md), although the backlog is there, which is what promotion uses.
- **Cached master.** Redis keeps the master `client` struct across reconnects (`replicationCacheMaster`). We keep only what matters, the offset, the backlog and the db, in `Replication` and `streamDb`.

## The single most important line

`replica.ts:493`: `if (!client.multi) this.commit();`. Bytes join the offset and the backlog only once their command has run outside a transaction. If it commits after every command instead, a link dropped between MULTI and EXEC PSYNCs from after the queued commands. Those commands died with the link client, so the transaction would be lost. With the guard removed, "counts a transaction only at EXEC, so a link dropped mid-MULTI resumes at MULTI" in `tests/integration/replication-replica.test.ts` fails (checked by removing it).

## Quiz

1. Why does the replica keep the raw bytes it received for its backlog, instead of re-encoding each `argv` with `encodeCommand`?
2. On a replica, a client's `GET k` returns nil although `DBSIZE` still counts `k`. The primary then sends `APPEND k x`. What happens to `k`, and why?
3. In the promotion test, the primary is stopped before `REPLICAOF NO ONE`. What could make replica 2's PSYNC to replica 1 fall back to a full sync if the primary kept running?

<details>
<summary>Answers</summary>

1. The backlog must match the primary's stream byte for byte (spec 9.5), because offsets are byte counts that replicas, WAIT and promotion compare. The parser's `bytes` includes blank lines before a command and counts the primary's encoding, whatever it was. A re-encoding could differ from what was sent, and then every offset after it would be off.
2. It becomes `vx`, and the TTL stays. For the primary link, `expireIfNeeded` returns false (`database.ts:337`): the key is still live on the primary, whose clock may be behind ours. The primary will send DEL when it expires the key. Clients keep seeing nil until a PERSIST or a new value arrives.
3. The PINGs and GETACKs a running primary keeps sending. If replica 2 had applied a PING that replica 1 hadn't, replica 2's offset would be past replica 1's. Then `PSYNC <old id> <offset + 1>` would ask for more than replica 1's `secondReplidOffset` vouches for, and it would get a full sync. Stopping the primary first leaves both with the same bytes.

</details>
