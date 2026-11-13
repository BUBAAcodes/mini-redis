# Step 06: Strings and keys

## What this step built

Every string and key command in spec 8.1 and 8.2 that isn't a TTL command or a † command: SET with `NX`/`XX`/`GET`, GETDEL, MGET, MSET, APPEND, STRLEN, INCR/DECR/INCRBY/DECRBY, INCRBYFLOAT, GETRANGE and SETRANGE, plus UNLINK, EXISTS, TYPE, KEYS, SCAN (`MATCH`, `COUNT`, `TYPE`), RENAME, RANDOMKEY, DBSIZE, FLUSHDB and FLUSHALL. `Db` gained `rename`, `flush`, `randomKey`, `allKeys` and `scanStep`, and `utils/numbers.ts` gained float parsing and formatting, an overflow-checked int64 add and the clamp to a safe JS number. The TTL options of SET and GETEX stay syntax errors until step 7.

## One real command's path

`redis-cli incrbyfloat price 1.5`:

1. `dispatch()` finds `incrbyfloat` in the table (`strings.ts:266`, arity 3, flags `write denyoom`) and calls `call()`, which runs the handler as in step 5.
2. `incrbyfloatCommand()` (`strings.ts:187`) parses the increment with `parseDouble` (`numbers.ts:50`). A bad one throws `ERR value is not a valid float` before the key is touched.
3. `stringForWrite()` (`strings.ts:30`) calls `db.lookupWrite`, the future home of lazy expiry and copy-on-write, and throws WRONGTYPE for a non-string.
4. The sum is checked for NaN or infinity, then printed with `formatDouble` (`numbers.ts:61`).
5. `setKey(..., { keepTtl: true })` stores the new object and `signalModifiedKey` bumps `server.dirty` (`strings.ts:203-204`).
6. `rewritePropagation(['SET', key, text, 'KEEPTTL'])` (`strings.ts:206`) swaps the record the propagator will emit once `call()` sees that `dirty` grew.

## Key functions and why each exists

- **`stringForWrite()` (`strings.ts:30`)**: the one place a write handler gets "the string under this key, or null, or WRONGTYPE". Every handler type-checks before it changes anything (rule 4).
- **`incrDecr()` (`strings.ts:151`)**: BigInt math through `addInt64`, so int64 is exact and overflow happens at the same value as Redis (ADR 0004).
- **`getrangeCommand()` (`strings.ts:209`)**: Redis's clamping order, quirks included (`GETRANGE k 0 -100` returns the first byte).
- **`setrangeCommand()` (`strings.ts:233`)**: validates the offset and the size against `proto-max-bulk-len` before it pads or writes, and never creates a key for an empty patch.
- **`scanCommand()` (`keys.ts:66`)**: steps `Db.scanStep` until it has `COUNT` entries or has taken `COUNT × 10` steps, then filters. A page may be empty with a non-zero cursor, as in Redis.
- **`Db.rename()` (`database.ts:86`)**: moves the object and its `expires` entry together, so RENAME keeps the TTL.
- **`Db.flush()` (`database.ts:100`)**: clears both dicts and counts every removed key as a change, so save points see FLUSHDB as a big write.
- **`formatDouble()` / `parseDouble()` / `clampToSafe()` (`numbers.ts`)**: strict float rules, output without exponents, and the int64-to-safe-number clamp for indexes (spec 7.2).

## Trade-offs, and what Redis does differently

- Redis edits a string in place and keeps its encoding (`t_string.c`: `incrDecrCommand` re-uses the object when it can). We always build a new `RObj` with `keepTtl`, which is simpler and is where the snapshot hook will see "value replaced" (step 13).
- INCRBYFLOAT uses doubles, not 80-bit long doubles (ADR 0005, `DIFFERENCES.md`).
- UNLINK is DEL. Redis frees big values on a background thread (`lazyfree.c`); we have one thread and nothing to hand off to.
- Redis's SCAN handles small collections in a single call (`db.c`, `scanGenericCommand`); ours pages all of them the same way (already in `DIFFERENCES.md`).
- GETDEL propagates as `GETDEL`; Redis rewrites it to `DEL`. Both replay the same, so spec 9.5 doesn't list it.
- Checked against `redis:7.4` (Docker): 40 edge-case commands, including every new error string, SCAN with cursor `-1`, `""` and an unknown `TYPE`, GETRANGE quirks, int64 overflow and FLUSH arguments, give identical replies. The only differences are `0.1 + 0.2` style float digits and `1e999` (both in `DIFFERENCES.md`), and SET's TTL options, which are step 7.

## The single most important line

`strings.ts:160`, `const next = addInt64(current, delta);` followed by the overflow check. Replace it with `Number` math and `SET k 9223372036854775806`, `INCR`, `INCR` no longer overflows exactly at int64: "is exact up to int64 and overflows past it" in `strings-commands.test.ts` fails.

## Quiz

1. Why does `SETRANGE k 5 ""` on a missing key reply 0 and create nothing, while `SETRANGE k 5 "x"` creates a 6-byte string?
2. A SCAN with `MATCH user:*` returns `["17", []]`. Is the scan finished? Why can an empty page happen?
3. Why is INCRBYFLOAT propagated as `SET key result KEEPTTL` and not as itself?

<details>
<summary>Answers</summary>

1. With nothing to write there is nothing to change, so Redis (and `setrangeCommand`, `strings.ts:239`) replies with the current length, 0, and leaves the keyspace alone. With a non-empty patch the string is padded with zero bytes up to the offset, then the patch is written, giving offset + length = 6 bytes.
2. No: the cursor `17` is not `0`, so the scan continues. SCAN visits a few buckets and only then applies MATCH, so those buckets may hold no matching key. Finishing is signalled by cursor `0` only.
3. Float math could give a different last digit on a replica or after an AOF replay. Shipping the exact result text makes every copy store the same bytes. KEEPTTL stops the SET from dropping the key's TTL, which INCRBYFLOAT never touches.

</details>
