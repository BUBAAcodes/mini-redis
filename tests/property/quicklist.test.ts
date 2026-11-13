import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Quicklist } from '../../src/datastructures/quicklist.js';

// A few values so LREM and indexOf find matches; raw bytes check nothing is decoded.
const valueArb = fc.oneof(
  fc.constantFrom('a', 'b', 'c', ''),
  fc.uint8Array({ maxLength: 3 }).map((b) => Buffer.from(b).toString('latin1')),
);
const posArb = fc.integer({ min: -40, max: 40 });

type Op =
  | { t: 'pushHead' | 'pushTail'; v: string; n: number }
  | { t: 'popHead' | 'popTail' }
  | { t: 'insert'; at: number; v: string }
  | { t: 'set'; at: number; v: string }
  | { t: 'index'; at: number }
  | { t: 'remove'; v: string; count: number }
  | { t: 'trim'; start: number; end: number }
  | { t: 'range'; start: number; end: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constantFrom('pushHead' as const, 'pushTail' as const),
      v: valueArb,
      n: fc.integer({ min: 1, max: 20 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constantFrom('popHead' as const, 'popTail' as const) }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant('insert' as const), at: posArb, v: valueArb }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('set' as const), at: posArb, v: valueArb }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('index' as const), at: posArb }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('remove' as const),
      v: valueArb,
      count: fc.integer({ min: -3, max: 3 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ t: fc.constant('trim' as const), start: posArb, end: posArb }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant('range' as const), start: posArb, end: posArb }),
  },
);

/** Clamps an LRANGE-style pair to the list, as the commands do before calling in. */
function clampRange(start: number, end: number, len: number): [number, number] {
  if (start < 0) start = Math.max(0, start + len);
  if (end < 0) end += len;
  if (end >= len) end = len - 1;
  return [start, end];
}

function apply(q: Quicklist, model: string[], op: Op): void {
  switch (op.t) {
    case 'pushHead':
      for (let i = 0; i < op.n; i++) {
        q.pushHead(op.v);
        model.unshift(op.v);
      }
      break;
    case 'pushTail':
      for (let i = 0; i < op.n; i++) {
        q.pushTail(op.v);
        model.push(op.v);
      }
      break;
    case 'popHead':
      expect(q.popHead()).toBe(model.shift());
      break;
    case 'popTail':
      expect(q.popTail()).toBe(model.pop());
      break;
    case 'insert': {
      const at = Math.min(Math.abs(op.at), model.length);
      q.insert(at, op.v);
      model.splice(at, 0, op.v);
      break;
    }
    case 'set': {
      const i = op.at < 0 ? op.at + model.length : op.at;
      const ok = i >= 0 && i < model.length;
      expect(q.set(op.at, op.v)).toBe(ok);
      if (ok) model[i] = op.v;
      break;
    }
    case 'index':
      expect(q.index(op.at)).toBe(model.at(op.at));
      if (op.at >= model.length) expect(q.index(op.at)).toBeUndefined();
      break;
    case 'remove': {
      let removed = 0;
      const limit = op.count === 0 ? Infinity : Math.abs(op.count);
      if (op.count >= 0) {
        for (let i = 0; i < model.length && removed < limit;) {
          if (model[i] === op.v) {
            model.splice(i, 1);
            removed++;
          } else i++;
        }
      } else {
        for (let i = model.length - 1; i >= 0 && removed < limit; i--) {
          if (model[i] === op.v) {
            model.splice(i, 1);
            removed++;
          }
        }
      }
      expect(q.remove(op.v, op.count)).toBe(removed);
      break;
    }
    case 'trim': {
      const [s, e] = clampRange(op.start, op.end, model.length);
      q.trim(s, e);
      const kept = s > e || s >= model.length ? [] : model.slice(s, e + 1);
      model.splice(0, model.length, ...kept);
      break;
    }
    case 'range': {
      const [s, e] = clampRange(op.start, op.end, model.length);
      const want = s > e || s >= model.length ? [] : model.slice(s, e + 1);
      expect(q.range(s, e)).toEqual(want);
      break;
    }
  }
}

describe('Quicklist against a plain array (spec 15.4)', () => {
  it('matches the array and keeps its invariants under random operations', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(opArb, { maxLength: 120 }),
        (maxItems, ops) => {
          const q = new Quicklist(maxItems);
          const model: string[] = [];
          for (const op of ops) {
            apply(q, model, op);
            q.check();
            expect(q.length).toBe(model.length);
          }
          const all: string[] = [];
          q.forEach((v) => all.push(v));
          expect(all).toEqual(model);
          expect(q.indexOf('a')).toBe(model.indexOf('a'));
        },
      ),
      { numRuns: 500 },
    );
  });
});
