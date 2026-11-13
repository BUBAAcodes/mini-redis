// The command generator for the differential harness (spec 15.3).
//
// Key design choice: every random decision comes from one seeded Random, and a command is only
// drawn if MiniRedis has registered it. So the same SEED replays the same run, and the commands
// of later steps (lists, hashes, ...) join the harness by appearing in the table, with a new
// entry in TEMPLATES below.
//
// Never generated, because they have their own tests (spec 15.3): random commands, SCAN cursors,
// OBJECT, MEMORY, INFO, DEBUG, CONFIG, CLIENT, blocking commands, pub/sub, persistence and
// replication commands. TTLs are at least 100 seconds, so nothing expires mid-run.
import { Random } from '../../src/utils/random.js';

export const DB_COUNT = 3;
const KEY_COUNT = 20;
const BROKEN_PERCENT = 5;

/**
 * Small alphabet so values collide and numeric strings turn up often. No value is near 2^63:
 * INCRBYFLOAT on one would show the long double vs double difference (DIFFERENCES.md), which the
 * spec avoids by sticking to values both sides hold exactly. Overflow has its own tests (step 6).
 */
const WORDS = [
  'a',
  'b',
  'hello',
  '',
  '0',
  '1',
  '-1',
  '42',
  '007',
  '-0',
  '123456789012',
  ' 1',
  '1.5',
  'x y',
];

export class Gen {
  constructor(readonly rnd: Random) {}

  pick<T>(items: readonly T[]): T {
    return items[this.rnd.int(items.length)]!;
  }

  chance(percent: number): boolean {
    return this.rnd.int(100) < percent;
  }

  key(): string {
    return `k${this.rnd.int(KEY_COUNT)}`;
  }

  /**
   * A key from the float pool. Only SET with a quarter and INCRBYFLOAT touch these, so they
   * always hold values both servers represent exactly (spec 7.2). The ordinary pool can't be
   * trusted: APPEND and SETRANGE can turn it into "1.542", where Redis's long doubles and our
   * doubles print different last digits (DIFFERENCES.md).
   */
  floatKey(): string {
    return `f${this.rnd.int(4)}`;
  }

  /** A word, a number, or a few random bytes (any of the 256 values, so binary data is compared). */
  value(): string {
    const r = this.rnd.int(10);
    if (r < 5) return this.pick(WORDS);
    if (r < 7) return String(this.rnd.int(2001) - 1000);
    let s = '';
    for (let i = 0, n = 1 + this.rnd.int(8); i < n; i++)
      s += String.fromCharCode(this.rnd.int(256));
    return s;
  }

  int(lo: number, hi: number): string {
    return String(lo + this.rnd.int(hi - lo + 1));
  }

  /** Multiples of 0.25 are exact in 64-bit doubles and in Redis's long doubles (spec 7.2). */
  quarter(): string {
    return String((this.rnd.int(81) - 40) / 4);
  }

  /** A relative TTL of at least 100 seconds, so a key never expires during a run. */
  ttlSeconds(): string {
    return this.int(100, 100_000);
  }

  /**
   * An absolute deadline far in the future (from the year 2096). It's a fixed base rather than
   * Date.now() so the same SEED produces the same bytes on any day, which replay needs.
   */
  deadlineMs(): number {
    return 4_000_000_000_000 + this.rnd.int(100_000_000);
  }

  /** A deadline in the past: the key is deleted at once, with no clock dependence in the reply. */
  pastMs(): number {
    return 1 + this.rnd.int(1_000_000);
  }
}

type Template = (g: Gen) => string[];

const keys = (g: Gen): string[] => Array.from({ length: 1 + g.rnd.int(3) }, () => g.key());
const expireFlag = (g: Gen): string[] => (g.chance(40) ? [g.pick(['NX', 'XX', 'GT', 'LT'])] : []);

const setTtl = (g: Gen): string[] => {
  switch (g.rnd.int(6)) {
    case 0:
      return ['EX', g.ttlSeconds()];
    case 1:
      return ['PX', String(100_000 + g.rnd.int(10_000_000))];
    case 2:
      return ['EXAT', String(Math.floor(g.deadlineMs() / 1000))];
    case 3:
      return ['PXAT', String(g.deadlineMs())];
    case 4:
      return ['KEEPTTL'];
    default:
      return [];
  }
};

/** name → [weight, builder]. Keep the weights roughly even so every command is exercised. */
const TEMPLATES: Record<string, [number, Template]> = {
  get: [6, (g) => [g.key()]],
  set: [
    14,
    (g) => {
      const opts = g.chance(30) ? [g.pick(['NX', 'XX'])] : [];
      if (g.chance(20)) opts.push('GET');
      if (g.chance(8)) return [g.floatKey(), g.quarter()];
      return [g.key(), g.value(), ...setTtl(g), ...opts];
    },
  ],
  getex: [
    3,
    (g) => [
      g.key(),
      ...g.pick([
        [],
        ['PERSIST'],
        ['EX', g.ttlSeconds()],
        ['PX', '200000'],
        ['PXAT', String(g.deadlineMs())],
      ]),
    ],
  ],
  getdel: [2, (g) => [g.key()]],
  mget: [3, keys],
  mset: [3, (g) => keys(g).flatMap((k) => [k, g.value()])],
  append: [4, (g) => [g.key(), g.value()]],
  strlen: [3, (g) => [g.key()]],
  incr: [3, (g) => [g.key()]],
  decr: [3, (g) => [g.key()]],
  incrby: [3, (g) => [g.key(), g.int(-1000, 1000)]],
  decrby: [3, (g) => [g.key(), g.int(-1000, 1000)]],
  incrbyfloat: [3, (g) => [g.floatKey(), g.quarter()]],
  getrange: [4, (g) => [g.key(), g.int(-10, 10), g.int(-10, 10)]],
  setrange: [3, (g) => [g.key(), g.int(0, 20), g.value()]],
  del: [3, keys],
  unlink: [1, keys],
  exists: [3, keys],
  type: [2, (g) => [g.key()]],
  keys: [2, (g) => [g.pick(['*', 'k1*', 'k?', 'k[12]*', 'k1[0-9]', 'nomatch*'])]],
  rename: [3, (g) => [g.key(), g.key()]],
  dbsize: [2, () => []],
  flushdb: [0.3, (g) => g.pick([[], ['ASYNC'], ['SYNC']])],
  flushall: [0.1, () => []],
  expire: [3, (g) => [g.key(), g.ttlSeconds(), ...expireFlag(g)]],
  pexpire: [2, (g) => [g.key(), String(100_000 + g.rnd.int(10_000_000)), ...expireFlag(g)]],
  expireat: [
    2,
    (g) => [
      g.key(),
      String(Math.floor((g.chance(10) ? g.pastMs() : g.deadlineMs()) / 1000)),
      ...expireFlag(g),
    ],
  ],
  pexpireat: [
    2,
    (g) => [g.key(), String(g.chance(10) ? g.pastMs() : g.deadlineMs()), ...expireFlag(g)],
  ],
  ttl: [3, (g) => [g.key()]],
  pttl: [3, (g) => [g.key()]],
  persist: [2, (g) => [g.key()]],
  ping: [1, (g) => (g.chance(50) ? [] : [g.value()])],
  echo: [1, (g) => [g.value()]],
};

// No out-of-int64 numbers here: one could land as a stored value and hit the INCRBYFLOAT precision
// difference. Out-of-range arguments are covered by the step 6 tests.
const BAD_INTS = ['abc', '1.5', '', '+1', '007', '-0', ' 1'];

/** Wrong arity, a non-integer, or a bogus option: error replies get compared too. */
function broken(g: Gen, good: string[]): string[] {
  switch (g.rnd.int(4)) {
    case 0:
      return good.slice(0, Math.max(0, good.length - 1));
    case 1:
      return [...good, g.value(), g.value()];
    case 2:
      return good.map((a, i) => (i > 0 && g.chance(60) ? g.pick(BAD_INTS) : a));
    default:
      return [...good, g.pick(['BOGUS', 'NX', 'EX', 'GT', 'KEEPTTL', '-5'])];
  }
}

export class Generator {
  private readonly names: string[];
  private readonly weights: number[];
  private readonly total: number;
  private readonly g: Gen;

  /** `registered` is the set of command names MiniRedis knows. */
  constructor(seed: number, registered: ReadonlySet<string>) {
    this.g = new Gen(new Random(seed));
    this.names = Object.keys(TEMPLATES).filter((n) => registered.has(n));
    this.weights = this.names.map((n) => TEMPLATES[n]![0]);
    this.total = this.weights.reduce((a, b) => a + b, 0);
    if (this.names.length === 0) throw new Error('no generatable commands are registered');
  }

  /** The next command. SELECT is mixed in so keys land in all databases. */
  next(): string[] {
    const g = this.g;
    if (g.chance(4)) return ['SELECT', String(g.rnd.int(DB_COUNT))];
    let r = g.rnd.next() * this.total;
    let i = 0;
    while (i < this.names.length - 1 && r >= this.weights[i]!) r -= this.weights[i++]!;
    const name = this.names[i]!;
    const good = TEMPLATES[name]![1](g);
    const args = g.chance(BROKEN_PERCENT) ? broken(g, good) : good;
    // Random upper/lower case on the name checks that command lookup is case-insensitive.
    return [g.chance(10) ? name : name.toUpperCase(), ...args];
  }
}
