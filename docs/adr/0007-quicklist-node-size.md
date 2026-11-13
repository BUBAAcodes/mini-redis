# ADR 0007: Quicklist nodes hold at most 128 items

**Status:** accepted (step 9)

## Context

A list needs O(1) pushes and pops at both ends (LPUSH, RPOP) and reasonable positional access (LINDEX, LSET, LINSERT). A single JS array has O(n) `unshift`. A linked list of single items has O(1) ends but O(n) hops for any index and a large per-item overhead. Redis's answer is the quicklist: a linked list of listpacks, with each node capped by `list-max-listpack-size` (default `-2`, meaning 8 KB per node) (`quicklist.c`).

## Decision

`src/datastructures/quicklist.ts` keeps each node as a plain JS array of byte strings, capped at `list-max-node-items` items (default 128, a config directive). The cap is a count, not bytes, because V8 doesn't expose a string's real footprint cheaply, and a count keeps the cost of an `unshift` or `splice` inside a node bounded: at most 128 slots move. Full end nodes get a new neighbour; inserting into a full node splits it in half; after LREM and LTRIM, neighbours that fit in one node are merged. Pops never merge, so a push/pop loop at a node boundary can't thrash.

## Consequences

- Ends are O(1) amortised. Positional access is O(n / 128) node hops plus one array index, from the nearer end.
- A node of 128 huge values can be much bigger than Redis's 8 KB nodes. That only matters for memory estimates (step 19), which count bytes per item anyway.
- There is no node compression (Redis's `list-compress-depth`).
- The property test runs with node sizes 1 to 6, so splits, merges and empty-node removal are exercised far more often than they would be at 128.
