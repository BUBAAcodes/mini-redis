# ADR 0011: Our own snapshot format, `dump.mrdb`, shaped like RDB but not RDB

**Status:** accepted (step 13)

## Context

Redis's RDB format has a dozen compact encodings (listpack, intset, ziplist, LZF-compressed strings, integer-encoded strings, modules, streams, functions) and versions that change between releases. MiniRedis stores none of those encodings (spec 2), so writing real RDB would mean converting to formats we never use, and reading it would mean decoding all of them. Spec 2 puts reading and writing real RDB out of scope.

## Decision

Spec 11.2's format: the magic `MINIREDIS` plus a 4-digit version, aux fields, then records. A record is `0xFE` SELECT, `0xFC` expiry (8-byte Unix ms), or a type byte (0 string, 1 list, 2 set, 3 zset, 4 hash) with its key and value. The file ends with `0xFF` and a CRC-64/Jones of everything before it. Integers are little-endian. Lengths and counts are unsigned LEB128, and strings are a length followed by raw bytes (latin1, rule 2). The opcodes and type numbers deliberately match RDB's, so the layout reads familiarly next to `rdb.c`.

- **Written incrementally.** `SnapshotWriter` takes one key at a time and hands out finished bytes with a running CRC. SAVE, the BGSAVE slices, the copy-on-write hook and (in step 20) the full sync all share it. Records carry their own SELECT because the hook delivers keys in any db order.
- **The loader trusts nothing.** Every length and count is checked against the bytes left before anything is allocated (rule 11). Keys go into fresh databases, which are swapped in only after the CRC matches. Any problem is a `SnapshotLoadError` carrying the byte offset where it was found. Duplicates, empty collections, NaN scores and a dangling expiry count as damage.

## Consequences

- Redis's tools (`redis-check-rdb`, RDB parsers) can't read our file, and Redis can't load it (`docs/DIFFERENCES.md`).
- No compression and no integer encoding, so the file is bigger than an RDB of the same data.
- CRC-64 catches every single-byte error, so a flipped byte anywhere fails the load. `tests/unit/snapshot-format.test.ts` flips every byte of a file three ways. A structural error reports its own offset; damage that parses reports the checksum's offset.
- A format change bumps the version, and the loader refuses versions it doesn't know rather than guessing.
