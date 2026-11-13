# Step 16: Transactions

## What this step built

MULTI, EXEC, DISCARD, WATCH and UNWATCH are in `src/commands/transactions.ts`, with the queueing and the queue-time checks in `src/commands/dispatch.ts`. WATCH is a two-way registry in `src/storage/watch.ts`. Each `Db` maps key → watchers, and each `Client` lists its own entries. The `Db` change paths (`signalModifiedKey`, lazy and active expiry, `flush`) mark watchers dirty. The propagator holds an EXEC's records back and sends them as `MULTI` … `EXEC`. The differential generator now mixes in WATCH/MULTI blocks, and EXEC replies are compared element by element.

## One real command's path

Client A runs `WATCH k`, client B runs `SET k 1`, then A runs `MULTI`, `INCR k`, `EXEC`:

1. `WATCH k` goes through `dispatch` (`dispatch.ts:34`) and `call` (`:105`) to `watchCommand` (`transactions.ts:61`). `watchKey` (`watch.ts:28`) adds A to `db.watched['k']` and pushes the entry onto `A.watchedKeys`. It doesn't look the key up, so it never deletes an expired key, but it records whether the key was already expired (`expired` flag).
2. B's `SET k 1` stores the value, and `setCommand` calls `db.signalModifiedKey('k')` (`database.ts:241`). That calls `touchWatchedKey` (`:242` → `watch.ts:63`), which finds A and calls `markDirty` (`watch.ts:90`). That sets `A.dirtyCas` and unwatches all of A's keys: EXEC will fail anyway.
3. A's `MULTI` runs `multiCommand`, which sets `client.multi`. `INCR k` passes the lookup and arity checks in `dispatch`. Because `client.multi` is set and INCR isn't one of the five commands that run immediately, it is pushed onto `client.queued` (`dispatch.ts:67`) and answered `+QUEUED`.
4. `EXEC` runs right away. `execCommand` (`transactions.ts:28`) sees `dirtyCas` and calls `discardTransaction`, which replies `*-1`. Nothing ran, so nothing is propagated.

On the clean path, EXEC unwatches first (`:42`) and writes `*n`. `multiStart()` (`propagate.ts:90`) then holds records back, and each queued command goes through the same `call()` (`:48`) with `inExec`, so the clock isn't read again (`dispatch.ts:118`). Each command adds its own single reply after the header. `multiEnd()` (`propagate.ts:95`) sends `MULTI`, the records, `EXEC`.

## Key functions and why each exists

- **`reject` (`dispatch.ts:79`)**: every failed check goes through here. Inside MULTI it sets `dirtyExec`, so EXEC replies EXECABORT. EXEC failing its own arity check is a special case, as in Redis's `execCommandAbort`. It ends the transaction at once, in or out of MULTI, with `EXECABORT Transaction discarded because of: <reason>`.
- **`discardTransaction` (`dispatch.ts`)**: one way out of MULTI, shared by EXEC, DISCARD and the abort. It clears the queue, both dirty flags and every WATCH.
- **`touchWatchedKey` / `touchAllWatchedKeysInDb` (`watch.ts:63`, `:77`)**: the WATCH hooks. The flush version runs before the dicts are cleared and only counts keys that were actually stored. So FLUSHALL doesn't fail a WATCH on a missing key, which the reference confirmed.
- **The `expired` flag (`watch.ts:68`)**: copied from Redis 7.4's `watchedKey.expired`. If a key was already dead when WATCHed, its later deletion (lazy, active or flush) is not a change, and the flag is cleared. If the key comes back, that is a change. All six cases were checked on the reference with two connections.
- **`isWatchedKeyExpired` (`watch.ts:55`)**: a key that passes its deadline between WATCH and EXEC fails EXEC even if nothing has deleted it yet.
- **`Propagator.multiStart` / `multiEnd` (`propagate.ts:90`, `:95`)**: lazy-expiry DELs found inside EXEC go inside the wrapper too. MULTI takes the first record's db and EXEC the last one's, so a sink never writes a SELECT just for them.
- **`execRepliesMatch` (`tests/differential/compare.ts`)**: compares an EXEC array element by element against the commands Redis answered `+QUEUED`. That way a SMEMBERS or TTL inside a transaction gets the same tolerance as outside.

## Trade-offs, and what Redis does differently

- **Registry shape.** Spec 6.1 says `watched: Map<key, Set<Client>>`. We use `Map<key, Map<Client, WatchedKey>>`: the same set of clients, with each one's entry attached, so the hooks can read the `expired` flag in O(1). Redis keeps a list of `watchedKey` per key in `multi.c`.
- **Propagation.** Redis 7 (`server.c propagatePendingCommands`) wraps an execution unit only when it produced two or more records. An EXEC with one write goes out bare. On the other hand, a plain command whose lazy expiry adds a DEL gets wrapped. Spec 9.5 wraps every EXEC that wrote anything and nothing else. That's a new DIFFERENCES.md row; both replay to the same state.
- **`nomulti`.** The check and its error (`ERR Command not allowed inside a transaction`, which aborts the transaction) are in the dispatcher, but nothing carries the flag yet. In Redis 7.4 only SAVE, SHUTDOWN, PSYNC and SYNC do (from `COMMAND`). Steps 13, 20 and 23 must flag them.
- **No rollback**, as in Redis: run-time errors are ordinary replies inside the array. Atomicity comes from the single thread: nothing else runs between the queued commands.
- **Blocking inside EXEC.** `client.multi` stays set while the queue runs, like Redis's `CLIENT_MULTI`, so step 18's BLPOP can see that it must not block.

Tests: `tests/unit/watch.test.ts` (registry and hooks), `tests/unit/propagate.test.ts` (wrapping), and `tests/integration/transactions.test.ts`. The integration test covers every two-client case from the reference, the propagation records, and two load tests. In the first, 50 clients run the pipelined transfer transaction while a reader checks `A + B` on every MGET. In the second, 20 clients increment a counter by check-and-set until it reaches exactly 200. Differential: seeds 1–5 at 30,000 ops each and a random seed at 10,000, zero diffs. Each 30k run has about 800 blocks.

## The single most important line

`database.ts:242`: `touchWatchedKey(this, key);` in `signalModifiedKey`. Every command's change reaches WATCH through it. Deleting it fails 10 tests: "a change marks every watcher dirty…" in `tests/unit/watch.test.ts`, and "EXEC returns a null array when another client changes a watched key", the check-and-set counter and others in `tests/integration/transactions.test.ts`. This is also row 11 of spec 21's break-it table.

## Quiz

1. Client A runs `WATCH k`. Then `k`, which had a TTL, expires before anyone touches it, and A runs `MULTI`, `GET k`, `EXEC`. What does EXEC reply, and which function decides?
2. Inside MULTI, why does `SET k` (missing value) abort the transaction while `MULTI` (nested) and `WATCH k` don't?
3. Why does EXEC unwatch before running its queue rather than after?

<details>
<summary>Answers</summary>

1. `*-1` (null). `isWatchedKeyExpired` (`watch.ts:55`) sees that the key is past its deadline at EXEC's `cmdTime`, even though it hasn't been deleted. Had the key already been expired when WATCH ran, its `expired` flag would be set and EXEC would run.
2. `SET k` fails a dispatcher check (arity), and every failed check goes through `reject`, which sets `dirtyExec`. Nested MULTI and WATCH inside MULTI pass every check and run at once, because they are in `RUN_INSIDE_MULTI`. Their handlers then reply with an error without flagging anything. Redis 7.4 behaves the same way: the transaction stays alive.
3. The transaction's own writes call `signalModifiedKey` on the keys it watches. If A were still watching, `touchWatchedKey` would mark A dirty in the middle of its own EXEC. That's harmless here, but wasted work, and the leftover `dirtyCas` would need clearing. Unwatching first, as Redis does, also frees the registry entries sooner.

</details>
