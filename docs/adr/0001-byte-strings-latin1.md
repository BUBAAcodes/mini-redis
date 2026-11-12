# ADR 0001: Keys and values are latin1 byte strings

**Status:** accepted (step 3)

## Context

Redis keys and values are arbitrary bytes: `\xff\xfe` is a valid key, and it isn't valid UTF-8. In Node, a `Buffer` keeps the bytes but compares, hashes and concatenates slowly and costs an object per value. A JS string decoded as UTF-8 is fast but lossy: invalid sequences become U+FFFD, and lengths count UTF-16 code units, not bytes.

## Decision

Every key, value, field and member is a JS string with exactly one character per byte, made with `buf.toString('latin1', start, end)`. The parser does this once per argument (`src/protocol/parser.ts`). Replies are built as latin1 strings too (`src/protocol/encoder.ts`), and only the socket and file code converts back, with `Buffer.from(s, 'latin1')`.

## Consequences

- Byte-exact round trips for all 256 byte values. The parser tests prove it for the parse direction, and later steps add SET/GET, the AOF and snapshots.
- `s.length` is the byte length (STRLEN, APPEND, `$<len>` headers) with no counting pass.
- `<` on two such strings compares bytes, which matches Redis's `memcmp` order for sorted-set members and lex ranges.
- V8 stores one-byte strings at one byte per char, so memory is about the same as a Buffer and much less than UTF-16.
- The cost: anyone who calls `toString()` without `'latin1'` (or `Buffer.from(s)` with UTF-8) silently corrupts data. Rule 2 of the spec forbids this, and the 256-byte round-trip tests catch it.
- Strings top out just under 512 MB in V8, which is why `proto-max-bulk-len` defaults to 64 MB (see DIFFERENCES.md).

## Alternatives rejected

- **`Buffer` everywhere**: correct, but every dict lookup would need a custom hash and equality on Buffers, and most values are small.
- **UTF-8 strings**: lossy for binary data, which breaks rule 2 and Redis compatibility.
