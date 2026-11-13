# Step 09: Lists

## What this step built

Lists are stored in a `Quicklist` (`src/datastructures/quicklist.ts`): a doubly linked list of nodes, each holding a JS array of at most 128 items (ADR 0007). The non-†, non-blocking list commands (LPUSH, RPUSH, LPOP, RPOP, LLEN, LRANGE, LINDEX, LSET, LINSERT, LREM, LTRIM, LMOVE) are in `src/commands/lists.ts`. They are typed through a new shared helper, `src/commands/typed.ts`, and DEBUG DIGEST and the differential generator now cover lists.

## One real command's path

`RPOP l 2` on a list `[a, b, c]`:

1. `dispatch.ts:66` calls `spec.handler(ctx)`, which is `rpopCommand` (`lists.ts:108`) → `popGeneric(ctx, 'RIGHT')` (`lists.ts:77`).
2. The count is parsed before the key lookup, as in Redis. `abc` and `-1` both give `ERR value is out of range, must be positive`, even on a missing key.
3. `lookupWriteOfType(ctx, 'l', 'list')` (`typed.ts:27`) runs `Db.lookupWrite`, which does lazy expiry and will hold the copy-on-write hook. A string under `l` throws WRONGTYPE here, before anything changed.
4. Two `popTail()` calls take `c` and `b` from the tail node (`quicklist.ts`). Only the end node is touched.
5. `afterRemove` (`lists.ts:48`) deletes the key if the list is now empty, then calls `signalModifiedKey` once. That bumps `server.dirty`.
6. Back in the dispatcher, the grown dirty counter means "changed", so `propagator.end` (`dispatch.ts:85`) records `RPOP l 2` as sent.

## Key functions and why each exists

- **`Quicklist.locate(index)` (`quicklist.ts:263`)**: walks from whichever end is nearer and skips whole nodes by their length. LINDEX, LSET, LINSERT and the start of LRANGE use it.
- **`Quicklist.insert` (`quicklist.ts:106`)**: splits a full node in half before inserting. Inserting at offset 0 of a full node gets a node of its own instead (`:113`). The property test found that a 1-item node split in half leaves an empty node.
- **`Quicklist.trim` (`:160`) and `remove` (`:200`)**: drop whole nodes where they can. Afterwards neighbours are merged, so the node count stays near `length / 128`. `remove` merges in one `compact()` pass (`:299`) after the walk, because merging mid-walk would unlink the node it is about to visit.
- **`lookupReadOfType` / `lookupWriteOfType` (`typed.ts`)**: the WRONGTYPE check sits next to the lookup, and TypeScript narrows the result to `ListObject`. Steps 10 and 11 reuse them.
- **`afterRemove` (`lists.ts:48`)**: the single place where an emptied list stops existing. LPOP, RPOP, LREM, LTRIM and LMOVE all go through it.
- **The `never` check in `hashValue` (`debug.ts`)**: it now takes the whole object, so adding a type to `RObj` stops compiling until the digest has a canonical form for it.

## Trade-offs, and what Redis does differently

- Redis's nodes are listpacks capped at 8 KB (`quicklist.c`, `list-max-listpack-size -2`), optionally LZF-compressed (`list-compress-depth`). Ours are arrays capped by item count, with no compression. See ADR 0007.
- Redis converts small lists to a single listpack (`OBJ_ENCODING_LISTPACK`, `t_list.c listTypeTryConversion`). We always use a quicklist, so OBJECT ENCODING will say `quicklist` (already in DIFFERENCES.md).
- A no-op command doesn't call `signalModifiedKey`: `LPOP l 0`, an LTRIM that keeps everything, an LREM that found nothing. So nothing is propagated, and in step 16 WATCH won't be touched. Redis's `ltrimCommand` does call `signalModifiedKey` with nothing trimmed (touching WATCH) but doesn't propagate it, because `server.dirty` doesn't grow. The step 16 differential runs will show whether WATCH ever exposes this.
- LMOVE on the same key is a rotation. The list never empties mid-command, and the key is signalled once (rule 5).
- Differential runs: seeds 1, 2 and 3 at 10,000 ops and 77 and 4242 at 50,000 ops, with zero diffs.

## The single most important line

`lists.ts:49`: `if (list.value.length === 0) ctx.db.delete(key);`. Redis never keeps an empty list: EXISTS, TYPE, DBSIZE and the TTL all depend on that. Deleting the line fails 5 tests in `tests/integration/lists-commands.test.ts`, for example "pop one, or a count, and delete the emptied key" and "a list keeps its TTL across pushes and loses it when it empties".

## Quiz

1. Why does `Quicklist.remove` merge nodes after its walk rather than during it?
2. `LSET missing abc x` and `LSET l abc x` give different errors. Why, and what does that say about argument order?
3. Why don't pops merge a shrinking end node with its neighbour?

<details>
<summary>Answers</summary>

1. A merge unlinks a neighbour, and the walk holds a reference to the next node to visit. Merging mid-walk could leave it iterating over a node that's no longer in the list. LREM is O(n) anyway, so one `compact()` pass afterwards costs nothing extra.
2. Redis's `lsetCommand` looks the key up (`no such key`) before it parses the index (`not an integer`). Each handler mirrors its Redis order, so the differential test sees identical errors. Rule 4 still holds: every check runs before any change.
3. At a node boundary, a push/pop loop would then split and merge on every call, copying up to 128 items each time. An end node simply disappears when it empties.

</details>
