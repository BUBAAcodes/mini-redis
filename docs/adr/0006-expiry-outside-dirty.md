# ADR 0006: Expiry deletions are propagated at once and don't count in `server.dirty`

**Status:** accepted (step 7)

## Context

When a lookup finds an expired key, a primary deletes it and must propagate `DEL key` ahead of the command that found it (spec 9.3, 9.5). The dispatcher decides whether a command propagates its own record by checking whether `server.dirty` grew while it ran (`call()` in `src/commands/dispatch.ts`). If the expiry deletion went through `signalModifiedKey`, which does `dirty++`, then `DEL k` on an expired `k` would emit two records: the expiry's `DEL k` and the command's own `DEL k`, although the command changed nothing. `GET k` would be safe, because it's not a `write`, but every no-op write that touches an expired key would be wrong.

## Decision

`Db.deleteExpired()` (`src/storage/database.ts`) deletes the key, counts `expired_keys` and calls `propagator.propagateNow(db, ['DEL', key])`, which emits the record immediately and so ahead of the command's own. It does not touch `server.dirty`. Redis does the same: `deleteExpiredKeyAndPropagate` in `db.c` has no `server.dirty++`. The active cycle (`src/storage/expiry.ts`) uses the same function, so lazy and active expiry propagate identically.

## Consequences

- A command's own record still means "this command changed data", and the dispatcher's rule stays a single comparison.
- Expiry deletions don't count towards save points (step 13), as in Redis. A dataset that only expires never triggers a snapshot by itself.
- WATCH (step 16) must still see an expired key change. That hook goes into `deleteExpired()`, not `signalModifiedKey()`.
- Inside EXEC (step 16), `propagateNow` would emit a DEL in the middle of the `MULTI` … `EXEC` block. Step 16 has to decide whether such a DEL belongs inside the block or before it.
