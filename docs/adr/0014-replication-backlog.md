# ADR 0014: The replication backlog is a ring created on the first PSYNC and never freed

**Status:** accepted (step 20)

## Context

A replica that loses its link for a moment should get back only the bytes it missed (`PSYNC <replid> <offset>` → `+CONTINUE`), not a whole new snapshot. So the primary keeps the newest part of the replication stream, with each byte's offset (spec 9.13). Three questions follow: what holds the bytes, when to start keeping them, and when to stop.

Redis 6 kept a fixed ring buffer of `repl-backlog-size` bytes (`createReplicationBacklog`, `feedReplicationBacklog`). Redis 7 replaced it with a list of reply blocks that the backlog and every replica's output buffer share. Both versions create the backlog when the first replica connects, and give the server a new replication ID at that moment, since no replica can hold history from before it. Both free the backlog after `repl-backlog-ttl` seconds (default 3600) with no replicas. The reference server shows this: `INFO replication` reads `repl_backlog_active:0` while `master_repl_offset` stays where it was.

## Decision

- **A ring.** `src/replication/backlog.ts` is one `Buffer` of `repl-backlog-size` bytes, a write position and a byte count. Each record is written in with `Buffer.write(…, 'latin1')`, wrapping at the end. Nothing is allocated per record. `endOffset` is the offset of the last byte (`master_repl_offset`), `firstByteOffset` is `endOffset − histlen + 1`, and a replica can continue from offset `o` when `firstByteOffset ≤ o ≤ endOffset + 1`. `CONFIG SET repl-backlog-size` copies the newest bytes that fit into a new ring.
- **Created on the first PSYNC**, with a new replid and an empty replid2, as Redis does. The replication stream attaches to the propagator at the same moment, so a server that never has a replica pays nothing per write. Until then `master_repl_offset` stays at 0.
- **Never freed** (spec 9.13). We have no `repl-backlog-ttl`. Once a replica has connected, the backlog keeps every write, whether or not a replica is attached.

## Consequences

- A replica that comes back after hours can still continue if fewer than `repl-backlog-size` bytes were written meanwhile. In Redis it would get a full sync once the TTL freed the backlog.
- A primary that had a replica once keeps `repl-backlog-size` bytes (1 MB by default) and an encode per write forever. That's a small fixed cost.
- Each record is encoded once, as a latin1 string. The same string goes into the ring and into the turn's buffer for the replicas, so the ring costs a copy per write, not an encode. Redis 7's shared blocks avoid that copy. In Redis 6 the replicas' output buffers held their own copies too.
- Partial sync needs a single copy out of the ring (`readFrom`) and never blocks, because the ring holds at most `repl-backlog-size` bytes.
