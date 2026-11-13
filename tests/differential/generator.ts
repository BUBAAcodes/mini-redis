// The command generator for the differential harness (spec 15.3).
//
// Key design choice: every random decision comes from one seeded Random, and a command is only
// drawn if MiniRedis has registered it. So the same SEED replays the same run, and the commands
// of later steps (lists, hashes, ...) join the harness by appearing in the table, with a new
// entry in TEMPLATES below.
//
// Short WATCH/MULTI … EXEC blocks are mixed in (spec 15.3) once MULTI is registered: the commands
// inside are ordinary draws, so queue-time errors (EXECABORT), run-time errors (no rollback) and
// a change between WATCH and EXEC (a null EXEC) are all compared.
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

const MEMBERS = ['a', 'b', 'c', 'd', 'e', '1', '2', '10', ''];

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

  /**
   * A collection element: mostly from a tiny alphabet, so pivots, LREM values, set members and
   * hash fields collide, and sometimes any value (binary included).
   */
  member(): string {
    return this.chance(80) ? this.pick(MEMBERS) : this.value();
  }

  members(max: number): string[] {
    return Array.from({ length: 1 + this.rnd.int(max) }, () => this.member());
  }

  /** A score: a quarter (exact everywhere, spec 7.2), sometimes an infinity. */
  score(): string {
    return this.chance(8) ? this.pick(['inf', '-inf', '+inf']) : this.quarter();
  }

  /** A score-range bound: a quarter, maybe exclusive, or an infinity. */
  scoreBound(): string {
    if (this.chance(15)) return this.pick(['-inf', '+inf']);
    return (this.chance(30) ? '(' : '') + this.quarter();
  }

  /** A lex-range bound over the member alphabet. */
  lexBound(): string {
    if (this.chance(20)) return this.pick(['-', '+']);
    return this.pick(['[', '(']) + this.pick(MEMBERS);
  }

  /**
   * A key for the lex commands. Lex ranges are only defined when every score is equal, so these
   * keys are only written by `ZADD <key> 0 …` and ZREM: no other command reaches them.
   */
  lexKey(): string {
    return `z${this.rnd.int(3)}`;
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

/** ZUNIONSTORE / ZINTERSTORE: quarter weights keep every product and sum exact. */
const zstoreArgs = (g: Gen): string[] => {
  const srcs = keys(g);
  const out = [g.key(), String(srcs.length), ...srcs];
  if (g.chance(30)) out.push('WEIGHTS', ...srcs.map(() => g.quarter()));
  if (g.chance(30)) out.push('AGGREGATE', g.pick(['SUM', 'MIN', 'MAX']));
  return out;
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
  // Lists (step 9). Indexes stay small so they land inside and just outside the lists.
  lpush: [4, (g) => [g.key(), ...g.members(3)]],
  rpush: [4, (g) => [g.key(), ...g.members(3)]],
  lpop: [2, (g) => [g.key(), ...(g.chance(40) ? [g.int(0, 4)] : [])]],
  rpop: [2, (g) => [g.key(), ...(g.chance(40) ? [g.int(0, 4)] : [])]],
  llen: [2, (g) => [g.key()]],
  lrange: [3, (g) => [g.key(), g.int(-6, 6), g.int(-6, 6)]],
  lindex: [2, (g) => [g.key(), g.int(-6, 6)]],
  lset: [2, (g) => [g.key(), g.int(-4, 4), g.member()]],
  linsert: [2, (g) => [g.key(), g.pick(['BEFORE', 'AFTER']), g.member(), g.member()]],
  lrem: [2, (g) => [g.key(), g.int(-2, 2), g.member()]],
  ltrim: [1, (g) => [g.key(), g.int(-6, 6), g.int(-6, 6)]],
  lmove: [2, (g) => [g.key(), g.key(), g.pick(['LEFT', 'RIGHT']), g.pick(['LEFT', 'RIGHT'])]],
  // Hashes (step 10). HINCRBYFLOAT only touches the x0/x1 fields, which only ever hold
  // quarters, for the same reason as the f keys (spec 7.2).
  hset: [
    5,
    (g) =>
      g.chance(15)
        ? [g.key(), g.pick(['x0', 'x1']), g.quarter()]
        : [g.key(), ...g.members(3).flatMap((f) => [f, g.value()])],
  ],
  hget: [3, (g) => [g.key(), g.member()]],
  hmget: [2, (g) => [g.key(), ...g.members(3)]],
  hdel: [2, (g) => [g.key(), ...g.members(2)]],
  hexists: [2, (g) => [g.key(), g.member()]],
  hlen: [2, (g) => [g.key()]],
  hkeys: [1, (g) => [g.key()]],
  hvals: [1, (g) => [g.key()]],
  hgetall: [2, (g) => [g.key()]],
  hincrby: [2, (g) => [g.key(), g.member(), g.int(-100, 100)]],
  hincrbyfloat: [2, (g) => [g.key(), g.pick(['x0', 'x1']), g.quarter()]],
  // Sets (step 10). SPOP, SRANDMEMBER and SSCAN are random or cursor-based: never generated.
  sadd: [5, (g) => [g.key(), ...g.members(4)]],
  srem: [2, (g) => [g.key(), ...g.members(2)]],
  sismember: [2, (g) => [g.key(), g.member()]],
  smembers: [2, (g) => [g.key()]],
  scard: [2, (g) => [g.key()]],
  sinter: [2, keys],
  sunion: [2, keys],
  sdiff: [2, keys],
  sinterstore: [1, (g) => [g.key(), ...keys(g)]],
  sunionstore: [1, (g) => [g.key(), ...keys(g)]],
  sdiffstore: [1, (g) => [g.key(), ...keys(g)]],
  // Sorted sets (step 11). Scores are quarters, so sums and weights stay exact (spec 7.2).
  zadd: [
    6,
    (g) => {
      if (g.chance(15)) return [g.lexKey(), ...g.members(3).flatMap((m) => ['0', m])];
      const flags: string[] = [];
      if (g.chance(20)) flags.push(g.pick(['NX', 'XX']));
      if (g.chance(20)) flags.push(g.pick(['GT', 'LT']));
      if (g.chance(20)) flags.push('CH');
      if (g.chance(10)) return [g.key(), ...flags, 'INCR', g.score(), g.member()];
      return [g.key(), ...flags, ...g.members(3).flatMap((m) => [g.score(), m])];
    },
  ],
  zincrby: [2, (g) => [g.key(), g.quarter(), g.member()]],
  zscore: [2, (g) => [g.key(), g.member()]],
  zcard: [2, (g) => [g.pick([g.key(), g.lexKey()])]],
  zcount: [2, (g) => [g.key(), g.scoreBound(), g.scoreBound()]],
  zrange: [
    4,
    (g) => {
      const ws = g.chance(30) ? ['WITHSCORES'] : [];
      const rev = g.chance(30) ? ['REV'] : [];
      const lim = g.chance(30) ? ['LIMIT', g.int(-1, 3), g.int(-1, 3)] : [];
      switch (g.rnd.int(3)) {
        case 0:
          return [g.key(), g.int(-6, 6), g.int(-6, 6), ...rev, ...ws];
        case 1:
          return [g.key(), g.scoreBound(), g.scoreBound(), 'BYSCORE', ...rev, ...lim, ...ws];
        default:
          return [g.lexKey(), g.lexBound(), g.lexBound(), 'BYLEX', ...rev, ...lim];
      }
    },
  ],
  zrangebyscore: [
    2,
    (g) => [
      g.key(),
      g.scoreBound(),
      g.scoreBound(),
      ...(g.chance(30) ? ['WITHSCORES'] : []),
      ...(g.chance(30) ? ['LIMIT', g.int(-1, 3), g.int(-1, 3)] : []),
    ],
  ],
  zrevrangebyscore: [
    2,
    (g) => [g.key(), g.scoreBound(), g.scoreBound(), ...(g.chance(30) ? ['WITHSCORES'] : [])],
  ],
  zrangebylex: [2, (g) => [g.lexKey(), g.lexBound(), g.lexBound()]],
  zrevrange: [
    2,
    (g) => [g.key(), g.int(-6, 6), g.int(-6, 6), ...(g.chance(30) ? ['WITHSCORES'] : [])],
  ],
  zrank: [2, (g) => [g.key(), g.member(), ...(g.chance(30) ? ['WITHSCORE'] : [])]],
  zrevrank: [2, (g) => [g.key(), g.member(), ...(g.chance(30) ? ['WITHSCORE'] : [])]],
  zrem: [2, (g) => [g.pick([g.key(), g.lexKey()]), ...g.members(2)]],
  zremrangebyrank: [1, (g) => [g.key(), g.int(-6, 6), g.int(-6, 6)]],
  zremrangebyscore: [1, (g) => [g.key(), g.scoreBound(), g.scoreBound()]],
  zpopmin: [1, (g) => [g.key(), ...(g.chance(40) ? [g.int(0, 3)] : [])]],
  zpopmax: [1, (g) => [g.key(), ...(g.chance(40) ? [g.int(0, 3)] : [])]],
  zunionstore: [1, (g) => zstoreArgs(g)],
  zinterstore: [1, (g) => zstoreArgs(g)],
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
  private readonly transactions: boolean;
  /** The rest of a transaction block that next() has started handing out. */
  private pending: string[][] = [];

  /** `registered` is the set of command names MiniRedis knows. */
  constructor(seed: number, registered: ReadonlySet<string>) {
    this.g = new Gen(new Random(seed));
    this.transactions = ['multi', 'exec', 'discard', 'watch'].every((n) => registered.has(n));
    this.names = Object.keys(TEMPLATES).filter((n) => registered.has(n));
    this.weights = this.names.map((n) => TEMPLATES[n]![0]);
    this.total = this.weights.reduce((a, b) => a + b, 0);
    if (this.names.length === 0) throw new Error('no generatable commands are registered');
  }

  /** The next command. SELECT is mixed in so keys land in all databases. */
  next(): string[] {
    const queued = this.pending.shift();
    if (queued !== undefined) return queued;
    if (this.transactions && this.g.chance(3)) {
      this.pending = this.transactionBlock();
      return this.pending.shift()!;
    }
    return this.single();
  }

  /** What's left of an unfinished block, so a run never ends inside MULTI. */
  drain(): string[][] {
    const rest = this.pending;
    this.pending = [];
    return rest;
  }

  /**
   * [WATCH keys [a command that may touch them]] MULTI, 1–4 commands, then EXEC (or DISCARD, or
   * a broken EXEC that aborts at once). Now and then a nested MULTI or a WATCH inside, which
   * are errors that don't abort the transaction.
   */
  private transactionBlock(): string[][] {
    const g = this.g;
    const block: string[][] = [];
    if (g.chance(40)) {
      block.push(['WATCH', g.key(), ...(g.chance(50) ? [g.key()] : [])]);
      if (g.chance(50)) block.push(this.single());
    }
    block.push(['MULTI']);
    const n = 1 + g.rnd.int(4);
    for (let i = 0; i < n; i++) {
      if (g.chance(5)) block.push(g.pick([['MULTI'], ['WATCH', g.key()]]));
      block.push(this.single());
    }
    const r = g.rnd.int(100);
    block.push(r < 85 ? ['EXEC'] : r < 95 ? ['DISCARD'] : ['EXEC', 'x']);
    return block;
  }

  private single(): string[] {
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
