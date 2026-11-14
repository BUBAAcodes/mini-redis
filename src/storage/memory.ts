/**
 * Memory estimates (spec 10.5): how many bytes a key and its value are taken to use.
 *
 * Key design choice: estimates, not measurements. JS can't ask the allocator what one object
 * costs, so each estimate is the payload bytes (key, value, items) plus a fixed overhead per
 * thing stored, with the constants below measured once by `bench/calibrate-memory.ts`. Every
 * data structure keeps its payload count up to date as it changes, so an estimate is O(1) and
 * `Db` can keep a running total for `maxmemory` without ever walking a value. The numbers drift
 * from the real heap (V8's own bookkeeping, garbage not yet collected, table slack), which is
 * why INFO also reports the process's real RSS.
 *
 * Mirrors Redis object.c (objectComputeSize, memoryCommand), where Redis asks the allocator
 * instead.
 */
import type { RObj, RType } from './redis-object.js';

// Measured with `node --expose-gc --import tsx bench/calibrate-memory.ts` (Node 26.13, Linux
// x64): heap growth per item minus the item's own bytes, rounded to 8. Rerun after changing a
// structure or upgrading Node.

/** A keyspace entry: the dict entry, its bucket slot, the RObj and the key string's header. */
export const KEY_OVERHEAD = 144;
/** An entry in `expires`: the dict entry, its slot and the boxed deadline. */
export const TTL_OVERHEAD = 72;
/** A string value's header. */
export const STRING_OVERHEAD = 16;
/** A list item: its array slot and string header, plus its share of the node. */
export const LIST_ITEM_OVERHEAD = 24;
/** A hash field: the dict entry, its slot, and the field's and the value's string headers. */
export const HASH_FIELD_OVERHEAD = 88;
/** A set member: the dict entry, its slot and the string header. */
export const SET_MEMBER_OVERHEAD = 72;
/** A sorted-set member: the dict entry, the boxed score, the skip-list node and its levels. */
export const ZSET_MEMBER_OVERHEAD = 272;
/**
 * An empty collection: the structure itself. A sorted set is big because its skip list's head
 * node holds all 32 levels from the start.
 */
export const OBJECT_OVERHEAD: Readonly<Record<Exclude<RType, 'string'>, number>> = {
  list: 72,
  hash: 184,
  set: 184,
  zset: 2288,
};

/** The value's estimate, in O(1). */
export function objectBytes(obj: RObj): number {
  switch (obj.type) {
    case 'string':
      return STRING_OVERHEAD + obj.value.length;
    case 'list':
      return OBJECT_OVERHEAD.list + obj.value.bytes + obj.value.length * LIST_ITEM_OVERHEAD;
    case 'hash':
      return OBJECT_OVERHEAD.hash + obj.value.bytes + obj.value.size * HASH_FIELD_OVERHEAD;
    case 'set':
      return OBJECT_OVERHEAD.set + obj.value.bytes + obj.value.size * SET_MEMBER_OVERHEAD;
    case 'zset':
      return OBJECT_OVERHEAD.zset + obj.value.dict.bytes + obj.value.size * ZSET_MEMBER_OVERHEAD;
  }
}

/** A whole key's estimate: the key, its value and, if it has one, its TTL. */
export const entryBytes = (key: string, obj: RObj, hasTtl: boolean): number =>
  KEY_OVERHEAD + key.length + objectBytes(obj) + (hasTtl ? TTL_OVERHEAD : 0);
