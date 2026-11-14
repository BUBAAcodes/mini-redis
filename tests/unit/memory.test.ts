import { describe, expect, it } from 'vitest';
import { Dict } from '../../src/datastructures/dict.js';
import { Quicklist } from '../../src/datastructures/quicklist.js';
import { bytesToHuman } from '../../src/observability/info.js';
import {
  HASH_FIELD_OVERHEAD,
  KEY_OVERHEAD,
  LIST_ITEM_OVERHEAD,
  OBJECT_OVERHEAD,
  SET_MEMBER_OVERHEAD,
  STRING_OVERHEAD,
  TTL_OVERHEAD,
  ZSET_MEMBER_OVERHEAD,
  entryBytes,
  objectBytes,
} from '../../src/storage/memory.js';
import {
  createHashObject,
  createListObject,
  createSetObject,
  createStringObject,
  createZsetObject,
} from '../../src/storage/redis-object.js';
import { Random } from '../../src/utils/random.js';

const options = () => ({ seed: 7, rng: new Random(7) });
const word = (rng: Random): string => 'x'.repeat(rng.int(20));

describe('Dict byte counter (spec 10.5)', () => {
  const recount = <V>(d: Dict<V>): number => {
    let n = 0;
    d.forEach((k, v) => (n += k.length + (typeof v === 'string' ? v.length : 0)));
    return n;
  };

  it('counts key bytes, plus value bytes for string values, through every change', () => {
    const rng = new Random(3);
    const d = new Dict<string>(options());
    for (let i = 0; i < 20_000; i++) {
      const key = `f${rng.int(2_000)}`;
      const r = rng.int(10);
      if (r < 6) d.set(key, word(rng));
      else if (r < 9) d.delete(key);
      else if (rng.int(100) === 0) d.clear();
      if (i % 1_000 === 0) expect(d.bytes).toBe(recount(d));
    }
    expect(d.bytes).toBe(recount(d));
    for (const key of Array.from({ length: 2_000 }, (_, i) => `f${i}`)) d.delete(key);
    expect(d.bytes).toBe(0);
  });

  it('counts keys only for non-string values', () => {
    const d = new Dict<number>(options());
    d.set('abc', 1);
    d.set('de', 2);
    d.set('abc', 3);
    expect(d.bytes).toBe(5);
    d.delete('abc');
    expect(d.bytes).toBe(2);
  });
});

describe('Quicklist byte counter (spec 10.5)', () => {
  const recount = (q: Quicklist): number => {
    let n = 0;
    q.forEach((v) => (n += v.length));
    return n;
  };

  it('stays exact through pushes, pops, sets, inserts, trims and removes, with splits and merges', () => {
    const rng = new Random(5);
    const q = new Quicklist(4);
    for (let i = 0; i < 20_000; i++) {
      const v = word(rng);
      switch (rng.int(9)) {
        case 0:
          q.pushHead(v);
          break;
        case 1:
          q.pushTail(v);
          break;
        case 2:
          q.popHead();
          break;
        case 3:
          q.popTail();
          break;
        case 4:
          if (q.length > 0) q.set(rng.int(q.length), v);
          break;
        case 5:
          q.insert(rng.int(q.length + 1), v);
          break;
        case 6:
          if (q.length > 0 && rng.int(20) === 0) {
            const a = rng.int(q.length);
            q.trim(a, a + rng.int(q.length - a));
          }
          break;
        case 7:
          q.remove('x'.repeat(rng.int(20)), rng.int(5) - 2);
          break;
        default:
          if (rng.int(200) === 0) q.clear();
      }
      if (i % 500 === 0) {
        q.check();
        expect(q.bytes).toBe(recount(q));
      }
    }
    expect(q.bytes).toBe(recount(q));
    q.trim(1, 0);
    expect(q.bytes).toBe(0);
  });
});

describe('object and entry estimates (spec 10.5)', () => {
  it('adds a fixed overhead per item to the item bytes', () => {
    const rng = new Random(1);
    expect(objectBytes(createStringObject('hello'))).toBe(STRING_OVERHEAD + 5);

    const list = createListObject(128);
    list.value.pushTail('abc');
    list.value.pushTail('de');
    expect(objectBytes(list)).toBe(OBJECT_OVERHEAD.list + 5 + 2 * LIST_ITEM_OVERHEAD);

    const hash = createHashObject(options());
    hash.value.set('f', 'value');
    expect(objectBytes(hash)).toBe(OBJECT_OVERHEAD.hash + 6 + HASH_FIELD_OVERHEAD);

    const set = createSetObject(options());
    set.value.set('m1', true);
    set.value.set('m2', true);
    expect(objectBytes(set)).toBe(OBJECT_OVERHEAD.set + 4 + 2 * SET_MEMBER_OVERHEAD);

    const zset = createZsetObject(options(), rng);
    zset.value.add('member', 1.5);
    expect(objectBytes(zset)).toBe(OBJECT_OVERHEAD.zset + 6 + ZSET_MEMBER_OVERHEAD);
  });

  it('adds the key and, with a TTL, the expires entry', () => {
    const obj = createStringObject('v');
    expect(entryBytes('key', obj, false)).toBe(KEY_OVERHEAD + 3 + objectBytes(obj));
    expect(entryBytes('key', obj, true)).toBe(KEY_OVERHEAD + 3 + objectBytes(obj) + TTL_OVERHEAD);
  });
});

describe('bytesToHuman (INFO memory)', () => {
  it('prints as Redis does', () => {
    expect(bytesToHuman(0)).toBe('0B');
    expect(bytesToHuman(1023)).toBe('1023B');
    expect(bytesToHuman(1024)).toBe('1.00K');
    expect(bytesToHuman(4_211_360)).toBe('4.02M');
    expect(bytesToHuman(50 * 1024 * 1024)).toBe('50.00M');
    expect(bytesToHuman(3 * 1024 ** 3)).toBe('3.00G');
  });
});
