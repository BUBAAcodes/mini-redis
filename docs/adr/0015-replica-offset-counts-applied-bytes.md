# ADR 0015: A replica's offset counts applied bytes, and its backlog holds them raw

**Status:** accepted (step 21)

## Context

A replica ACKs its offset every second, PSYNCs from `offset + 1` after a lost link, and, once promoted, serves the other replicas' PSYNCs from its own backlog (spec 9.13). All three only work if the offset names exactly the bytes the replica has applied, and if its backlog holds the same bytes the primary sent (spec 9.5: "its backlog is fed the raw bytes received from the primary, so its offsets match the primary's byte for byte"). Four questions follow: what to count, when, where the bytes come from, and which db the stream resumes in.

Bytes received aren't the same as bytes applied. A chunk can end in the middle of a command. It can also end between a MULTI and its EXEC. The queued commands then haven't changed anything, and they are dropped if the link drops before EXEC arrives. Redis handles this in `commandProcessed`. It moves the master client's `reploff` only after a command ran outside MULTI. Then `replicationFeedStreamFromMasterStream` copies exactly those query-buffer bytes (`repl_applied`) into the backlog.

## Decision

- **Counted after the command, outside MULTI.** `src/replication/replica.ts` adds each parsed command's `bytes` (spec 10.1, blank lines included) to an uncommitted count. Once the command has run and the link client isn't in MULTI, the count is committed. So a transaction commits at its EXEC, all at once.
- **The raw bytes, not a re-encoding.** Every received chunk is also kept as a latin1 string. A commit slices exactly the committed bytes off its front and hands them to `Replication.feedFromPrimary`. That appends them to the backlog and adds their length to `masterReplOffset`, which is the replica's processed offset. The primary's own encoding is what goes in, so it matches whatever the primary sent (even if it wasn't the canonical `*n $len` form).
- **The propagator's records don't reach the stream on a replica.** `Replication.append` returns at once there. The replica's AOF still gets the records through propagation, as spec 9.5 says.
- **The db survives a reconnect.** A partial resync resends no SELECT. So when the link drops, the link client's db is remembered, and the next link client starts in it after `+CONTINUE`, as Redis keeps its cached master client. After `+FULLRESYNC` it starts in db 0, because the primary's stream begins with a SELECT.

## Consequences

- A link that drops between MULTI and EXEC resumes at the MULTI, and the transaction is applied once, whole. The test "counts a transaction only at EXEC" checks the PSYNC offset and the final data.
- ACKs never overstate what the replica holds, so WAIT's count is honest. An ACK in answer to `REPLCONF GETACK` doesn't count the GETACK itself, which matches Redis.
- Received bytes are held twice until they're applied: once in the parser and once in the string. Both shrink as commands run, so the cost is one unparsed command at most, or one open transaction.
- A promoted replica's backlog is the old primary's stream byte for byte. The other replicas, holding the same bytes, get `+CONTINUE` from it.
