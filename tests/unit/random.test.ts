import { describe, expect, it } from 'vitest';
import { Random } from '../../src/utils/random.js';

describe('Random', () => {
  it("matches xoshiro128**'s reference output for state {1, 2, 3, 4}", () => {
    const r = Random.fromState([1, 2, 3, 4]);
    expect([r.uint32(), r.uint32(), r.uint32(), r.uint32()]).toEqual([11520, 0, 5927040, 70819200]);
  });

  it('replays the same sequence from the same seed', () => {
    const a = new Random(81723);
    const b = new Random(81723);
    for (let i = 0; i < 1000; i++) expect(a.uint32()).toBe(b.uint32());
    expect(a.seed).toBe(81723);
  });

  it('gives different sequences for different seeds', () => {
    const a = new Random(1);
    const b = new Random(2);
    const same = Array.from({ length: 100 }, () => a.uint32() === b.uint32()).filter(Boolean);
    expect(same.length).toBeLessThan(3);
  });

  it('seeds itself from the OS when given no seed', () => {
    expect(new Random().seed).not.toBe(new Random().seed);
  });

  it('uint32() stays in range and next() stays in [0, 1)', () => {
    const r = new Random(7);
    for (let i = 0; i < 10_000; i++) {
      const u = r.uint32();
      expect(Number.isInteger(u) && u >= 0 && u < 2 ** 32).toBe(true);
      const f = r.next();
      expect(f >= 0 && f < 1).toBe(true);
    }
  });

  it('int(n) is uniform over [0, n)', () => {
    const r = new Random(11);
    const n = 7;
    const counts = new Array<number>(n).fill(0);
    const draws = 70_000;
    for (let i = 0; i < draws; i++) {
      const x = r.int(n);
      expect(x >= 0 && x < n).toBe(true);
      counts[x]!++;
    }
    // Each bucket expects 10,000; ±5% is about 10 standard deviations.
    for (const c of counts) expect(Math.abs(c - draws / n)).toBeLessThan(500);
  });

  it('int(n) handles n = 1, n = 2^32 and n beyond 32 bits', () => {
    const r = new Random(3);
    for (let i = 0; i < 100; i++) expect(r.int(1)).toBe(0);
    for (let i = 0; i < 1000; i++) {
      const a = r.int(2 ** 32);
      expect(a >= 0 && a < 2 ** 32).toBe(true);
      const b = r.int(2 ** 40);
      expect(Number.isInteger(b) && b >= 0 && b < 2 ** 40).toBe(true);
    }
  });
});
