/**
 * Hash table with incremental rehashing: the keyspace, every hash and every set sit on it
 * (spec 10.2).
 *
 * Key design choice: two tables. Growing or shrinking allocates `t1` and then moves one bucket
 * from `t0` per get/set/delete (plus serverCron's time-boxed batches), so resizing a table of
 * millions of keys never stalls the event loop (rule 10). The SCAN cursor counts in reverse
 * binary, so a key present for the whole scan is returned even if the table resizes between
 * calls.
 *
 * Mirrors Redis dict.c: _dictExpandIfNeeded, dictRehash, dictRehashMicroseconds, dictScan,
 * dictGetRandomKey and dictGetSomeKeys.
 */
import { murmur3_32 } from '../utils/hash.js';
import type { Random } from '../utils/random.js';

/** Smallest table size, and the size a dict starts and ends at. */
export const DICT_MIN_SIZE = 4;
/** A table shrinks once fewer than 1/SHRINK_RATIO of its buckets would be used. */
const SHRINK_RATIO = 10;
/** Empty buckets a rehash step may skip per bucket it was asked to move. */
const EMPTY_VISITS_PER_STEP = 10;
/** Buckets per batch in rehashMs(), between clock checks. */
const CRON_BATCH = 100;

interface Entry<V> {
  readonly key: string;
  value: V;
  next: Entry<V> | null;
}

type Table<V> = Array<Entry<V> | null>;

/** What every dict on one server shares: the hash seed and the random generator. */
export interface DictOptions {
  seed: number;
  rng: Random;
}

const newTable = <V>(size: number): Table<V> => new Array<Entry<V> | null>(size).fill(null);

/** Smallest power of two ≥ n, and at least DICT_MIN_SIZE. */
const tableSizeFor = (n: number): number => {
  let size = DICT_MIN_SIZE;
  while (size < n) size *= 2;
  return size;
};

/** Reverses all 32 bits of v; the result is unsigned. */
const rev32 = (v: number): number => {
  v = ((v >>> 1) & 0x55555555) | ((v & 0x55555555) << 1);
  v = ((v >>> 2) & 0x33333333) | ((v & 0x33333333) << 2);
  v = ((v >>> 4) & 0x0f0f0f0f) | ((v & 0x0f0f0f0f) << 4);
  v = ((v >>> 8) & 0x00ff00ff) | ((v & 0x00ff00ff) << 8);
  return ((v >>> 16) | (v << 16)) >>> 0;
};

/** Adds one to the cursor's bits above `mask`, counting from the top bit down. */
const nextCursor = (v: number, mask: number): number => {
  v |= ~mask;
  v = rev32(v);
  v = (v + 1) >>> 0;
  return rev32(v);
};

const visitBucket = <V>(t: Table<V>, i: number, fn: (key: string, value: V) => void): void => {
  for (let e = t[i]; e; e = e.next) fn(e.key, e.value);
};

export class Dict<V> {
  private t0: Table<V> = newTable(DICT_MIN_SIZE);
  private t1: Table<V> | null = null;
  private used0 = 0;
  private used1 = 0;
  /** Next t0 bucket to move into t1, or -1 when not rehashing. */
  private rehashIdx = -1;
  /** Full walks and scan calls in progress. While > 0: no rehash steps and no changes. */
  private walking = 0;
  private moved = 0;
  private readonly seed: number;
  private readonly rng: Random;

  constructor(options: DictOptions) {
    this.seed = options.seed;
    this.rng = options.rng;
  }

  get size(): number {
    return this.used0 + this.used1;
  }

  get isRehashing(): boolean {
    return this.rehashIdx !== -1;
  }

  /** The next t0 bucket a rehash step looks at, or -1. For tests and debugging. */
  get rehashIndex(): number {
    return this.rehashIdx;
  }

  /** Buckets moved from t0 to t1 so far, ever. Lets tests prove one bucket per operation. */
  get bucketsMoved(): number {
    return this.moved;
  }

  /** Sizes of t0 and t1 (0 when not rehashing). */
  tableSizes(): [number, number] {
    return [this.t0.length, this.t1?.length ?? 0];
  }

  get(key: string): V | undefined {
    this.step();
    return this.find(key, murmur3_32(key, this.seed))?.value;
  }

  has(key: string): boolean {
    this.step();
    return this.find(key, murmur3_32(key, this.seed)) !== null;
  }

  /** Inserts or overwrites. Returns true if the key is new. */
  set(key: string, value: V): boolean {
    this.assertNotWalking();
    this.step();
    const h = murmur3_32(key, this.seed);
    const existing = this.find(key, h);
    if (existing) {
      existing.value = value;
      return false;
    }
    this.expandIfNeeded();
    // While rehashing, new keys go straight to t1, so t0 only ever empties.
    const t = this.t1 ?? this.t0;
    const i = h & (t.length - 1);
    t[i] = { key, value, next: t[i] ?? null };
    if (this.t1) this.used1++;
    else this.used0++;
    return true;
  }

  /** Removes a key. Returns true if it was there. */
  delete(key: string): boolean {
    this.assertNotWalking();
    this.step();
    const h = murmur3_32(key, this.seed);
    if (this.unlink(this.t0, key, h)) this.used0--;
    else if (this.t1 && this.unlink(this.t1, key, h)) this.used1--;
    else return false;
    this.finishIfDone();
    this.maybeShrink();
    return true;
  }

  /** Drops everything and returns to the minimum size. O(1); the old tables become garbage. */
  clear(): void {
    this.assertNotWalking();
    this.t0 = newTable(DICT_MIN_SIZE);
    this.t1 = null;
    this.used0 = 0;
    this.used1 = 0;
    this.rehashIdx = -1;
  }

  /**
   * Starts a shrink if the table is mostly empty: size > 4 and used < size / 10. Called after
   * every delete and by serverCron. Returns true if it started one.
   */
  maybeShrink(): boolean {
    if (this.walking > 0 || this.rehashIdx !== -1) return false;
    const size = this.t0.length;
    if (size <= DICT_MIN_SIZE || this.used0 * SHRINK_RATIO >= size) return false;
    this.startRehash(tableSizeFor(this.used0));
    this.finishIfDone();
    return true;
  }

  /**
   * Moves up to `n` non-empty buckets from t0 to t1, giving up after n × 10 empty ones so a
   * sparse table can't turn one step into a long scan. Returns true while rehashing remains.
   */
  rehash(n: number): boolean {
    if (this.rehashIdx === -1 || this.walking > 0) return false;
    const t0 = this.t0;
    const t1 = this.t1!;
    const mask1 = t1.length - 1;
    let emptyVisits = n * EMPTY_VISITS_PER_STEP;
    while (n-- > 0 && this.used0 !== 0) {
      // used0 > 0 means a non-empty bucket lies ahead, so rehashIdx stays inside t0.
      while (!t0[this.rehashIdx]) {
        this.rehashIdx++;
        if (--emptyVisits === 0) return true;
      }
      let e = t0[this.rehashIdx] ?? null;
      let count = 0;
      while (e) {
        const next: Entry<V> | null = e.next;
        const i = murmur3_32(e.key, this.seed) & mask1;
        e.next = t1[i] ?? null;
        t1[i] = e;
        count++;
        e = next;
      }
      t0[this.rehashIdx] = null;
      this.used0 -= count;
      this.used1 += count;
      this.rehashIdx++;
      this.moved++;
    }
    this.finishIfDone();
    return this.rehashIdx !== -1;
  }

  /**
   * serverCron's share: rehash in batches of 100 buckets until done or `ms` has passed.
   * Returns the number of buckets moved.
   */
  rehashMs(ms: number): number {
    if (this.walking > 0) return 0;
    const before = this.moved;
    const start = performance.now();
    while (this.rehash(CRON_BATCH)) {
      if (performance.now() - start >= ms) break;
    }
    return this.moved - before;
  }

  /**
   * Visits every entry. Rehashing pauses and any change throws until it returns (spec 10.2),
   * so the walk sees each entry exactly once. Only for commands that are slow by design.
   */
  forEach(fn: (key: string, value: V) => void): void {
    this.walking++;
    try {
      const tables = this.t1 ? [this.t0, this.t1] : [this.t0];
      for (const t of tables) for (let i = 0; i < t.length; i++) visitBucket(t, i, fn);
    } finally {
      this.walking--;
    }
  }

  /**
   * One SCAN step: visits the bucket(s) the cursor points at and returns the next cursor; 0
   * means done. Every key present from the first call to the last is visited at least once,
   * whatever resizing happens in between; a key may be visited twice.
   */
  scan(cursor: number, fn: (key: string, value: V) => void): number {
    if (this.size === 0) return 0;
    let v = cursor >>> 0;
    this.walking++;
    try {
      if (this.t1 === null) {
        const m0 = this.t0.length - 1;
        visitBucket(this.t0, v & m0, fn);
        v = nextCursor(v, m0);
      } else {
        let small = this.t0;
        let big = this.t1;
        if (small.length > big.length) [small, big] = [big, small];
        const m0 = small.length - 1;
        const m1 = big.length - 1;
        visitBucket(small, v & m0, fn);
        // A small-table bucket splits into several big-table buckets: the cursor's bits above
        // m0 pick which ones. Visit all of them before moving on.
        do {
          visitBucket(big, v & m1, fn);
          v = nextCursor(v, m1);
        } while (v & (m0 ^ m1));
      }
    } finally {
      this.walking--;
    }
    return v;
  }

  /** A uniformly random bucket's random entry, or null if empty. */
  randomEntry(): [string, V] | null {
    if (this.size === 0) return null;
    let e: Entry<V> | null | undefined;
    if (this.t1) {
      // t0 buckets below rehashIdx are empty, so draw only from the rest of t0 and all of t1.
      const s0 = this.t0.length;
      const span = s0 + this.t1.length - this.rehashIdx;
      do {
        const h = this.rehashIdx + this.rng.int(span);
        e = h >= s0 ? this.t1[h - s0] : this.t0[h];
      } while (!e);
    } else {
      const mask = this.t0.length - 1;
      do e = this.t0[this.rng.uint32() & mask];
      while (!e);
    }
    let len = 0;
    for (let x: Entry<V> | null = e; x; x = x.next) len++;
    for (let k = this.rng.int(len); k > 0; k--) e = e.next!;
    return [e.key, e.value];
  }

  /**
   * Up to n distinct entries from consecutive buckets after a random start: cheap sampling for
   * eviction and active expiry. Stops after visiting n × 10 buckets, so it may return fewer.
   * After a run of empty buckets it jumps to a new random one, as Redis does: right after a
   * grow starts, the upper half of t1 is empty with no t0 buckets behind it, and a walk that
   * starts there would otherwise use up its steps and return nothing.
   */
  randomEntries(n: number): Array<[string, V]> {
    const count = Math.min(n, this.size);
    const out: Array<[string, V]> = [];
    if (count <= 0) return out;
    const t1 = this.t1;
    const maxMask = Math.max(this.t0.length, t1?.length ?? 0) - 1;
    let i = this.rng.uint32() & maxMask;
    let emptyRun = 0;
    // Buckets already taken from. A jump or a wrap-around can land on one again, and skipping
    // it keeps the entries distinct. At most `count` long, so a linear search is cheapest.
    const used: number[] = [];
    for (let steps = count * 10; steps > 0; steps--) {
      let skipT0 = false;
      if (t1 && i < this.rehashIdx) {
        // Already moved. Past the end of a smaller t1, nothing is left until rehashIdx: jump.
        if (i >= t1.length) i = this.rehashIdx;
        else skipT0 = true;
      }
      if (used.includes(i)) {
        i = (i + 1) & maxMask;
        continue;
      }
      const before = out.length;
      if (!skipT0 && i < this.t0.length) {
        for (let e = this.t0[i]; e; e = e.next) {
          out.push([e.key, e.value]);
          if (out.length === count) return out;
        }
      }
      if (t1 && i < t1.length) {
        for (let e = t1[i]; e; e = e.next) {
          out.push([e.key, e.value]);
          if (out.length === count) return out;
        }
      }
      if (out.length > before) {
        used.push(i);
        emptyRun = 0;
      } else if (++emptyRun >= 5 && emptyRun > count) {
        // dictGetSomeKeys's rule: too many empty buckets in a row, so try somewhere else.
        i = this.rng.uint32() & maxMask;
        emptyRun = 0;
        continue;
      }
      i = (i + 1) & maxMask;
    }
    return out;
  }

  /** Throws if any invariant is broken. For tests. O(n). */
  check(): void {
    const fail = (msg: string): never => {
      throw new Error(`Dict.check: ${msg}`);
    };
    const checkTable = (t: Table<V>, name: string): number => {
      if (t.length < DICT_MIN_SIZE || (t.length & (t.length - 1)) !== 0)
        fail(`${name} size ${t.length} isn't a power of two ≥ ${DICT_MIN_SIZE}`);
      let count = 0;
      for (let i = 0; i < t.length; i++) {
        for (let e = t[i]; e; e = e.next) {
          if ((murmur3_32(e.key, this.seed) & (t.length - 1)) !== i)
            fail(`${name}: key in the wrong bucket ${i}`);
          if (t === this.t0 && this.t1 && i < this.rehashIdx)
            fail(`t0 bucket ${i} is below rehashIdx ${this.rehashIdx} but not empty`);
          count++;
        }
      }
      return count;
    };
    if (checkTable(this.t0, 't0') !== this.used0) fail('used0 is wrong');
    if (this.t1 === null) {
      if (this.rehashIdx !== -1 || this.used1 !== 0) fail('rehash state without t1');
    } else {
      if (this.rehashIdx < 0 || this.rehashIdx > this.t0.length) fail('rehashIdx out of range');
      if (checkTable(this.t1, 't1') !== this.used1) fail('used1 is wrong');
      if (this.used0 === 0) fail('t0 is empty but the rehash never finished');
    }
    const seen = new Set<string>();
    this.forEach((k) => {
      if (seen.has(k)) fail('a key is stored twice');
      seen.add(k);
    });
  }

  private step(): void {
    if (this.rehashIdx !== -1 && this.walking === 0) this.rehash(1);
  }

  private find(key: string, h: number): Entry<V> | null {
    for (let e = this.t0[h & (this.t0.length - 1)]; e; e = e.next) if (e.key === key) return e;
    if (this.t1) {
      for (let e = this.t1[h & (this.t1.length - 1)]; e; e = e.next) if (e.key === key) return e;
    }
    return null;
  }

  /** Removes key from table t if it's there. Returns true if it was. */
  private unlink(t: Table<V>, key: string, h: number): boolean {
    const i = h & (t.length - 1);
    let prev: Entry<V> | null = null;
    for (let e = t[i]; e; prev = e, e = e.next) {
      if (e.key !== key) continue;
      if (prev) prev.next = e.next;
      else t[i] = e.next;
      return true;
    }
    return false;
  }

  private expandIfNeeded(): void {
    if (this.rehashIdx === -1 && this.used0 >= this.t0.length) this.startRehash(this.t0.length * 2);
  }

  private startRehash(size: number): void {
    this.t1 = newTable(size);
    this.used1 = 0;
    this.rehashIdx = 0;
  }

  /** Once t0 is empty, t1 becomes t0. Deletes can empty t0 early, which ends a rehash at once. */
  private finishIfDone(): void {
    if (this.rehashIdx === -1 || this.used0 !== 0) return;
    this.t0 = this.t1!;
    this.used0 = this.used1;
    this.t1 = null;
    this.used1 = 0;
    this.rehashIdx = -1;
  }

  private assertNotWalking(): void {
    if (this.walking > 0) throw new Error('Dict changed during a full walk or scan');
  }
}
