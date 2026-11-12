# Step 03: RESP parser, encoder and errors

## What this step built

`src/protocol/` turns raw socket bytes into commands and replies into bytes, with no dependency on the rest of the server. The parser handles RESP multibulk frames and inline commands incrementally, enforces every limit in spec 7.4, and reports exactly how many bytes each command used. The encoder writes every reply type in RESP2 or RESP3 from the same calls, and `errors.ts` holds the exact Redis 7.4 error strings, checked against the reference container.

## One real command's path

`SET user:1 alice` arriving as `*3\r\n$3\r\nSET\r\n$6\r\nuser:1\r\n$5\r\nalice\r\n`, split by TCP into two chunks:

1. `src/protocol/parser.ts:83` `feed()` pushes the first chunk onto the queue. Nothing is copied.
2. `parser.ts:90` `next()` → `parse()` (`:100`). The first byte is `*` (`:103`), so `multibulkHeader()` (`:157`) runs.
3. `headerLine()` (`:188`) uses `find(CR)` (`:211`) to locate `\r`. `take()` (`:231`) returns a zero-copy view of `*3\r\n`, and `parseLength()` (`:305`) applies Redis's strict `string2ll` rules: n = 3.
4. For each argument, `bulkHeader()` (`:170`) reads `$3`. Then, because 3 < BIG_ARG, the body plus CRLF is taken in one piece, checked by `expectCrlf()` (`:294`) and made into a latin1 string (`:140`).
5. The chunk ends in the middle of `alice`: `buffered < bulkLen + 2`, so `parse()` returns null and keeps `argsLeft = 1` and `bulkLen = 5`.
6. The second chunk arrives. `next()` resumes right at the body, finishes, and `finish()` (`:149`) returns `{ argv: ['SET','user:1','alice'], bytes: 36 }`.
7. Later, a handler replies with `Reply.ok()`, and `encoder.ts:43` `take()` gives the client `+OK\r\n` to send.

## Key functions and why each exists

- **`find()`**: searches for a line end across chunks and remembers where a failed search stopped. Without the memo, a header arriving one byte at a time would be rescanned on every byte, which is O(n²).
- **`take()` / `copyOut()` / `advance()`**: the only way bytes leave the queue. `advance()` is the single place `consumed` grows, so `bytes` can't drift from what was read.
- **The big-arg path (`:125`)**: a bulk ≥ 32 KB gets one `allocUnsafe(len + 2)`, filled chunk by chunk. A 64 MB bulk in 1 KB chunks takes about 280 ms on this machine (the limit is 2 s). Allocating is safe only because `bulkHeader()` has already checked the length (rule 11).
- **`parseLength()`**: Redis rejects `+1`, `01`, `-0`, ` 1` and anything beyond int64. The reference showed that `*-5` is skipped but `*-0` is an error.
- **`splitArgs()` (`:356`)**: a port of `sdssplitargs`, quirks included. CR and tab split unquoted args but `\v` doesn't; `\xZZ` becomes `xZZ`; a NUL ends the line, because C sees it as a terminator.
- **`formatDouble()` (`encoder.ts:160`)**: it's not `String(n)`. Probing the reference showed Redis 7.4's `d2string()` prints integral doubles within ±2^62 as exact integers (`1e18` → `1000000000000000000`). Everything else goes through fpconv's rules (`1e19` → `1e+19`, `1.234e-5` → `1.234e-5`, `0.000015` stays plain). JS would print `10000000000000000000` and `0.00001234`.
- **`Reply.error()` (`encoder.ts:59`)**: an all-caps first word is the code; otherwise it adds `ERR `. CR and LF become spaces, as Redis does, so a client-supplied name can't inject protocol.

## Trade-offs, and what Redis does differently

- Redis (`networking.c`, `processMultibulkBuffer`) keeps one growable `querybuf` per client and trims it. We keep the socket's own Buffers, because concatenating in JS means copying every time.
- Redis skips the two bytes after a bulk without looking (the reference runs `$4\r\nPINGxx` as PING). Spec 10.1 makes that a protocol error. Redis 7.4 also allows `*` counts up to INT_MAX; the spec caps them at 1,048,576. Both are recorded in `docs/DIFFERENCES.md`.
- Header lines: like Redis, only the `\r` is searched for, and the next byte is skipped unseen (`*1\rX…` works on both).
- fpconv's Grisu2 and JS's shortest-digits algorithm disagree on exact halfway cases. Both print a string that parses back to the same double (DIFFERENCES.md).

## The single most important line

`parser.ts:270`, `this.consumed += n;`. It is what makes `bytes` exact, and replicas will count their replication offsets with it (rule 13). Changing it to `+= 0` fails 7 tests, including "parses a command and reports the bytes it used" and "a 1,000-command pipeline fed one byte at a time parses exactly like one chunk".

## Quiz

1. A client sends `\r\n\r\n*0\r\nPING\r\n`. How many commands come out, and what is `bytes`?
2. Why must `bulkHeader()` check `len` against `maxBulkLen()` before the big-arg path allocates?
3. Why does `formatDouble(2 ** 62)` use `BigInt(x).toString()` and not `String(x)`?

<details>
<summary>Answers</summary>

1. One command, `['PING']`, with `bytes = 14`. The blank lines and the `*0` frame are skipped like Redis does, but their bytes count toward the next command, as Redis's `reploff` does.
2. Otherwise a client could send `$9999999999\r\n` and make us allocate gigabytes before sending a single body byte. Rule 11: every length is checked before memory is allocated.
3. `String(2 ** 62)` prints the shortest round-trip digits padded with zeros (`4611686018427388000`), but Redis's `ll2string` prints the exact integer, `4611686018427387904`.

</details>
