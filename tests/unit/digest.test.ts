import { describe, expect, it } from 'vitest';
import { datasetDigest, valueDigest } from '../../src/commands/debug.js';
import { Server } from '../../src/server/server.js';
import {
  createHashObject,
  createListObject,
  createSetObject,
  createStringObject,
  createZsetObject,
} from '../../src/storage/redis-object.js';
import { Random } from '../../src/utils/random.js';

const ZERO = '0'.repeat(40);
const newServer = () => new Server({ log: () => {}, seed: 3 });

describe('DEBUG DIGEST (spec 8.9)', () => {
  it('is all zeros for an empty dataset', () => {
    expect(datasetDigest(newServer())).toBe(ZERO);
  });

  it('does not depend on insertion order or dict layout', () => {
    const a = newServer();
    const b = newServer();
    const keys = Array.from({ length: 500 }, (_, i) => `key:${i}`);
    for (const k of keys) a.dbs[0]!.add(k, createStringObject(`v${k}`));
    for (const k of [...keys].reverse()) b.dbs[0]!.add(k, createStringObject(`v${k}`));
    expect(datasetDigest(a)).toMatch(/^[0-9a-f]{40}$/);
    expect(datasetDigest(a)).toBe(datasetDigest(b));
  });

  it('changes with the db, the key, the value and the expiry', () => {
    const base = () => {
      const s = newServer();
      s.dbs[0]!.add('k', createStringObject('v'));
      return s;
    };
    const ref = datasetDigest(base());
    const otherDb = newServer();
    otherDb.dbs[1]!.add('k', createStringObject('v'));
    const otherKey = newServer();
    otherKey.dbs[0]!.add('k2', createStringObject('v'));
    const otherValue = newServer();
    otherValue.dbs[0]!.add('k', createStringObject('v2'));
    const withTtl = base();
    withTtl.dbs[0]!.setExpire('k', Date.now() + 100_000);
    for (const s of [otherDb, otherKey, otherValue, withTtl]) {
      expect(datasetDigest(s)).not.toBe(ref);
    }
  });

  it('length-prefixes fields, so moving bytes between key and value changes it', () => {
    const a = newServer();
    a.dbs[0]!.add('ab', createStringObject('c'));
    const b = newServer();
    b.dbs[0]!.add('a', createStringObject('bc'));
    expect(datasetDigest(a)).not.toBe(datasetDigest(b));
  });

  it('skips keys that are already logically expired', () => {
    const s = newServer();
    s.dbs[0]!.add('dead', createStringObject('v'));
    s.dbs[0]!.setExpire('dead', 1);
    expect(datasetDigest(s)).toBe(ZERO);
    expect(s.dbs[0]!.size).toBe(1);
  });

  it('valueDigest depends on the value only', () => {
    expect(valueDigest(null)).toBe(ZERO);
    expect(valueDigest(createStringObject('x'))).toBe(valueDigest(createStringObject('x')));
    expect(valueDigest(createStringObject('x'))).not.toBe(valueDigest(createStringObject('y')));
  });

  describe('per type', () => {
    const list = (items: string[], maxItems = 128) => {
      const o = createListObject(maxItems);
      for (const v of items) o.value.pushTail(v);
      return o;
    };

    it('a list hashes its items in order, whatever its node layout', () => {
      const items = Array.from({ length: 50 }, (_, i) => `v${i}`);
      expect(valueDigest(list(items, 3))).toBe(valueDigest(list(items, 128)));
      expect(valueDigest(list(['a', 'b']))).not.toBe(valueDigest(list(['b', 'a'])));
      expect(valueDigest(list(['ab']))).not.toBe(valueDigest(list(['a', 'b'])));
      expect(valueDigest(list(['a']))).not.toBe(valueDigest(createStringObject('a')));
    });

    const opts = (seed: number) => ({ seed, rng: new Random(seed) });
    const hash = (pairs: Array<[string, string]>, seed = 1) => {
      const o = createHashObject(opts(seed));
      for (const [f, v] of pairs) o.value.set(f, v);
      return o;
    };
    const set = (members: string[], seed = 1) => {
      const o = createSetObject(opts(seed));
      for (const m of members) o.value.set(m, true);
      return o;
    };

    it('a hash is order-free but pairs fields with their values', () => {
      const pairs = Array.from({ length: 100 }, (_, i): [string, string] => [`f${i}`, `v${i}`]);
      expect(valueDigest(hash(pairs, 1))).toBe(valueDigest(hash([...pairs].reverse(), 99)));
      expect(
        valueDigest(
          hash([
            ['a', '1'],
            ['b', '2'],
          ]),
        ),
      ).not.toBe(
        valueDigest(
          hash([
            ['a', '2'],
            ['b', '1'],
          ]),
        ),
      );
    });

    it('a set is order-free; a set, a hash and a list with the same strings differ', () => {
      const ms = Array.from({ length: 100 }, (_, i) => `m${i}`);
      expect(valueDigest(set(ms, 1))).toBe(valueDigest(set([...ms].reverse(), 7)));
      expect(valueDigest(set(['a', 'b']))).not.toBe(valueDigest(set(['a', 'c'])));
      expect(valueDigest(set(['a']))).not.toBe(valueDigest(list(['a'])));
    });

    const zset = (pairs: Array<[number, string]>, seed = 1) => {
      const o = createZsetObject(opts(seed), new Random(seed));
      for (const [sc, m] of pairs) o.value.add(m, sc);
      return o;
    };

    it('a sorted set is insertion-order-free and depends on every score', () => {
      const pairs = Array.from({ length: 100 }, (_, i): [number, string] => [i % 7, `m${i}`]);
      expect(valueDigest(zset(pairs, 1))).toBe(valueDigest(zset([...pairs].reverse(), 5)));
      expect(
        valueDigest(
          zset([
            [1, 'a'],
            [2, 'b'],
          ]),
        ),
      ).not.toBe(
        valueDigest(
          zset([
            [2, 'a'],
            [1, 'b'],
          ]),
        ),
      );
      expect(valueDigest(zset([[1, 'a']]))).not.toBe(valueDigest(set(['a'])));
    });
  });
});
