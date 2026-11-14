// Measures the overhead constants in src/storage/memory.ts (spec 10.5): for each kind of thing
// a key or a value stores, insert a million of them and divide the growth in V8's heapUsed by a
// million, then take off the payload bytes the estimate already counts. What's left is the
// fixed cost per item: dict entries, bucket slots, string headers, skip-list nodes.
//
// Run: node --expose-gc --import tsx bench/calibrate-memory.ts
//
// Strings are made the way the RESP parser makes them, with buf.toString('latin1', …), so they
// are flat one-byte strings like real keys and values. Every payload is 16 bytes, a multiple of
// 8, so V8's padding doesn't blur the numbers. The results depend on the Node version and the
// platform; rerun after upgrading Node or changing a data structure, and copy the rounded
// numbers into memory.ts.
import { Dict } from '../src/datastructures/dict.js';
import type { DictOptions } from '../src/datastructures/dict.js';
import { Quicklist } from '../src/datastructures/quicklist.js';
import { ZSet } from '../src/datastructures/zset.js';
import { createStringObject } from '../src/storage/redis-object.js';
import type { RObj } from '../src/storage/redis-object.js';
import { Random } from '../src/utils/random.js';

const N = 1_000_000;
/** Collections measured as empty structures: fewer, since each is much bigger. */
const M = 100_000;
const LEN = 16;

const gc = (globalThis as { gc?: () => void }).gc;
if (gc === undefined) {
  console.error('Run with --expose-gc: node --expose-gc --import tsx bench/calibrate-memory.ts');
  process.exit(1);
}

const heap = (): number => {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
};

/** A distinct flat 16-byte string, as the parser would produce it. */
const flat = (prefix: string, i: number): string =>
  Buffer.from(prefix + String(i).padStart(LEN - prefix.length, '0'), 'latin1').toString('latin1');

const rng = new Random(1);
const options: DictOptions = { seed: 1, rng };

/** Heap growth per item while `build` runs; what it returns is kept alive until measured. */
function perItem(count: number, build: () => unknown): number {
  const before = heap();
  const kept = build();
  const after = heap();
  if (kept === undefined) throw new Error('nothing kept');
  return (after - before) / count;
}

const results: Array<[name: string, perItem: number, payload: number]> = [];
const measure = (name: string, count: number, payload: number, build: () => unknown): number => {
  const bytes = perItem(count, build);
  results.push([name, bytes, payload]);
  return bytes - payload;
};

// A string value alone: an array slot (8 bytes) plus the string.
const stringOverhead = measure('string value (+8 array slot)', N, LEN + 8, () =>
  Array.from({ length: N }, (_, i) => flat('v', i)),
);

// Keyspace entries holding distinct string objects: key, entry, RObj, value.
const keys: string[] = [];
const keyspace = new Dict<RObj>(options);
const keyPlusString = measure('key + string object', N, 2 * LEN, () => {
  for (let i = 0; i < N; i++) {
    const key = flat('k', i);
    keys.push(key);
    keyspace.set(key, createStringObject(flat('v', i)));
  }
  return keyspace;
});

// TTLs on the same keys: the strings already exist, so this is the entry and the boxed number.
const now = Date.now();
const ttlOverhead = measure('TTL entry', N, 0, () => {
  const expires = new Dict<number>(options);
  for (let i = 0; i < N; i++) expires.set(keys[i]!, now + 1_000 * i);
  return expires;
});

const listItem = measure('list item', N, LEN, () => {
  const list = new Quicklist(128);
  for (let i = 0; i < N; i++) list.pushTail(flat('l', i));
  return list;
});

const hashField = measure('hash field + value', N, 2 * LEN, () => {
  const hash = new Dict<string>(options);
  for (let i = 0; i < N; i++) hash.set(flat('f', i), flat('v', i));
  return hash;
});

const setMember = measure('set member', N, LEN, () => {
  const set = new Dict<true>(options);
  for (let i = 0; i < N; i++) set.set(flat('m', i), true);
  return set;
});

const zsetMember = measure('zset member', N, LEN, () => {
  const zset = new ZSet(options, rng);
  for (let i = 0; i < N; i++) zset.add(flat('z', i), i + 0.5);
  return zset;
});

const empty = (name: string, make: () => unknown): number =>
  measure(`empty ${name} (+8 array slot)`, M, 8, () => Array.from({ length: M }, make));
const emptyList = empty('list', () => new Quicklist(128));
const emptyHash = empty('hash', () => new Dict<string>(options));
const emptySet = empty('set', () => new Dict<true>(options));
const emptyZset = empty('zset', () => new ZSet(options, rng));

console.log(`Node ${process.version}, ${process.platform}/${process.arch}\n`);
console.log('kind                              bytes/item   payload   overhead');
for (const [name, bytes, payload] of results) {
  console.log(
    `${name.padEnd(34)}${bytes.toFixed(1).padStart(10)}${String(payload).padStart(10)}${(bytes - payload).toFixed(1).padStart(11)}`,
  );
}

const round8 = (n: number): number => Math.max(0, Math.round(n / 8) * 8);
console.log('\nFor src/storage/memory.ts (rounded to 8):');
console.log(`KEY_OVERHEAD = ${round8(keyPlusString - stringOverhead)}`);
console.log(`TTL_OVERHEAD = ${round8(ttlOverhead)}`);
console.log(`STRING_OVERHEAD = ${round8(stringOverhead)}`);
console.log(`LIST_ITEM_OVERHEAD = ${round8(listItem)}`);
console.log(`HASH_FIELD_OVERHEAD = ${round8(hashField)}`);
console.log(`SET_MEMBER_OVERHEAD = ${round8(setMember)}`);
console.log(`ZSET_MEMBER_OVERHEAD = ${round8(zsetMember)}`);
console.log(
  `OBJECT_OVERHEAD = { list: ${round8(emptyList)}, hash: ${round8(emptyHash)}, set: ${round8(emptySet)}, zset: ${round8(emptyZset)} }`,
);
