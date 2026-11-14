import { describe, expect, it } from 'vitest';
import {
  EVPOOL_SIZE,
  EvictionPool,
  LFU_INIT_VAL,
  estimateIdleSeconds,
  lfuDecrAndReturn,
  lfuLogIncr,
  lfuTimeInMinutes,
} from '../../src/storage/eviction.js';
import { Random } from '../../src/utils/random.js';

const pack = (minutes: number, counter: number): number => (minutes << 8) | counter;

describe('LFU counter (spec 9.4)', () => {
  it('reads the clock as 16-bit minutes', () => {
    expect(lfuTimeInMinutes(0)).toBe(0);
    expect(lfuTimeInMinutes(59_999)).toBe(0);
    expect(lfuTimeInMinutes(60_000)).toBe(1);
    expect(lfuTimeInMinutes(65_536 * 60_000)).toBe(0);
    expect(lfuTimeInMinutes(65_537 * 60_000 + 1)).toBe(1);
  });

  it('always increments below and at the initial value', () => {
    expect(lfuLogIncr(0, 10, 0.999)).toBe(1);
    expect(lfuLogIncr(LFU_INIT_VAL, 10, 0.999)).toBe(LFU_INIT_VAL + 1);
  });

  it('increments with probability 1 / ((counter - 5) * factor + 1)', () => {
    // counter 6, factor 10: p = 1/11.
    expect(lfuLogIncr(6, 10, 1 / 11 - 1e-9)).toBe(7);
    expect(lfuLogIncr(6, 10, 1 / 11)).toBe(6);
    // counter 105, factor 10: p = 1/1001.
    expect(lfuLogIncr(105, 10, 0.0009)).toBe(106);
    expect(lfuLogIncr(105, 10, 0.0011)).toBe(105);
  });

  it('with factor 0 always increments, and never passes 255', () => {
    expect(lfuLogIncr(200, 0, 0.999999)).toBe(201);
    expect(lfuLogIncr(255, 0, 0)).toBe(255);
    expect(lfuLogIncr(255, 10, 0)).toBe(255);
  });

  // redis.conf's table of counter values after N hits, per lfu-log-factor. The table is one
  // random run, so compare it with the mean of ten.
  it.each([
    [10, 100, 10],
    [10, 1_000, 18],
    [10, 100_000, 142],
    [100, 1_000_000, 143],
    [1, 1_000, 49],
  ])('factor %i after %i hits is about %i, as in redis.conf', (factor, hits, expected) => {
    let sum = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const rng = new Random(seed);
      let counter = LFU_INIT_VAL;
      for (let i = 0; i < hits; i++) counter = lfuLogIncr(counter, factor, rng.next());
      sum += counter;
    }
    expect(Math.abs(sum / 10 - expected)).toBeLessThanOrEqual(Math.max(2, expected * 0.08));
  });

  it('decays one step per lfu-decay-time minutes elapsed', () => {
    expect(lfuDecrAndReturn(pack(100, 20), 100, 1)).toBe(20);
    expect(lfuDecrAndReturn(pack(100, 20), 103, 1)).toBe(17);
    expect(lfuDecrAndReturn(pack(100, 20), 110, 5)).toBe(18);
    expect(lfuDecrAndReturn(pack(100, 20), 114, 5)).toBe(18);
    expect(lfuDecrAndReturn(pack(100, 20), 1000, 1)).toBe(0);
  });

  it('counts elapsed minutes mod 65536 across the clock wrapping', () => {
    expect(lfuDecrAndReturn(pack(65_530, 20), 4, 1)).toBe(10);
  });

  it('never decays with lfu-decay-time 0', () => {
    expect(lfuDecrAndReturn(pack(0, 20), 60_000, 0)).toBe(20);
  });
});

describe('LRU idle time (spec 9.4)', () => {
  it('is the clock difference in seconds, mod 2^24', () => {
    expect(estimateIdleSeconds(100, 100)).toBe(0);
    expect(estimateIdleSeconds(100, 160)).toBe(60);
    expect(estimateIdleSeconds(0xffffff - 9, 10)).toBe(20);
  });
});

describe('EvictionPool', () => {
  it('pops the best (highest) score first', () => {
    const pool = new EvictionPool();
    pool.insert(5, 0, 'b');
    pool.insert(9, 0, 'c');
    pool.insert(1, 0, 'a');
    expect(pool.pop()).toEqual({ dbId: 0, key: 'c' });
    expect(pool.pop()).toEqual({ dbId: 0, key: 'b' });
    expect(pool.pop()).toEqual({ dbId: 0, key: 'a' });
    expect(pool.pop()).toBeNull();
  });

  it('keeps only the best 16 seen across rounds', () => {
    const pool = new EvictionPool();
    for (let i = 0; i < 100; i++) pool.insert(i, 0, `k${i}`);
    expect(pool.size).toBe(EVPOOL_SIZE);
    // Worse than everything kept: ignored.
    pool.insert(-1, 0, 'worst');
    expect(pool.size).toBe(EVPOOL_SIZE);
    const popped: string[] = [];
    for (let e = pool.pop(); e !== null; e = pool.pop()) popped.push(e.key);
    expect(popped).toEqual(Array.from({ length: 16 }, (_, i) => `k${99 - i}`));
  });

  it('holds a key once per db, with its latest score', () => {
    const pool = new EvictionPool();
    pool.insert(5, 0, 'k');
    pool.insert(1, 0, 'other');
    pool.insert(0, 0, 'k');
    pool.insert(3, 1, 'k');
    expect(pool.size).toBe(3);
    expect(pool.pop()).toEqual({ dbId: 1, key: 'k' });
    expect(pool.pop()).toEqual({ dbId: 0, key: 'other' });
    expect(pool.pop()).toEqual({ dbId: 0, key: 'k' });
  });

  it('can be emptied', () => {
    const pool = new EvictionPool();
    pool.insert(5, 0, 'k');
    pool.clear();
    expect(pool.size).toBe(0);
    expect(pool.pop()).toBeNull();
  });
});
