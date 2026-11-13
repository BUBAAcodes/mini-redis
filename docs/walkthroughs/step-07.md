# Step 07: Expiry

## What this step built

Keys can now have TTLs. Lazy expiry runs in every `Db` lookup, and an active cycle in serverCron deletes expired keys nobody reads (spec 9.3). New commands are EXPIRE, PEXPIRE, EXPIREAT and PEXPIREAT with `NX`/`XX`/`GT`/`LT`, plus TTL, PTTL, PERSIST and GETEX, and SET gained `EX`/`PX`/`EXAT`/`PXAT`/`KEEPTTL`. Every relative TTL is propagated as an absolute time (spec 9.5). DEBUG arrived with `DIGEST`, `DIGEST-VALUE`, `SLEEP` and `SET-ACTIVE-EXPIRE`, enabled by `enable-debug-command yes` (which the test helper now sets).

## One real command's path

`redis-cli expire session 10`:

1. `dispatch()` finds `expire` (`keys.ts`, arity -3, flag `write`), and `call()` reads the clock once into `server.cmdTime` (`dispatch.ts:63`).
2. `expireCommand` (`keys.ts:246`) calls `expireGeneric(ctx, 'expire', cmdTime, true)` (`keys.ts:195`).
3. `parseExpireFlags()` (`keys.ts:173`) checks the flags first. Then `10` is parsed as an int64 BigInt, multiplied by 1000 and added to `cmdTime`, with Redis's exact overflow checks, all before the key is looked at.
4. `db.lookupWrite('session')` (`keys.ts:215` → `database.ts:66`) first runs `expireIfNeeded()` (`database.ts:175`). If the key had already expired, `deleteExpired()` (`database.ts:210`) removes it and emits `DEL session` right away through `propagateNow()` (`propagate.ts:64`), and EXPIRE replies 0.
5. Otherwise the deadline goes through the NX/XX/GT/LT checks. A deadline at or before `cmdTime` deletes the key (`keys.ts:232`). A future one is stored with `db.setExpire()`, followed by `signalModifiedKey`.
6. `rewritePropagation(['PEXPIREAT', 'session', '<abs ms>'])` (`keys.ts:241`). When `call()` sees `dirty` grew (`dispatch.ts:84`), the propagator emits that record instead of `EXPIRE session 10`.

## Key functions and why each exists

- **`Db.expireIfNeeded()` (`database.ts:175`)**: the single lazy-expiry check, used by `lookupRead`, `lookupWrite`, `peek`, `randomKey` and SCAN. The rule is `cmdTime > deadline`, so a key can't expire halfway through a command.
- **`Db.deleteExpired()` (`database.ts:210`)**: shared by lazy and active expiry. It deletes the key, counts `expired_keys` and propagates `DEL` at once. It deliberately leaves `dirty` alone (ADR 0006), so `DEL expiredkey` doesn't propagate twice.
- **`activeExpireCycle()` (`expiry.ts:21`)** and **`Db.activeExpireSample()` (`database.ts:193`)**: draw 20 random keys with a TTL and delete the expired ones. They sample again while more than 25% of the draw was expired, stop when the budget runs out (25% of a tick), and resume at the same db next time.
- **`parseStringArgs()` / `expireDeadline()` (`strings.ts:79`, `strings.ts:116`)**: Redis's option parser for SET and GETEX, where an option is accepted only if nothing that clashes with it came before. They turn EX/PX/EXAT/PXAT into an absolute int64 deadline.
- **`datasetDigest()` (`debug.ts:54`)**: XORs one SHA-1 per live key over length-prefixed (db, key, type, value, deadline). The result doesn't depend on order, so two servers holding the same data agree.

## Trade-offs, and what Redis does differently

- Redis 6+ runs active expiry over a scan cursor with `active-expire-effort`, plus a fast cycle in `beforeSleep` (`expire.c`, `activeExpireCycle`). We use the classic random-draw sampler that spec 9.3 describes.
- The first version sampled with `randomEntries()`, one run of consecutive buckets. Deleting whole runs left the survivors in clumps, so samples came back empty and the cycle stopped with keys still expired. Each key is now its own `randomEntry()` draw, like Redis's old `dictGetRandomKey` loop. `randomEntries()` also gained Redis's jump after a run of empty buckets (`dict.ts:343`, from `dict.c`, `dictGetSomeKeys`), because right after a grow it could return nothing. Eviction will need that in step 19.
- Deadlines are stored as doubles, so a deadline past 2^53 ms loses its last digits. The propagated PEXPIREAT carries the exact int64 (`DIFFERENCES.md`).
- Redis counts keyspace hits for TYPE, EXISTS, TTL, GETEX and SET … GET. We follow spec 6.1 and rule 5 instead (`peek` and `lookupWrite` don't count). This is checked on the reference and recorded in `DIFFERENCES.md`.
- SET with a past EXAT stores the key and leaves it to lazy expiry, as Redis 7.4 does (DBSIZE counts it). GETEX with a past EXAT/PXAT deletes the key at once, also as Redis does.
- Measured: 100,000 keys with a 1 s TTL were gone 1.13 s after the last write, and the worst PING during the cleanup was 26 ms.

## The single most important line

`database.ts:48`, `this.expireIfNeeded(key);` at the top of `lookupRead`. Delete it and GET returns values whose TTL has passed, which breaks rule 7. "with active expiry off, GET on an expired key returns nil and DBSIZE drops by one" in `expire-commands.test.ts` fails, and so does "every lookup expires lazily" in `database.test.ts`.

## Quiz

1. `EXPIRE k 10` is propagated as `PEXPIREAT k <ms>`. What would go wrong on a replica or after an AOF replay if it were propagated as it arrived?
2. Why doesn't `deleteExpired()` call `signalModifiedKey()`, which would do `dirty++`?
3. `EXPIRE k 10 GT` on a key without a TTL replies 0, but `EXPIRE k 10 LT` replies 1. Why?

<details>
<summary>Answers</summary>

1. The TTL would restart from whenever the command is replayed. A replica that applies it a second late, or an AOF loaded an hour later, would keep the key 10 s past that moment rather than until the original deadline. An absolute time means the same instant everywhere.
2. The dispatcher propagates a write's own record only if `dirty` grew while it ran. `DEL k` on an expired `k` would then emit the expiry's `DEL k` and its own `DEL k`, although the command changed nothing. Redis's `deleteExpiredKeyAndPropagate` doesn't touch `dirty` either (ADR 0006).
3. GT and LT treat a key without a TTL as having an infinite one (spec 9.3). 10 s isn't greater than infinity, so GT refuses. It is less, so LT sets it.

</details>
