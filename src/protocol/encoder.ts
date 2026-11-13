/**
 * Reply builders for RESP2 and RESP3 (spec 7.3): one call per reply element, written into a
 * pending output that the client flushes to its socket.
 *
 * Key design choice: output is built as latin1 byte strings (one char per byte, spec 7.1), so a
 * bulk's length is just `s.length` and nothing is ever re-encoded; the client turns the joined
 * string into a Buffer once, at the socket. The same calls produce RESP2 or RESP3 depending on
 * `resp`, so handlers never branch on the protocol version.
 *
 * Mirrors Redis networking.c (addReply*, addReplyArrayLen, addReplyMapLen, addReplyDouble …)
 * and util.c (d2string) / deps/fpconv for double formatting.
 */

export type RespVersion = 2 | 3;

/** What `array`, `set`, `map` and `push` accept: string → bulk, number/bigint → integer, null → null bulk. */
export type ReplyItem = string | number | bigint | null | readonly ReplyItem[];

const CRLF = '\r\n';

/** Error and status lines must not break the protocol; Redis replaces CR and LF with spaces. */
const oneLine = (s: string): string => s.replace(/[\r\n]/g, ' ');

/** "WRONGTYPE …", "ERR …": an all-caps first word is the error code. */
const HAS_CODE = /^[A-Z]+ /;

export class Reply {
  /** May change mid-connection (HELLO 3); every later element uses the new version. */
  resp: RespVersion;
  private out: string[] = [];
  private bytes = 0;

  constructor(resp: RespVersion = 2) {
    this.resp = resp;
  }

  /** Bytes waiting to be sent, for the output buffer limits. */
  get pendingBytes(): number {
    return this.bytes;
  }

  /** Everything written since the last call, as one byte string. */
  take(): string {
    const s = this.out.length === 1 ? this.out[0]! : this.out.join('');
    this.out = [];
    this.bytes = 0;
    return s;
  }

  ok(): void {
    this.write('+OK\r\n');
  }

  simple(s: string): void {
    this.write(`+${oneLine(s)}${CRLF}`);
  }

  /** `msg` should start with its code; one without gets ERR, as addReplyError does. */
  error(msg: string): void {
    const line = oneLine(msg);
    this.write(HAS_CODE.test(line) ? `-${line}${CRLF}` : `-ERR ${line}${CRLF}`);
  }

  integer(n: number | bigint): void {
    this.write(`:${n}${CRLF}`);
  }

  bulk(s: string): void {
    this.write(`$${s.length}${CRLF}${s}${CRLF}`);
  }

  nullBulk(): void {
    this.write(this.resp === 3 ? '_\r\n' : '$-1\r\n');
  }

  nullArray(): void {
    this.write(this.resp === 3 ? '_\r\n' : '*-1\r\n');
  }

  array(items: readonly ReplyItem[]): void {
    this.arrayLen(items.length);
    for (const item of items) this.item(item);
  }

  map(pairs: readonly (readonly [ReplyItem, ReplyItem])[]): void {
    this.mapLen(pairs.length);
    for (const [k, v] of pairs) {
      this.item(k);
      this.item(v);
    }
  }

  set(items: readonly ReplyItem[]): void {
    this.setLen(items.length);
    for (const item of items) this.item(item);
  }

  push(items: readonly ReplyItem[]): void {
    this.pushLen(items.length);
    for (const item of items) this.item(item);
  }

  double(x: number): void {
    const s = formatDouble(x);
    this.write(this.resp === 3 ? `,${s}${CRLF}` : `$${s.length}${CRLF}${s}${CRLF}`);
  }

  bool(b: boolean): void {
    if (this.resp === 3) this.write(b ? '#t\r\n' : '#f\r\n');
    else this.write(b ? ':1\r\n' : ':0\r\n');
  }

  /** INFO and CLIENT LIST: plain text that RESP3 clients may show as-is. */
  verbatim(s: string): void {
    this.write(
      this.resp === 3 ? `=${s.length + 4}${CRLF}txt:${s}${CRLF}` : `$${s.length}${CRLF}${s}${CRLF}`,
    );
  }

  // Headers for replies built element by element (mixed types, or too big to materialise).

  arrayLen(n: number): void {
    this.write(`*${n}${CRLF}`);
  }

  /** `n` pairs; the caller then writes 2n elements. */
  mapLen(n: number): void {
    this.write(this.resp === 3 ? `%${n}${CRLF}` : `*${n * 2}${CRLF}`);
  }

  setLen(n: number): void {
    this.write(this.resp === 3 ? `~${n}${CRLF}` : `*${n}${CRLF}`);
  }

  pushLen(n: number): void {
    this.write(this.resp === 3 ? `>${n}${CRLF}` : `*${n}${CRLF}`);
  }

  private item(item: ReplyItem): void {
    if (typeof item === 'string') this.bulk(item);
    else if (item === null) this.nullBulk();
    else if (typeof item === 'number' || typeof item === 'bigint') this.integer(item);
    else this.array(item);
  }

  private write(s: string): void {
    this.out.push(s);
    this.bytes += s.length;
  }
}

/** (double)(LLONG_MAX / 2): Redis's double2ll() only takes the integer path inside ±2^62. */
const LL_SAFE = 4611686018427387904;

/**
 * Formats a double exactly as Redis 7.4's d2string(): `inf`, `-inf`, `nan`, `-0`; integral values
 * within ±2^62 as their exact integer; anything else through fpconv_dtoa's emit_digits rules,
 * fed with the shortest round-trip digits JS gives us.
 */
export function formatDouble(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  // d2string keeps the sign of zero (ZINCRBY k -0 new replies "-0").
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  // BigInt, not String(): String(2 ** 62) is 4611686018427388000, Redis prints every digit.
  if (Number.isInteger(x) && x >= -LL_SAFE && x <= LL_SAFE) return BigInt(x).toString();

  const sci = x.toExponential(); // e.g. "-1.2345e+20": shortest digits that round-trip
  const neg = x < 0;
  const e = sci.indexOf('e');
  const digits = sci.slice(neg ? 1 : 0, e).replace('.', '');
  const nd = digits.length;
  const exp10 = Number(sci.slice(e + 1)); // exponent of the first digit
  const k = exp10 - nd + 1; // exponent of the last digit, fpconv's K
  const exp = Math.abs(exp10);

  let body: string;
  if (k >= 0 && exp < nd + 7) {
    body = digits + '0'.repeat(k);
  } else if (k < 0 && (k > -7 || exp < 4)) {
    const point = nd + k;
    body =
      point <= 0
        ? '0.' + '0'.repeat(-point) + digits
        : digits.slice(0, point) + '.' + digits.slice(point);
  } else {
    body = digits[0]! + (nd > 1 ? '.' + digits.slice(1) : '') + (exp10 < 0 ? 'e-' : 'e+') + exp;
  }
  return neg ? '-' + body : body;
}
