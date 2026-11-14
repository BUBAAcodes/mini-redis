// The fuzzer's input generator (spec 15.6).
//
// Key design choice: a case is a pure function of (SEED, index): each one draws from its own
// Random seeded by mixing the two, so any failure replays alone with `SEED=… CASE=…` and the
// cases never depend on one another or on the order they ran in. Nothing here looks at the
// server; it only produces bytes.
//
// The corpus holds ordinary commands that are safe to run thousands of times: nothing that
// shuts down, saves, reconfigures, replicates or allocates a huge value. Mutations may still
// turn them into anything, which is the point.
import { Random } from '../../src/utils/random.js';

export type Category =
  | 'random-bytes'
  | 'mutated'
  | 'cut-frame'
  | 'huge-length'
  | 'negative-length'
  | 'inline-quotes'
  | 'long-inline'
  | 'before-auth'
  | 'pipeline';

export interface FuzzCase {
  readonly category: Category;
  /** Send it to the server that has `requirepass` set. */
  readonly locked: boolean;
  /** Written in order; the runner may pause between them so the parser sees partial input. */
  readonly chunks: readonly Buffer[];
}

export const PASSWORD = 'fuzz-secret';

/** Valid commands, as argv. */
export const CORPUS: readonly (readonly string[])[] = [
  ['PING'],
  ['PING', 'hello'],
  ['ECHO', 'abc'],
  ['SET', 'k', 'v'],
  ['SET', 'k', '10', 'EX', '100'],
  ['SET', 'k', 'v', 'NX', 'GET'],
  ['GET', 'k'],
  ['MSET', 'a', '1', 'b', '2'],
  ['MGET', 'a', 'b', 'c'],
  ['INCR', 'n'],
  ['INCRBY', 'n', '9223372036854775807'],
  ['INCRBYFLOAT', 'f', '1.5'],
  ['APPEND', 'k', 'xyz'],
  ['GETRANGE', 'k', '0', '-1'],
  ['DEL', 'k', 'a', 'b'],
  ['EXPIRE', 'k', '100'],
  ['TTL', 'k'],
  ['LPUSH', 'l', 'a', 'b', 'c'],
  ['RPOP', 'l'],
  ['LRANGE', 'l', '0', '-1'],
  ['LINSERT', 'l', 'BEFORE', 'a', 'x'],
  ['BLPOP', 'l', '0.01'],
  ['HSET', 'h', 'f', 'v', 'g', 'w'],
  ['HGETALL', 'h'],
  ['HINCRBYFLOAT', 'h', 'n', '0.5'],
  ['SADD', 's', 'a', 'b', 'c'],
  ['SMEMBERS', 's'],
  ['SINTER', 's', 't'],
  ['ZADD', 'z', '1.5', 'm', '2', 'n'],
  ['ZRANGE', 'z', '0', '-1', 'WITHSCORES'],
  ['ZRANGEBYSCORE', 'z', '-inf', '(5', 'LIMIT', '0', '2'],
  ['ZREM', 'z', 'm'],
  ['SCAN', '0', 'MATCH', 'k*', 'COUNT', '10'],
  ['KEYS', '*'],
  ['SELECT', '1'],
  ['MULTI'],
  ['EXEC'],
  ['DISCARD'],
  ['WATCH', 'k'],
  ['SUBSCRIBE', 'ch'],
  ['PSUBSCRIBE', 'c*'],
  ['PUBLISH', 'ch', 'hi'],
  ['HELLO', '3'],
  ['HELLO', '2', 'SETNAME', 'fuzz'],
  ['AUTH', 'nope'],
  ['CLIENT', 'SETNAME', 'n'],
  ['CLIENT', 'ID'],
  ['RESET'],
  ['INFO', 'server'],
  ['COMMAND', 'COUNT'],
  ['CONFIG', 'GET', 'maxmemory'],
  ['DBSIZE'],
  ['OBJECT', 'FREQ', 'k'],
  ['MEMORY', 'USAGE', 'k'],
];

export const encode = (argv: readonly string[]): Buffer =>
  Buffer.from(
    `*${argv.length}\r\n` + argv.map((a) => `$${a.length}\r\n${a}\r\n`).join(''),
    'latin1',
  );

const chance = (r: Random, percent: number): boolean => r.int(100) < percent;
const pick = <T>(r: Random, xs: readonly T[]): T => xs[r.int(xs.length)]!;
const bytes = (r: Random, n: number): Buffer => {
  const b = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) b[i] = r.int(256);
  return b;
};
const ascii = (s: string): Buffer => Buffer.from(s, 'latin1');

/** Flips, inserts or deletes 1–3 bytes, half of them in the first 24 (the frame headers). */
export function mutate(r: Random, input: Buffer): Buffer {
  let b = Buffer.from(input);
  for (let n = 1 + r.int(3); n > 0 && b.length > 0; n--) {
    const at = chance(r, 50) ? r.int(Math.min(24, b.length)) : r.int(b.length);
    switch (r.int(3)) {
      case 0:
        b[at] = b[at]! ^ (chance(r, 50) ? 1 << r.int(8) : 1 + r.int(255));
        break;
      case 1:
        b = Buffer.concat([b.subarray(0, at), Buffer.from([r.int(256)]), b.subarray(at)]);
        break;
      default:
        b = Buffer.concat([b.subarray(0, at), b.subarray(at + 1)]);
    }
  }
  return b;
}

const HUGE_FRAMES = [
  '*2147483648\r\n',
  '*2147483647\r\n',
  '*4294967296\r\n',
  '*4294967295\r\n',
  '*1048577\r\n',
  '*1048576\r\n',
  '*18446744073709551616\r\n',
  '*99999999999999999999999999\r\n',
  '*1\r\n$9999999999\r\n',
  '*1\r\n$2147483648\r\n',
  '*1\r\n$4294967296\r\n',
  '*1\r\n$536870913\r\n',
  '*1\r\n$67108865\r\n',
  '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$67108865\r\n',
  '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$67108864\r\nabc',
  '$9999999999\r\n',
  '*1\r\n$1\r\na\r\n*2147483648\r\n',
];

const NEGATIVE_FRAMES = [
  '*-1\r\n',
  '*-2\r\n',
  '*-9223372036854775808\r\n',
  '$-1\r\n',
  '$-2\r\n',
  '*1\r\n$-1\r\n',
  '*1\r\n$-5\r\n',
  '*2\r\n$3\r\nGET\r\n$-1\r\n',
  '*3\r\n$3\r\nSET\r\n$-9223372036854775808\r\nx\r\n',
  '*0\r\n',
  '*1\r\n$0\r\n\r\n',
  '*1\r\n$-\r\n',
  '*-\r\n',
  '*\r\n',
  '$\r\n',
];

function randomBytesCase(r: Random): Buffer {
  const size = chance(r, 5) ? 1000 + r.int(70_000) : 1 + r.int(80);
  const b = bytes(r, size);
  // Often start like a frame, so the parser gets past its first byte.
  if (chance(r, 40))
    b[0] = pick(
      r,
      ['*', '$', '+', '-', ':', '%', '~', '_'].map((c) => c.charCodeAt(0)),
    );
  return b;
}

function inlineQuotes(r: Random): Buffer {
  const alphabet = [
    '"',
    "'",
    '\\',
    ' ',
    'a',
    'x',
    '\\x4',
    '\\n',
    '\t',
    'GET',
    'SET',
    'k',
    '\0',
    '\r',
  ];
  let line = chance(r, 60) ? pick(r, ['SET ', 'GET ', 'ECHO ', 'PING ', '']) : '';
  for (let n = 1 + r.int(12); n > 0; n--) line += pick(r, alphabet);
  return ascii(line + pick(r, ['\r\n', '\n', '', '\r\n\r\n']));
}

function longInline(r: Random): Buffer {
  const size = 64 * 1024 + 1 + r.int(8 * 1024);
  const fill = pick(r, ['a', ' ', '"', 'a b ', '1']);
  const body = fill.repeat(Math.ceil(size / fill.length)).slice(0, size);
  switch (r.int(4)) {
    case 0:
      return ascii(body); // no line end at all
    case 1:
      return ascii(body + '\r\n');
    case 2:
      return ascii(`*1\r\n$${body}`); // a header line that never ends
    default:
      return ascii(`*${body.replaceAll(/\D/g, '1')}\r\n`);
  }
}

function beforeAuth(r: Random): Buffer {
  switch (r.int(7)) {
    case 0:
      return ascii('*11\r\n');
    case 1:
      return ascii(`*${11 + r.int(1_000_000)}\r\n$3\r\nGET\r\n`);
    case 2:
      return ascii(`*1\r\n$${16 * 1024 + 1 + r.int(1_000_000)}\r\n`);
    case 3: {
      // A real frame with an argument one byte past the limit.
      const arg = 'x'.repeat(16 * 1024 + 1);
      return Buffer.concat([
        ascii(`*2\r\n$4\r\nAUTH\r\n$${arg.length}\r\n`),
        ascii(arg),
        ascii('\r\n'),
      ]);
    }
    case 4:
      return Buffer.concat([ascii('*1\r\n$'), ascii(String(1_048_576 + r.int(9))), ascii('\r\n')]);
    case 5:
      // At the limits: ten arguments of 16 KB each are still allowed before AUTH.
      return encode([
        'AUTH',
        ...Array.from({ length: 1 + r.int(9) }, () => 'p'.repeat(r.int(16 * 1024))),
      ]);
    default:
      return mutate(r, encode(pick(r, CORPUS)));
  }
}

function pipeline(r: Random): Buffer {
  const n = 100 + r.int(2900);
  const parts: Buffer[] = [];
  for (let i = 0; i < n; i++) parts.push(encode(pick(r, CORPUS)));
  if (chance(r, 30)) parts.splice(r.int(parts.length), 0, mutate(r, encode(pick(r, CORPUS))));
  const all = Buffer.concat(parts);
  // Sometimes cut mid-frame, so the tail waits for bytes that never come.
  return chance(r, 30) ? all.subarray(0, r.int(all.length)) : all;
}

/** Splits `data` into 1–4 writes at random points. */
function split(r: Random, data: Buffer): Buffer[] {
  if (data.length < 2 || chance(r, 50)) return [data];
  const cuts = Array.from({ length: 1 + r.int(3) }, () => 1 + r.int(data.length - 1)).sort(
    (a, b) => a - b,
  );
  const out: Buffer[] = [];
  let from = 0;
  for (const c of [...new Set(cuts)]) {
    out.push(data.subarray(from, c));
    from = c;
  }
  out.push(data.subarray(from));
  return out;
}

const WEIGHTS: readonly [Category, number][] = [
  ['random-bytes', 14],
  ['mutated', 26],
  ['cut-frame', 12],
  ['huge-length', 10],
  ['negative-length', 8],
  ['inline-quotes', 10],
  ['long-inline', 4],
  ['before-auth', 8],
  ['pipeline', 8],
];

/** The case numbered `index` of the run seeded `seed`. */
export function generateCase(seed: number, index: number): FuzzCase {
  const r = new Random((seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  let roll = r.int(WEIGHTS.reduce((sum, [, w]) => sum + w, 0));
  let category: Category = 'mutated';
  for (const [c, w] of WEIGHTS) {
    if (roll < w) {
      category = c;
      break;
    }
    roll -= w;
  }
  let data: Buffer;
  let locked = chance(r, 10);
  switch (category) {
    case 'random-bytes':
      data = randomBytesCase(r);
      break;
    case 'mutated':
      data = mutate(r, encode(pick(r, CORPUS)));
      break;
    case 'cut-frame': {
      const frame = encode(pick(r, CORPUS));
      data = frame.subarray(0, r.int(frame.length));
      break;
    }
    case 'huge-length':
      data = ascii(
        chance(r, 20)
          ? `*${String(r.int(1e9))}${String(r.int(1e9))}${String(r.int(1e9))}\r\n`
          : pick(r, HUGE_FRAMES),
      );
      break;
    case 'negative-length':
      data = ascii(pick(r, NEGATIVE_FRAMES));
      break;
    case 'inline-quotes':
      data = inlineQuotes(r);
      break;
    case 'long-inline':
      data = longInline(r);
      break;
    case 'before-auth':
      data = beforeAuth(r);
      locked = true;
      break;
    default:
      data = pipeline(r);
  }
  return { category, locked, chunks: split(r, data) };
}
