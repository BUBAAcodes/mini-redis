/**
 * RObj: the value stored under a key (spec 6.1), a type tag plus the value and two fields the
 * server keeps per key: the LRU/LFU clock and the snapshot marker.
 *
 * Key design choice: a discriminated union on `type`, so a handler that checked `obj.type`
 * gets the right value type with no casts. Encodings (embstr, int, quicklist …) are never
 * stored; OBJECT ENCODING works them out when asked. Only strings exist so far; lists, hashes,
 * sets and sorted sets join the union in steps 9 to 11.
 *
 * Mirrors Redis object.c (createObject, createStringObject) and the robj struct in server.h.
 */

export type RType = 'string';

interface RObjBase {
  /** LRU clock (seconds, 24 bits), or `(minutes << 8) | counter` under an LFU policy. */
  lru: number;
  /** Which snapshot job last saw this object (spec 9.8); 0 until snapshots exist. */
  savedEpoch: number;
}

export interface StringObject extends RObjBase {
  type: 'string';
  /** A byte string (spec 7.1). */
  value: string;
}

export type RObj = StringObject;

/** `Db.add` and `Db.setKey` stamp the clock, so creating an object needs no server. */
export const createStringObject = (value: string): StringObject => ({
  type: 'string',
  value,
  lru: 0,
  savedEpoch: 0,
});
