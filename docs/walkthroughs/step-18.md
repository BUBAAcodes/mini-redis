# Step 18: Blocking commands

## What this step built

BLPOP, BRPOP and BLMOVE (`src/commands/lists.ts`), and `src/blocking/waiters.ts`, which parks a client on its keys and serves waiters in arrival order when a key gets data. Serving re-runs the blocked command, as Redis 7 does, so the code that pops at once and the code that pops after a wait are the same, and so is the propagated `LPOP`/`RPOP`/`LMOVE`. A blocked client's pipelined input waits in its parser and runs from beforeSleep once the client is served or times out; each timeout is one Node timer (ADR 0008).

## One real command's path

Client A runs `BLPOP q 0` on an empty `q`; then client B runs `RPUSH q v`:

1. A's BLPOP goes through `dispatch` and `call` to `blockingPopGeneric` (`lists.ts:233`). The timeout parses (`parseTimeout`, `waiters.ts:40`), `q` is missing, and A isn't in MULTI, so `waiters.block` runs (`lists.ts:250`, `waiters.ts:88`). It appends A to `db.blockingKeys['q']` and stores a `BlockState` on A. A zero timeout arms no timer. There's no reply.
2. Back in `call`, A is now `blocked`, so its stats wait (`dispatch.ts:179`). A's `processInput` loop stops (`server.ts:282`), and anything A pipelined stays in its parser.
3. B's RPUSH runs `pushGeneric`, whose `signalModifiedKey` (`database.ts:248`) sees waiters on `q` and calls `signalKeyAsReady` (`waiters.ts:119`).
4. B's `call` propagates `RPUSH q v`, then step 11 (`dispatch.ts:191`) calls `handleClientsBlockedOnKeys` (`waiters.ts:129`). `serveKey` (`waiters.ts:152`) finds `q` holding a list, unblocks A, and re-runs A's BLPOP through `call` (`waiters.ts:164`).
5. This time `blockingPopGeneric` finds `v`. It pops, deletes the empty key, rewrites its propagation to `LPOP q` (`lists.ts:242`) and replies `[q, v]`. The re-run `call` propagates `LPOP q` after B's `RPUSH`, and its own step 11 returns at once because `serving` is set.
6. `queueUnblocked` (`server.ts:232`) queues A's reply and A itself. In beforeSleep, `beforeWrites` (`event-loop.ts:48`) runs `processUnblockedClients` (`server.ts:308`), which runs A's buffered commands. Then both clients' replies are written.

## Key functions and why each exists

- **`Waiters.block` / `unblock` (`waiters.ts:88`, `:105`)**: the two halves of the registry. Each key holds a FIFO of clients in its Db, and each client holds its keys, deduplicated (`BLPOP q q 0` registers once), its deadline, its timer and its command. `unblock` is the one exit, used by serving, timeouts and `freeClient` (`server.ts:324`).
- **`handleClientsBlockedOnKeys` (`waiters.ts:129`)**: drains ready keys until none are left. A served BLMOVE pushes into its destination, which can make another key ready, so this loops. The `serving` flag stops a re-run command from serving recursively.
- **`serveKey` (`waiters.ts:152`)**: walks a snapshot of the key's waiters, oldest first, re-running each while the key holds a list. Another type, or the list running out (the last pop deletes the key), leaves the rest waiting.
- **`parseTimeout` (`waiters.ts:40`)**: Redis's `getTimeoutFromObjectOrReply`. Milliseconds are rounded up, so `0.0001` waits 1 ms and `-0.0001` means forever. The deadline must fit in int64.
- **`onTimer` / `timerDelay` (`waiters.ts:176`, `:53`)**: a null array on timeout. Delays are capped at Node's 2^31−1 ms limit, and the timer re-arms for whatever is left.
- **`processUnblockedClients` (`server.ts:308`)**: runs a woken client's pipelined input on a fresh stack in beforeSleep, never inside the command or timer that woke it.

## Trade-offs, and what Redis does differently

- **Re-running vs popping for the waiter.** Before 7.0, Redis's `blocked.c` popped on the waiter's behalf (`serveClientBlockedOnList`). Redis 7 re-runs the command (`unblockClientOnKey` → `processCommandAndResetClient`), and so do we. Re-running gives serve-time errors for free: checked against `redis:7.4`, a BLMOVE whose destination became a string gets WRONGTYPE and leaves the source as it was. Redis re-runs through `processCommand`, so its checks (OOM, READONLY) apply again. We call `call()` directly; step 19 must decide whether a served BLMOVE should re-check `maxmemory`.
- **Timeouts.** Redis keeps a radix tree of deadlines and checks it every loop turn (`timeout.c`). We use one Node timer per client (ADR 0008).
- **Removal cost.** Redis's per-key client list is a linked list, and each client keeps its node, so removal is O(1). We `splice` an array, O(waiters on that key), which is fine at realistic counts.
- **Inside MULTI.** BLPOP gives a null array, while BLMOVE gives LMOVE's null bulk (`$-1`) though its timeout gives a null array, as in Redis.
- **Timeout parsing.** Redis reads timeouts as long doubles (`strtold`), so `0x10` and `1e-400` are accepted. We reuse the strict double parser; that's a row in `docs/DIFFERENCES.md`.

Tests: `tests/unit/waiters.test.ts` (timeout parsing, timer capping) and `tests/integration/blocking.test.ts` (34 tests: every "Done when" item, FIFO order, chained and rotating BLMOVE, RENAME, type changes, serve-time WRONGTYPE, databases, MULTI, RESP3, disconnects, long timers, stats). 32 one-shot probes and 10 multi-client scenarios were diffed byte for byte with `redis:7.4`. The scenarios match exactly; the probes differ only in hex timeouts and HELLO (step 22).

## The single most important line

`dispatch.ts:191`: `if (!options.inExec && !server.loading) server.waiters.handleClientsBlockedOnKeys();` (the `loading` test joined in step 12). Without it a push never wakes anyone. Deleting it makes "BLPOP returns within 10 ms of another client's push" in `tests/integration/blocking.test.ts` hang until it times out. Every test after it then fails too, because the shared clients stay blocked (checked by deleting the line).

## Quiz

1. Client A runs `BLMOVE src dst LEFT RIGHT 0` and client B runs `BLPOP dst 0`, both on empty keys. Client C runs `RPUSH src v`. What does each client get, and in what order are the records propagated?
2. Why do a served client's pipelined commands run from beforeSleep rather than straight after its re-run command inside `serveKey`?
3. A client runs `MULTI`, `BLPOP q 0`, `EXEC` with `q` empty. Why doesn't it block, and what does EXEC return?

<details>
<summary>Answers</summary>

1. A gets `v` and B gets `[dst, v]`. Records: `RPUSH src v`, then `LMOVE src dst LEFT RIGHT`, then `LPOP dst`. A's re-run LMOVE signals `dst`, which makes it ready, and the `handleClientsBlockedOnKeys` loop (`waiters.ts:129`) serves B in the same pass.
2. `serveKey` runs inside another client's command (or inside EXEC). Running A's input there would nest A's commands inside B's: their propagation would interleave with B's step 11, and a command that blocks or serves again would recurse. Redis also defers it (`queueClientForReprocessing` → `processUnblockedClients` in beforeSleep).
3. A transaction must run without waiting, or it would hold the single thread forever. `blockingPopGeneric` checks `client.denyBlocking` (`lists.ts:246`), which is true while `client.multi` is, and `multi` stays set while EXEC runs its queue (`transactions.ts:46`), and replies with a null array instead. EXEC returns `*1\r\n*-1\r\n`.

</details>
