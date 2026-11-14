/**
 * RObj: the value stored under a key (spec 6.1), a type tag plus the value and the fields the
 * server keeps per key: the LRU/LFU clock, the snapshot marker and the memory estimate last
 * counted for it (spec 10.5; one number here instead of a second dict of key → estimate).
 *
 * Key design choice: a discriminated union on `type`, so a handler that checked `obj.type`
 * gets the right value type with no casts. Encodings (embstr, int, quicklist …) are never
 * stored; OBJECT ENCODING works them out when asked. Hashes and sets are Dicts (never a JS Map
 * or Set, spec 0), built with the server's dict options so they share its random hash seed.
 * A sorted set is a ZSet: a Dict of member → score plus a skip list, always changed together.
 *
 * Mirrors Redis object.c (createObject, createStringObject, createQuicklistObject,
 * createHashObject, createSetObject, createZsetObject) and the robj struct in server.h.
 */
import { Dict } from '../datastructures/dict.js';
import type { DictOptions } from '../datastructures/dict.js';
import { Quicklist } from '../datastructures/quicklist.js';
import { ZSet } from '../datastructures/zset.js';
import type { Random } from '../utils/random.js';

export type RType = 'string' | 'list' | 'hash' | 'set' | 'zset';

interface RObjBase {
  /** LRU clock (seconds, 24 bits), or `(minutes << 8) | counter` under an LFU policy. */
  lru: number;
  /** Which snapshot job last saw this object (spec 9.8); 0 until snapshots exist. */
  savedEpoch: number;
  /**
   * The estimate (spec 10.5) its db last counted for this key, value and TTL. `Db` keeps it so
   * a change adds only the difference to the running total, and a delete takes it all back.
   */
  memBytes: number;
}

export interface StringObject extends RObjBase {
  type: 'string';
  /** A byte string (spec 7.1). */
  value: string;
}

export interface ListObject extends RObjBase {
  type: 'list';
  value: Quicklist;
}

export interface HashObject extends RObjBase {
  type: 'hash';
  /** field → value, both byte strings. */
  value: Dict<string>;
}

export interface SetObject extends RObjBase {
  type: 'set';
  value: Dict<true>;
}

export interface ZSetObject extends RObjBase {
  type: 'zset';
  /** `{ dict, zsl }` (spec 6.1). */
  value: ZSet;
}

export type RObj = StringObject | ListObject | HashObject | SetObject | ZSetObject;

/** The object type for a type tag: `ObjectOf<'list'>` is ListObject. */
export type ObjectOf<T extends RType> = Extract<RObj, { type: T }>;

/** `Db.add` and `Db.setKey` stamp the clock, so creating an object needs no server. */
export const createStringObject = (value: string): StringObject => ({
  type: 'string',
  value,
  lru: 0,
  savedEpoch: 0,
  memBytes: 0,
});

/** An empty list; `maxItems` is `list-max-node-items`. The caller adds the first item. */
export const createListObject = (maxItems: number): ListObject => ({
  type: 'list',
  value: new Quicklist(maxItems),
  lru: 0,
  savedEpoch: 0,
  memBytes: 0,
});

export const createHashObject = (options: DictOptions): HashObject => ({
  type: 'hash',
  value: new Dict<string>(options),
  lru: 0,
  savedEpoch: 0,
  memBytes: 0,
});

export const createSetObject = (options: DictOptions): SetObject => ({
  type: 'set',
  value: new Dict<true>(options),
  lru: 0,
  savedEpoch: 0,
  memBytes: 0,
});

/** `rng` draws the skip list's node levels: the server's, so a seeded test replays. */
export const createZsetObject = (options: DictOptions, rng: Random): ZSetObject => ({
  type: 'zset',
  value: new ZSet(options, rng),
  lru: 0,
  savedEpoch: 0,
  memBytes: 0,
});
