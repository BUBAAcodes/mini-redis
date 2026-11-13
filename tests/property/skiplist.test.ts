import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Skiplist } from '../../src/datastructures/skiplist.js';
import type { ScoreRange, SkiplistNode } from '../../src/datastructures/skiplist.js';
import { Random } from '../../src/utils/random.js';

type Entry = [number, string];
const cmp = (a: Entry, b: Entry): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;

const memberArb = fc.oneof(
  fc.integer({ min: 0, max: 40 }).map((i) => `m${i}`),
  fc.uint8Array({ maxLength: 2 }).map((b) => Buffer.from(b).toString('latin1')),
);
const scoreArb = fc.oneof(
  fc.integer({ min: -8, max: 8 }).map((i) => i / 2),
  fc.constantFrom(-Infinity, Infinity),
);

type Op =
  | { t: 'add'; m: string; s: number }
  | { t: 'del'; m: string }
  | { t: 'delScore'; r: ScoreRange }
  | { t: 'delRank'; a: number; b: number };

const rangeArb: fc.Arbitrary<ScoreRange> = fc.record({
  min: scoreArb,
  max: scoreArb,
  minex: fc.boolean(),
  maxex: fc.boolean(),
});

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({ t: fc.constant('add' as const), m: memberArb, s: scoreArb }),
  },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('del' as const), m: memberArb }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('delScore' as const), r: rangeArb }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('delRank' as const),
      a: fc.integer({ min: 1, max: 30 }),
      b: fc.integer({ min: 1, max: 30 }),
    }),
  },
);

const inRange = (s: number, r: ScoreRange): boolean =>
  (r.minex ? s > r.min : s >= r.min) && (r.maxex ? s < r.max : s <= r.max);

describe('Skiplist against a sorted array (spec 15.4)', () => {
  it('keeps the same order, ranks and ranges', () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.array(opArb, { maxLength: 150 }),
        rangeArb,
        (seed, ops, probe) => {
          const zsl = new Skiplist(new Random(seed));
          const scores = new Map<string, number>();
          let model: Entry[] = [];
          const resort = () => {
            model = [...scores].map(([m, s]): Entry => [s, m]).sort(cmp);
          };
          for (const op of ops) {
            if (op.t === 'add') {
              const cur = scores.get(op.m);
              if (cur === undefined) zsl.insert(op.s, op.m);
              else zsl.updateScore(cur, op.m, op.s);
              scores.set(op.m, op.s);
            } else if (op.t === 'del') {
              const cur = scores.get(op.m);
              expect(zsl.delete(cur ?? 0, op.m)).toBe(cur !== undefined);
              scores.delete(op.m);
            } else if (op.t === 'delScore') {
              const gone: string[] = [];
              zsl.deleteRangeByScore(op.r, (m) => gone.push(m));
              const want = model.filter(([s]) => inRange(s, op.r)).map(([, m]) => m);
              expect(gone).toEqual(want);
              for (const m of gone) scores.delete(m);
            } else {
              const [a, b] = op.a <= op.b ? [op.a, op.b] : [op.b, op.a];
              const gone: string[] = [];
              zsl.deleteRangeByRank(a, b, (m) => gone.push(m));
              expect(gone).toEqual(model.slice(a - 1, b).map(([, m]) => m));
              for (const m of gone) scores.delete(m);
            }
            resort();
            zsl.check();
          }

          const walked: Entry[] = [];
          for (let n: SkiplistNode | null = zsl.first; n !== null; n = n.next)
            walked.push([n.score, n.member]);
          expect(walked).toEqual(model);
          model.forEach(([s, m], i) => {
            expect(zsl.rank(s, m)).toBe(i + 1);
            expect(zsl.byRank(i + 1)!.member).toBe(m);
          });
          const inside = model.filter(([s]) => inRange(s, probe));
          expect(zsl.firstInRange(probe)?.member ?? null).toBe(inside[0]?.[1] ?? null);
          expect(zsl.lastInRange(probe)?.member ?? null).toBe(inside.at(-1)?.[1] ?? null);
        },
      ),
      { numRuns: 300 },
    );
  });
});
