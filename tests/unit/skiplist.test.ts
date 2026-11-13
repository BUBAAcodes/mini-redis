import { describe, expect, it } from 'vitest';
import { LEX_MAX, LEX_MIN, Skiplist } from '../../src/datastructures/skiplist.js';
import type { LexBound, LexRange, SkiplistNode } from '../../src/datastructures/skiplist.js';
import { Random } from '../../src/utils/random.js';

const members = (zsl: Skiplist): string[] => {
  const out: string[] = [];
  for (let n: SkiplistNode | null = zsl.first; n !== null; n = n.next) out.push(n.member);
  return out;
};

const build = (pairs: Array<[number, string]>, seed = 1): Skiplist => {
  const zsl = new Skiplist(new Random(seed));
  for (const [s, m] of pairs) zsl.insert(s, m);
  return zsl;
};

describe('Skiplist (spec 10.3)', () => {
  it('orders by score, then by member bytes', () => {
    const zsl = build([
      [2, 'b'],
      [1, 'z'],
      [2, 'a'],
      [-Infinity, 'lo'],
      [Infinity, 'hi'],
      [2, '\xff'],
      [2, '\x00'],
    ]);
    expect(members(zsl)).toEqual(['lo', 'z', '\x00', 'a', 'b', '\xff', 'hi']);
    expect(zsl.last!.member).toBe('hi');
    zsl.check();
  });

  it('rank and byRank agree, 1-based', () => {
    const zsl = build(Array.from({ length: 1000 }, (_, i): [number, string] => [i % 37, `m${i}`]));
    zsl.check();
    for (let r = 1; r <= 1000; r += 7) {
      const n = zsl.byRank(r)!;
      expect(zsl.rank(n.score, n.member)).toBe(r);
    }
    expect(zsl.byRank(0)).toBeNull();
    expect(zsl.byRank(1001)).toBeNull();
    expect(zsl.rank(3, 'nope')).toBe(0);
  });

  it('updateScore moves a node only when its order changes', () => {
    const zsl = build([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
    const b = zsl.byRank(2)!;
    expect(zsl.updateScore(2, 'b', 2.5)).toBe(b);
    expect(zsl.updateScore(2.5, 'b', 10)).not.toBe(b);
    expect(members(zsl)).toEqual(['a', 'c', 'b']);
    zsl.check();
    expect(() => zsl.updateScore(99, 'a', 1)).toThrow();
  });

  it('finds the first and last node in score ranges, honouring exclusive bounds', () => {
    const zsl = build([1, 2, 3, 4, 5].map((s): [number, string] => [s, `m${s}`]));
    const r = (min: number, max: number, minex = false, maxex = false) => ({
      min,
      max,
      minex,
      maxex,
    });
    expect(zsl.firstInRange(r(2, 4))!.member).toBe('m2');
    expect(zsl.lastInRange(r(2, 4))!.member).toBe('m4');
    expect(zsl.firstInRange(r(2, 4, true))!.member).toBe('m3');
    expect(zsl.lastInRange(r(2, 4, false, true))!.member).toBe('m3');
    expect(zsl.firstInRange(r(-Infinity, Infinity))!.member).toBe('m1');
    expect(zsl.firstInRange(r(6, 9))).toBeNull();
    expect(zsl.firstInRange(r(3, 3, true))).toBeNull();
    expect(zsl.lastInRange(r(4, 2))).toBeNull();
    expect(zsl.firstInRange(r(2.1, 2.9))).toBeNull();
  });

  it('finds lex ranges, with - and +', () => {
    const zsl = build(['a', 'b', 'c', 'd'].map((m): [number, string] => [0, m]));
    const lex = (min: LexBound, max: LexBound, minex = false, maxex = false): LexRange => ({
      min,
      max,
      minex,
      maxex,
    });
    expect(zsl.firstInLexRange(lex('b', 'c'))!.member).toBe('b');
    expect(zsl.lastInLexRange(lex('b', 'c', false, true))!.member).toBe('b');
    expect(zsl.firstInLexRange(lex(LEX_MIN, LEX_MAX))!.member).toBe('a');
    expect(zsl.lastInLexRange(lex(LEX_MIN, LEX_MAX))!.member).toBe('d');
    expect(zsl.firstInLexRange(lex('b', 'b', true))).toBeNull();
    expect(
      zsl.firstInLexRange({ min: LEX_MAX, max: LEX_MAX, minex: false, maxex: false }),
    ).toBeNull();
  });

  it('deletes ranges by score, rank and lex, reporting each member', () => {
    const zsl = build(Array.from({ length: 20 }, (_, i): [number, string] => [i, `m${i}`]));
    const gone: string[] = [];
    expect(
      zsl.deleteRangeByScore({ min: 3, max: 5, minex: true, maxex: false }, (m) => gone.push(m)),
    ).toBe(2);
    expect(gone).toEqual(['m4', 'm5']);
    expect(zsl.deleteRangeByRank(1, 2, (m) => gone.push(m))).toBe(2);
    expect(gone.slice(2)).toEqual(['m0', 'm1']);
    zsl.check();
    expect(zsl.length).toBe(16);
    const lex = build(['a', 'b', 'c'].map((m): [number, string] => [0, m]));
    expect(lex.deleteRangeByLex({ min: 'a', max: 'b', minex: true, maxex: false }, () => {})).toBe(
      1,
    );
    expect(members(lex)).toEqual(['a', 'c']);
    lex.check();
  });

  it('check() passes after 100,000 random inserts, deletes and score updates', () => {
    const rnd = new Random(42);
    const zsl = new Skiplist(new Random(7));
    const scores = new Map<string, number>();
    for (let i = 0; i < 100_000; i++) {
      const m = `m${rnd.int(5000)}`;
      const s = rnd.int(200) / 4;
      const cur = scores.get(m);
      const op = rnd.int(3);
      if (cur === undefined) {
        zsl.insert(s, m);
        scores.set(m, s);
      } else if (op === 0) {
        expect(zsl.delete(cur, m)).toBe(true);
        scores.delete(m);
      } else {
        zsl.updateScore(cur, m, s);
        scores.set(m, s);
      }
    }
    zsl.check();
    expect(zsl.length).toBe(scores.size);
    expect(zsl.level).toBeGreaterThan(1);
    expect(zsl.level).toBeLessThanOrEqual(32);
  });
});
