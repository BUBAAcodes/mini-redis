/**
 * Incremental request parser: RESP multibulk (`*<n>\r\n$<len>\r\n<bytes>\r\n…`) and inline
 * commands (`SET a "b c"\n`), turning socket chunks into `{ argv, bytes }` (spec 10.1).
 *
 * Key design choice: input stays as a queue of the socket's own Buffers plus a read position.
 * Nothing is concatenated per chunk; a line-end search resumes where the last one stopped; and a
 * bulk of BIG_ARG bytes or more gets one buffer of its exact size, filled as data arrives. So a
 * byte-at-a-time pipeline and a 64 MB bulk both cost O(bytes). Each argument becomes a latin1
 * byte string exactly once (spec 7.1).
 *
 * Mirrors Redis networking.c (processInlineBuffer, processMultibulkBuffer) and sds.c
 * (sdssplitargs). Behaviour was checked byte for byte against redis:7.4.
 */
import { PROTOCOL, ProtocolError, expectedDollar, expectedStar } from './errors.js';

export interface ParsedCommand {
  argv: string[];
  /** Input bytes this command used, including blank lines and empty frames before it. */
  bytes: number;
}

export interface ParserLimits {
  /** proto-max-bulk-len; read at every bulk header so CONFIG SET applies at once. */
  maxBulkLen(): number;
  /** True while the client must still AUTH (Redis's authRequired()). */
  authRequired(): boolean;
}

/** Largest multibulk count (Redis 7.4 allows up to INT_MAX; spec 7.4 caps it). */
export const MAX_MULTIBULK_LEN = 1024 * 1024;
export const MAX_UNAUTH_MULTIBULK_LEN = 10;
export const MAX_UNAUTH_BULK_LEN = 16 * 1024;
/** PROTO_INLINE_MAX_SIZE: unterminated inline or header lines may not grow past this. */
export const MAX_INLINE_LEN = 64 * 1024;
/** PROTO_MBULK_BIG_ARG: bulks this size or larger get their own buffer. */
export const BIG_ARG = 32 * 1024;

export interface ParserOptions {
  /**
   * Accept only multibulk frames with at least one argument, as the AOF loader does (Redis's
   * loadSingleAppendOnlyFile): an inline line or an empty frame there is damage, not input.
   */
  multibulkOnly?: boolean;
}

const DEFAULT_LIMITS: ParserLimits = {
  maxBulkLen: () => 64 * 1024 * 1024,
  authRequired: () => false,
};

const NUL = 0x00;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const DQUOTE = 0x22;
const DOLLAR = 0x24;
const SQUOTE = 0x27;
const STAR = 0x2a;
const MINUS = 0x2d;
const ZERO = 0x30;
const BACKSLASH = 0x5c;
const LOWER_X = 0x78;

export class RespParser {
  private chunks: Buffer[] = [];
  private head = 0; // index of the first unread chunk
  private pos = 0; // read position inside chunks[head]
  private buffered = 0; // unread bytes across all chunks
  // Where the last unsuccessful line-end search stopped; -1 = search from the read position.
  private scanChunk = -1;
  private scanBase = 0;

  // The multibulk being read.
  private argsLeft = 0;
  private argv: string[] = [];
  private bulkLen = -1; // -1 = the next thing is a `$<len>` header
  private big: Buffer | null = null; // body + CRLF of a bulk >= BIG_ARG
  private bigFilled = 0;

  private consumed = 0; // bytes used so far by the command being parsed
  private failure: ProtocolError | null = null;

  private readonly multibulkOnly: boolean;

  constructor(
    private readonly limits: ParserLimits = DEFAULT_LIMITS,
    options: ParserOptions = {},
  ) {
    this.multibulkOnly = options.multibulkOnly ?? false;
  }

  /** Unparsed input held in memory, for client-query-buffer-limit. */
  get bufferedBytes(): number {
    return this.buffered + (this.big === null ? 0 : this.big.length);
  }

  /**
   * True while a command is partly read: unread bytes, or a multibulk whose header was taken
   * but whose arguments haven't all arrived. At the end of an AOF this means a cut-off tail.
   */
  get pending(): boolean {
    return this.buffered > 0 || this.argsLeft > 0 || this.big !== null;
  }

  feed(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
  }

  /** The next complete command, or null until more input arrives. Throws ProtocolError. */
  next(): ParsedCommand | null {
    if (this.failure !== null) throw this.failure;
    try {
      return this.parse();
    } catch (e) {
      if (e instanceof ProtocolError) this.failure = e;
      throw e;
    }
  }

  private parse(): ParsedCommand | null {
    while (this.argsLeft === 0) {
      if (this.buffered === 0) return null;
      if (this.chunks[this.head]![this.pos] === STAR) {
        const n = this.multibulkHeader();
        if (n === null) return null;
        if (n > 0) {
          this.argsLeft = n;
          this.argv = [];
        } else if (this.multibulkOnly) {
          throw new ProtocolError(PROTOCOL.INVALID_MULTIBULK);
        }
        // n <= 0: skipped like an empty line, as Redis does.
      } else if (this.multibulkOnly) {
        const first = this.chunks[this.head]![this.pos]!;
        throw new ProtocolError(expectedStar(String.fromCharCode(first)));
      } else {
        const argv = this.inline();
        if (argv === null) return null;
        if (argv.length > 0) return this.finish(argv);
      }
    }

    while (this.argsLeft > 0) {
      if (this.bulkLen < 0) {
        const len = this.bulkHeader();
        if (len === null) return null;
        this.bulkLen = len;
        if (len >= BIG_ARG) {
          // Safe to allocate: bulkHeader() already checked len against every limit.
          this.big = Buffer.allocUnsafe(len + 2);
          this.bigFilled = 0;
        }
      }
      let arg: string;
      if (this.big !== null) {
        this.bigFilled += this.copyOut(this.big, this.bigFilled);
        if (this.bigFilled < this.big.length) return null;
        expectCrlf(this.big, this.bulkLen);
        arg = this.big.toString('latin1', 0, this.bulkLen);
        this.big = null;
      } else {
        if (this.buffered < this.bulkLen + 2) return null;
        const body = this.take(this.bulkLen + 2);
        expectCrlf(body, this.bulkLen);
        arg = body.toString('latin1', 0, this.bulkLen);
      }
      this.argv.push(arg);
      this.bulkLen = -1;
      this.argsLeft--;
    }
    return this.finish(this.argv);
  }

  private finish(argv: string[]): ParsedCommand {
    const cmd = { argv, bytes: this.consumed };
    this.consumed = 0;
    this.argv = [];
    return cmd;
  }

  /** `*<n>\r\n`: the count, or null to wait. */
  private multibulkHeader(): number | null {
    const line = this.headerLine(PROTOCOL.TOO_BIG_MBULK);
    if (line === null) return null;
    const n = parseLength(line, 1, line.length - 2);
    if (Number.isNaN(n) || n > MAX_MULTIBULK_LEN)
      throw new ProtocolError(PROTOCOL.INVALID_MULTIBULK);
    if (n > MAX_UNAUTH_MULTIBULK_LEN && this.limits.authRequired()) {
      throw new ProtocolError(PROTOCOL.UNAUTH_MULTIBULK);
    }
    return n;
  }

  /** `$<len>\r\n`: the length, or null to wait. */
  private bulkHeader(): number | null {
    const line = this.headerLine(PROTOCOL.TOO_BIG_BULK);
    if (line === null) return null;
    if (line[0] !== DOLLAR) throw new ProtocolError(expectedDollar(String.fromCharCode(line[0]!)));
    const len = parseLength(line, 1, line.length - 2);
    if (Number.isNaN(len) || len < 0 || len > this.limits.maxBulkLen()) {
      throw new ProtocolError(PROTOCOL.INVALID_BULK);
    }
    if (len > MAX_UNAUTH_BULK_LEN && this.limits.authRequired()) {
      throw new ProtocolError(PROTOCOL.UNAUTH_BULK);
    }
    return len;
  }

  /**
   * A header line, through its CR and the byte after it. Like Redis, only the CR is looked for
   * and the next byte is skipped unseen.
   */
  private headerLine(tooBig: string): Buffer | null {
    const cr = this.find(CR);
    if (cr < 0) {
      if (this.buffered > MAX_INLINE_LEN) throw new ProtocolError(tooBig);
      return null;
    }
    if (this.buffered < cr + 2) return null;
    return this.take(cr + 2);
  }

  /** One inline line split into args (empty for a blank line), or null to wait. */
  private inline(): string[] | null {
    const lf = this.find(LF);
    if (lf < 0) {
      if (this.buffered > MAX_INLINE_LEN) throw new ProtocolError(PROTOCOL.TOO_BIG_INLINE);
      return null;
    }
    const line = this.take(lf + 1);
    const end = lf > 0 && line[lf - 1] === CR ? lf - 1 : lf;
    return splitArgs(line, end);
  }

  /** Offset of `byte` from the read position, or -1. Resumes a previous failed search. */
  private find(byte: number): number {
    let c = this.head;
    let base = 0;
    if (this.scanChunk >= 0) {
      c = this.scanChunk;
      base = this.scanBase;
    }
    for (; c < this.chunks.length; c++) {
      const chunk = this.chunks[c]!;
      const start = c === this.head ? this.pos : 0;
      const i = chunk.indexOf(byte, start);
      if (i !== -1) return base + i - start;
      base += chunk.length - start;
    }
    this.scanChunk = c;
    this.scanBase = base;
    return -1;
  }

  /** The next `n` bytes (a view when they sit in one chunk), consumed. */
  private take(n: number): Buffer {
    const first = this.chunks[this.head]!;
    let out: Buffer;
    if (this.pos + n <= first.length) {
      out = first.subarray(this.pos, this.pos + n);
    } else {
      out = Buffer.allocUnsafe(n);
      this.copyTo(out, 0, n);
    }
    this.advance(n);
    return out;
  }

  /** Moves as many bytes as are available (up to the target's end) into `target`. */
  private copyOut(target: Buffer, offset: number): number {
    const n = Math.min(this.buffered, target.length - offset);
    if (n > 0) {
      this.copyTo(target, offset, n);
      this.advance(n);
    }
    return n;
  }

  private copyTo(target: Buffer, offset: number, n: number): void {
    let c = this.head;
    let start = this.pos;
    while (n > 0) {
      const chunk = this.chunks[c]!;
      const len = Math.min(n, chunk.length - start);
      chunk.copy(target, offset, start, start + len);
      offset += len;
      n -= len;
      c++;
      start = 0;
    }
  }

  private advance(n: number): void {
    this.buffered -= n;
    this.consumed += n;
    this.scanChunk = -1;
    while (n > 0) {
      const avail = this.chunks[this.head]!.length - this.pos;
      if (n < avail) {
        this.pos += n;
        break;
      }
      n -= avail;
      this.head++;
      this.pos = 0;
    }
    // Drop consumed chunks so they can be collected, without shifting the array every time.
    if (this.head === this.chunks.length) {
      this.chunks = [];
      this.head = 0;
    } else if (this.head >= 1024) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
}

/** Redis skips two bytes after a bulk without looking; spec 10.1 requires them to be CRLF. */
function expectCrlf(buf: Buffer, at: number): void {
  if (buf[at] !== CR || buf[at + 1] !== LF) throw new ProtocolError(PROTOCOL.MISSING_CRLF);
}

const INT64_MAX = 9223372036854775807n;

/**
 * Redis's string2ll() over buf[start, end): optional '-', digits, no '+', no spaces, no leading
 * zeros except "0" itself, within int64. NaN if invalid. Values past 2^53 lose precision, which
 * is harmless: every caller rejects anything that large.
 */
function parseLength(buf: Buffer, start: number, end: number): number {
  let i = start;
  const neg = buf[i] === MINUS;
  if (neg) i++;
  const digits = end - i;
  if (digits <= 0 || digits > 19) return NaN;
  if (buf[i] === ZERO) return digits === 1 && !neg ? 0 : NaN;
  let v = 0;
  for (; i < end; i++) {
    const d = buf[i]! - ZERO;
    if (d < 0 || d > 9) return NaN;
    v = v * 10 + d;
  }
  if (digits === 19) {
    const exact = BigInt(buf.toString('latin1', start + (neg ? 1 : 0), end));
    if (exact > (neg ? INT64_MAX + 1n : INT64_MAX)) return NaN;
  }
  return neg ? -v : v;
}

// C's isspace(): space, \t, \n, \v, \f, \r.
const isSpace = (c: number): boolean => c === SPACE || (c >= TAB && c <= CR);

const hexValue = (c: number): number => {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
};

const unescape = (c: number): number => {
  switch (c) {
    case 0x6e: // n
      return LF;
    case 0x72: // r
      return CR;
    case 0x74: // t
      return TAB;
    case 0x62: // b
      return 0x08;
    case 0x61: // a
      return 0x07;
    default:
      return c;
  }
};

/**
 * sdssplitargs() over line[0, end); config files use it too, as in Redis. C sees the line as a
 * NUL-terminated string, so everything from the first NUL on is the end of input: it ends an
 * unquoted arg and unbalances a quote.
 */
export function splitArgs(line: Buffer, end: number = line.length): string[] {
  const nul = line.indexOf(NUL);
  const limit = nul !== -1 && nul < end ? nul : end;
  const at = (i: number): number => (i < limit ? line[i]! : NUL);
  const args: string[] = [];
  const tok = Buffer.allocUnsafe(limit);
  let p = 0;
  for (;;) {
    while (p < limit && isSpace(line[p]!)) p++;
    if (p >= limit) return args;
    let n = 0;
    let inDouble = false;
    let inSingle = false;
    let done = false;
    while (!done) {
      const c = at(p);
      if (inDouble) {
        if (
          c === BACKSLASH &&
          at(p + 1) === LOWER_X &&
          hexValue(at(p + 2)) >= 0 &&
          hexValue(at(p + 3)) >= 0
        ) {
          tok[n++] = hexValue(at(p + 2)) * 16 + hexValue(at(p + 3));
          p += 3;
        } else if (c === BACKSLASH && at(p + 1) !== NUL) {
          p++;
          tok[n++] = unescape(at(p));
        } else if (c === DQUOTE) {
          // A closing quote must be followed by a space or the end.
          if (at(p + 1) !== NUL && !isSpace(at(p + 1)))
            throw new ProtocolError(PROTOCOL.UNBALANCED_QUOTES);
          done = true;
        } else if (c === NUL) {
          throw new ProtocolError(PROTOCOL.UNBALANCED_QUOTES);
        } else {
          tok[n++] = c;
        }
      } else if (inSingle) {
        if (c === BACKSLASH && at(p + 1) === SQUOTE) {
          p++;
          tok[n++] = SQUOTE;
        } else if (c === SQUOTE) {
          if (at(p + 1) !== NUL && !isSpace(at(p + 1)))
            throw new ProtocolError(PROTOCOL.UNBALANCED_QUOTES);
          done = true;
        } else if (c === NUL) {
          throw new ProtocolError(PROTOCOL.UNBALANCED_QUOTES);
        } else {
          tok[n++] = c;
        }
      } else if (c === SPACE || c === LF || c === CR || c === TAB || c === NUL) {
        done = true; // unlike the skip above, \v and \f don't end an unquoted arg
      } else if (c === DQUOTE) {
        inDouble = true;
      } else if (c === SQUOTE) {
        inSingle = true;
      } else {
        tok[n++] = c;
      }
      if (at(p) !== NUL) p++;
    }
    args.push(tok.toString('latin1', 0, n));
  }
}
