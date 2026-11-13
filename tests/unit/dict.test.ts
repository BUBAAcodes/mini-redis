import { describe, expect, it } from 'vitest';
import { Dict, DICT_MIN_SIZE } from '../../src/datastructures/dict.js';
import { Random } from '../../src/utils/random.js';

const newDict = <V>(seed = 1): Dict<V> => new Dict<V>({ seed, rng: new Random(seed) });

/** Fills a dict with `n` keys and finishes any rehash, so the table sizes are settled. */
const filled = (n: number, seed = 1): Dict<number> => {
  const d = newDict<number>(seed);
  for (let i = 0; i < n; i++) d.set(`k${i}`, i);
  while (d.rehash(1000));
  return d;
};

const fullScan = <V>(d: Dict<V>): string[] => {
  const keys: string[] = [];
  let cursor = 0;
  do cursor = d.scan(cursor, (k) => keys.push(k));
  while (cursor !== 0);
  return keys;
};

describe('Dict basics', () => {
  it('starts empty with the minimum table size', () => {
    const d = newDict<string>();
    expect(d.size).toBe(0);
    expect(d.tableSizes()).toEqual([DICT_MIN_SIZE, 0]);
    expect(d.get('nope')).toBeUndefined();
    expect(d.has('nope')).toBe(false);
    expect(d.delete('nope')).toBe(false);
    d.check();
  });

  it('sets, overwrites, reads and deletes', () => {
    const d = newDict<string>();
    expect(d.set('a', '1')).toBe(true);
    expect(d.set('a', '2')).toBe(false);
    expect(d.get('a')).toBe('2');
    expect(d.has('a')).toBe(true);
    expect(d.size).toBe(1);
    expect(d.delete('a')).toBe(true);
    expect(d.delete('a')).toBe(false);
    expect(d.size).toBe(0);
  });

  it('keeps binary keys apart, byte for byte', () => {
    const d = newDict<number>();
    for (let b = 0; b < 256; b++) d.set(String.fromCharCode(b), b);
    d.set('\xff\xfe', 1000);
    for (let b = 0; b < 256; b++) expect(d.get(String.fromCharCode(b))).toBe(b);
    expect(d.get('\xff\xfe')).toBe(1000);
    expect(d.get('\xfe\xff')).toBeUndefined();
    d.check();
  });

  it('clear() empties the dict back to the minimum size', () => {
    const d = filled(100);
    d.clear();
    expect(d.size).toBe(0);
    expect(d.tableSizes()).toEqual([DICT_MIN_SIZE, 0]);
    expect(d.isRehashing).toBe(false);
  });
});

describe('Dict growth and incremental rehashing', () => {
  it('starts growing to twice the size once used reaches size', () => {
    const d = newDict<number>();
    for (let i = 0; i < 4; i++) d.set(`k${i}`, i);
    expect(d.isRehashing).toBe(false);
    d.set('k4', 4);
    expect(d.isRehashing).toBe(true);
    expect(d.tableSizes()).toEqual([4, 8]);
    d.check();
  });

  it('finds keys in both tables while rehashing, and inserts into the new one', () => {
    const d = filled(64);
    d.set('trigger', -1);
    expect(d.isRehashing).toBe(true);
    for (let i = 0; i < 64; i++) expect(d.get(`k${i}`)).toBe(i);
    expect(d.get('trigger')).toBe(-1);
    d.check();
  });

  it('a single rehash step skips at most 10 empty buckets', () => {
    // 5,000 keys settle in 8,192 buckets. Deleting until a shrink starts leaves t0 about 90% empty.
    const d = filled(5000);
    expect(d.tableSizes()).toEqual([8192, 0]);
    let i = 0;
    while (!d.isRehashing) d.delete(`k${i++}`);
    expect(d.tableSizes()).toEqual([8192, 1024]);
    let emptySteps = 0;
    for (;;) {
      const before = d.rehashIndex;
      const moved = d.bucketsMoved;
      d.rehash(1);
      if (!d.isRehashing) break;
      expect(d.rehashIndex - before).toBeGreaterThan(0);
      expect(d.rehashIndex - before).toBeLessThanOrEqual(10);
      expect(d.bucketsMoved - moved).toBeLessThanOrEqual(1);
      if (d.bucketsMoved === moved) emptySteps++;
    }
    // Some steps hit 10 empty buckets in a row and gave up without moving anything.
    expect(emptySteps).toBeGreaterThan(0);
    d.check();
  });

  it('grows from 0 to 1M keys and back down, never moving more than one bucket per operation', () => {
    const d = newDict<number>();
    const n = 1_000_000;
    let maxMoved = 0;
    let last = d.bucketsMoved;
    const track = (): void => {
      const moved = d.bucketsMoved - last;
      if (moved > maxMoved) maxMoved = moved;
      last = d.bucketsMoved;
    };

    for (let i = 0; i < n; i++) {
      d.set(`key:${i}`, i);
      track();
      if ((i & 1023) === 0) {
        d.get(`key:${i >> 1}`);
        track();
      }
    }
    expect(d.size).toBe(n);
    expect(Math.max(...d.tableSizes())).toBe(2 ** 20);
    d.check();

    // A plain counter, not expect() per call: a million expects would dominate the run time.
    let missing = 0;
    for (let i = 0; i < n; i++) {
      if (!d.delete(`key:${i}`)) missing++;
      track();
    }
    expect(missing).toBe(0);
    expect(maxMoved).toBe(1);
    expect(d.size).toBe(0);
    // Every grow and shrink also finished, through operations alone.
    expect(d.isRehashing).toBe(false);
    expect(d.tableSizes()).toEqual([DICT_MIN_SIZE, 0]);
    d.check();
  }, 30_000);

  it('operations alone finish a grow before the next one is due', () => {
    const d = filled(1024);
    d.set('trigger', 0);
    expect(d.tableSizes()).toEqual([1024, 2048]);
    for (let i = 0; i < 1024 && d.isRehashing; i++) d.get(`k${i}`);
    expect(d.isRehashing).toBe(false);
    expect(d.tableSizes()).toEqual([2048, 0]);
  });

  it('rehashMs() moves buckets in batches until done or out of time', () => {
    const d = filled(2 ** 17);
    d.set('trigger', 0);
    expect(d.isRehashing).toBe(true);
    let moved = 0;
    while (d.isRehashing) moved += d.rehashMs(1);
    expect(moved).toBeGreaterThan(0);
    expect(d.tableSizes()).toEqual([2 ** 18, 0]);
    expect(d.rehashMs(1)).toBe(0);
    d.check();
  });
});

describe('Dict shrinking', () => {
  it('shrinks when used < size / 10, to the next power of two ≥ used', () => {
    const d = filled(64);
    expect(d.tableSizes()).toEqual([64, 0]);
    for (let i = 63; i >= 7; i--) d.delete(`k${i}`);
    expect(d.size).toBe(7);
    expect(d.isRehashing).toBe(false); // 7 is not below 6.4
    d.delete('k6');
    expect(d.tableSizes()).toEqual([64, 8]);
    while (d.rehash(100));
    expect(d.tableSizes()).toEqual([8, 0]);
    for (let i = 0; i < 6; i++) expect(d.get(`k${i}`)).toBe(i);
    d.check();
  });

  it('never shrinks below the minimum size', () => {
    const d = filled(3);
    expect(d.maybeShrink()).toBe(false);
    d.delete('k0');
    d.delete('k1');
    d.delete('k2');
    expect(d.tableSizes()).toEqual([DICT_MIN_SIZE, 0]);
  });

  it('maybeShrink() is what serverCron calls; it does nothing mid-rehash', () => {
    const d = filled(64);
    d.set('trigger', 0);
    expect(d.isRehashing).toBe(true);
    expect(d.maybeShrink()).toBe(false);
  });
});

describe('Dict full walks', () => {
  it('forEach visits every entry once', () => {
    const d = filled(1000);
    d.set('trigger', -1); // walk mid-rehash too
    const seen = new Map<string, number>();
    d.forEach((k, v) => seen.set(k, v));
    expect(seen.size).toBe(1001);
    expect(seen.get('k999')).toBe(999);
  });

  it('pauses rehashing and rejects changes during a walk', () => {
    const d = filled(64);
    d.set('trigger', 0);
    expect(d.isRehashing).toBe(true);
    const moved = d.bucketsMoved;
    d.forEach(() => {
      d.get('k1');
      expect(d.rehash(10)).toBe(false);
      expect(d.rehashMs(1)).toBe(0);
      expect(d.maybeShrink()).toBe(false);
      expect(() => d.set('k1', 1)).toThrow(/during a full walk/);
      expect(() => d.delete('k1')).toThrow(/during a full walk/);
      expect(() => d.clear()).toThrow(/during a full walk/);
    });
    expect(d.bucketsMoved).toBe(moved);
    // The walk is over: changes work again, even after a callback threw.
    expect(() =>
      d.forEach(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(d.set('after', 1)).toBe(true);
  });

  it('a scan callback may not change the dict either', () => {
    const d = filled(10);
    expect(() => d.scan(0, () => d.set('x', 1))).toThrow(/during a full walk/);
    expect(d.set('x', 1)).toBe(true);
  });
});

describe('Dict SCAN cursor', () => {
  it('returns 0 at once on an empty dict', () => {
    expect(newDict<number>().scan(0, () => {})).toBe(0);
  });

  it('visits every key exactly once on a stable dict', () => {
    const d = filled(5000);
    const keys = fullScan(d);
    expect(keys.length).toBe(5000);
    expect(new Set(keys).size).toBe(5000);
  });

  it('visits every key mid-rehash, in both directions', () => {
    const grow = filled(512);
    grow.set('trigger', 0);
    for (let i = 0; i < 50; i++) grow.get('k0');
    expect(grow.isRehashing).toBe(true);
    expect(new Set(fullScan(grow)).size).toBe(513);

    const shrink = filled(512);
    for (let i = 20; i < 512; i++) shrink.delete(`k${i}`);
    expect(shrink.isRehashing).toBe(true);
    expect(new Set(fullScan(shrink)).size).toBe(20);
  });

  it('cursors are unsigned 32-bit numbers', () => {
    const d = filled(100);
    let cursor = 0;
    do {
      cursor = d.scan(cursor, () => {});
      expect(Number.isInteger(cursor) && cursor >= 0 && cursor < 2 ** 32).toBe(true);
    } while (cursor !== 0);
  });
});

describe('Dict sampling', () => {
  it('randomEntry() returns null when empty and only live entries otherwise', () => {
    const d = newDict<number>();
    expect(d.randomEntry()).toBeNull();
    for (let i = 0; i < 1000; i++) d.set(`k${i}`, i);
    for (let i = 0; i < 1000; i += 2) d.delete(`k${i}`);
    for (let i = 0; i < 2000; i++) {
      const e = d.randomEntry();
      expect(e).not.toBeNull();
      const [k, v] = e!;
      expect(d.get(k)).toBe(v);
      expect(v % 2).toBe(1);
    }
  });

  it('randomEntry() reaches every key, including mid-rehash', () => {
    const d = filled(4);
    d.set('k4', 4);
    expect(d.isRehashing).toBe(true);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(d.randomEntry()![0]);
    expect(seen.size).toBe(5);
  });

  it('randomEntries(n) returns at most n distinct live entries', () => {
    const d = filled(10_000);
    for (let i = 0; i < 9000; i++) d.delete(`k${i}`);
    for (const rehashing of [true, false]) {
      expect(d.isRehashing).toBe(rehashing);
      for (let round = 0; round < 500; round++) {
        const sample = d.randomEntries(16);
        expect(sample.length).toBeLessThanOrEqual(16);
        expect(new Set(sample.map(([k]) => k)).size).toBe(sample.length);
        for (const [k, v] of sample) {
          expect(v).toBeGreaterThanOrEqual(9000);
          expect(d.get(k)).toBe(v);
        }
      }
      while (d.rehash(1000));
    }
  });

  it('randomEntries(n) still finds entries when a grow has just started', () => {
    // Right after a grow starts, the upper half of the new table is empty and has no old
    // buckets behind it. A walk that starts there must jump elsewhere instead of giving up
    // empty-handed, as Redis's dictGetSomeKeys does; active expiry stopped early without it.
    const d = newDict<number>();
    for (let i = 0; !d.isRehashing || i < 4000; i++) d.set(`k${i}`, i);
    expect(d.isRehashing).toBe(true);
    for (let round = 0; round < 2000; round++) {
      const sample = d.randomEntries(20);
      expect(sample.length).toBeGreaterThan(0);
      expect(new Set(sample.map(([k]) => k)).size).toBe(sample.length);
      for (const [k, v] of sample) expect(d.get(k)).toBe(v);
    }
  });

  it('randomEntries(n) never returns more than the dict holds', () => {
    const d = filled(3);
    expect(d.randomEntries(10).length).toBe(3);
    expect(newDict<number>().randomEntries(5)).toEqual([]);
  });
});
