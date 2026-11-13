import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Dict } from '../../src/datastructures/dict.js';
import { Random } from '../../src/utils/random.js';

const newDict = <V>(seed: number): Dict<V> => new Dict<V>({ seed, rng: new Random(seed) });

// Short readable keys collide often; raw bytes make sure every byte value hashes correctly.
const keyArb = fc.oneof(
  fc.integer({ min: 0, max: 300 }).map((i) => `k${i}`),
  fc.uint8Array({ maxLength: 6 }).map((b) => Buffer.from(b).toString('latin1')),
);

type Op =
  | { t: 'set'; key: string; value: number }
  | { t: 'delete'; key: string }
  | { t: 'get'; key: string }
  | { t: 'bulkAdd'; n: number }
  | { t: 'bulkDelete'; keepOneIn: number }
  | { t: 'rehash'; n: number }
  | { t: 'shrink' }
  | { t: 'clear' };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({ t: fc.constant('set' as const), key: keyArb, value: fc.integer() }),
  },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('delete' as const), key: keyArb }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('get' as const), key: keyArb }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('bulkAdd' as const),
      n: fc.integer({ min: 1, max: 400 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('bulkDelete' as const),
      keepOneIn: fc.integer({ min: 1, max: 20 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ t: fc.constant('rehash' as const), n: fc.integer({ min: 1, max: 50 }) }),
  },
  { weight: 1, arbitrary: fc.constant({ t: 'shrink' as const }) },
  { weight: 1, arbitrary: fc.constant({ t: 'clear' as const }) },
);

describe('Dict against a JS Map', () => {
  it('holds the same entries after any sequence of operations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 }),
        fc.array(opArb, { maxLength: 200 }),
        (seed, ops) => {
          const d = newDict<number>(seed);
          const m = new Map<string, number>();
          let fresh = 0;
          for (const op of ops) {
            switch (op.t) {
              case 'set':
                expect(d.set(op.key, op.value)).toBe(!m.has(op.key));
                m.set(op.key, op.value);
                break;
              case 'delete':
                expect(d.delete(op.key)).toBe(m.delete(op.key));
                break;
              case 'get':
                expect(d.get(op.key)).toBe(m.get(op.key));
                expect(d.has(op.key)).toBe(m.has(op.key));
                break;
              case 'bulkAdd':
                for (let i = 0; i < op.n; i++, fresh++) {
                  d.set(`bulk:${fresh}`, fresh);
                  m.set(`bulk:${fresh}`, fresh);
                }
                break;
              case 'bulkDelete': {
                let i = 0;
                for (const key of [...m.keys()]) {
                  if (i++ % op.keepOneIn === 0) continue;
                  expect(d.delete(key)).toBe(true);
                  m.delete(key);
                }
                break;
              }
              case 'rehash':
                d.rehash(op.n);
                break;
              case 'shrink':
                d.maybeShrink();
                break;
              case 'clear':
                d.clear();
                m.clear();
                break;
            }
            expect(d.size).toBe(m.size);
          }
          d.check();
          const walked = new Map<string, number>();
          d.forEach((k, v) => walked.set(k, v));
          expect(walked).toEqual(m);
          for (const [k, v] of m) expect(d.get(k)).toBe(v);
        },
      ),
      { numRuns: 300 },
    );
  });
});

type ScanOp =
  | { t: 'add'; n: number }
  | { t: 'dropSome'; keepOneIn: number }
  | { t: 'dropAll' }
  | { t: 'rehash'; n: number }
  | { t: 'shrink' }
  | { t: 'none' };

const scanOpArb: fc.Arbitrary<ScanOp> = fc.oneof(
  fc.record({ t: fc.constant('add' as const), n: fc.integer({ min: 1, max: 300 }) }),
  fc.record({ t: fc.constant('dropSome' as const), keepOneIn: fc.integer({ min: 1, max: 10 }) }),
  fc.constant({ t: 'dropAll' as const }),
  fc.record({ t: fc.constant('rehash' as const), n: fc.integer({ min: 1, max: 100 }) }),
  fc.constant({ t: 'shrink' as const }),
  fc.constant({ t: 'none' as const }),
);

describe('Dict SCAN', () => {
  // Counts runs whose scan overlapped a grow or a shrink, so the property can't pass vacuously.
  let resizedRuns = 0;

  it('returns every key present for the whole scan, despite inserts, deletes, growth and shrinking', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 }),
        fc.integer({ min: 1, max: 200 }),
        fc.array(scanOpArb, { maxLength: 60 }),
        (seed, stableCount, ops) => {
          const d = newDict<number>(seed);
          const stable: string[] = [];
          for (let i = 0; i < stableCount; i++) {
            stable.push(`s${i}`);
            d.set(`s${i}`, i);
          }
          let transient: string[] = [];
          let fresh = 0;
          let sawResize = false;

          const seen = new Set<string>();
          let cursor = 0;
          let step = 0;
          do {
            cursor = d.scan(cursor, (k) => seen.add(k));
            const op = ops[step++];
            if (op === undefined) continue;
            switch (op.t) {
              case 'add':
                for (let i = 0; i < op.n; i++) {
                  const k = `t${fresh++}`;
                  d.set(k, -1);
                  transient.push(k);
                }
                break;
              case 'dropSome': {
                const kept: string[] = [];
                transient.forEach((k, i) => {
                  if (i % op.keepOneIn === 0) kept.push(k);
                  else d.delete(k);
                });
                transient = kept;
                break;
              }
              case 'dropAll':
                for (const k of transient) d.delete(k);
                transient = [];
                break;
              case 'rehash':
                d.rehash(op.n);
                break;
              case 'shrink':
                d.maybeShrink();
                break;
              case 'none':
                break;
            }
            sawResize ||= d.isRehashing;
            expect(step).toBeLessThan(1_000_000);
          } while (cursor !== 0);

          for (const k of stable) expect(seen.has(k)).toBe(true);
          d.check();
          if (sawResize) resizedRuns++;
        },
      ),
      { numRuns: 300 },
    );
    expect(resizedRuns).toBeGreaterThan(100);
  });
});
