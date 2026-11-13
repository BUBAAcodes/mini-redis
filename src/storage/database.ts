/**
 * Db: one numbered database and the only door to its keys (spec 6.1, rule 5).
 *
 * Key design choice: commands never see the dicts. Every read and change goes through a
 * method here, so lazy expiry, WATCH, blocked-key wakeups (18), memory accounting (19),
 * the copy-on-write snapshot hook (13) and the dirty counter all hang off a handful of places
 * instead of every command. Each later step fills in its hook where the comments say.
 *
 * Expiry: every lookup, `peek` included, first deletes the key if `server.cmdTime` is past its
 * deadline, so no command can see an expired value (rule 7). The deletion is propagated as
 * `DEL key` at once, ahead of the running command's own record (spec 9.5), but it doesn't count
 * in `server.dirty`: the dispatcher reads a grown dirty counter as "this command changed
 * something", and a DEL of an expired key must not also propagate as itself.
 *
 * Mirrors Redis db.c (lookupKeyRead, lookupKeyWrite, dbAdd, setKey, dbDelete,
 * signalModifiedKey, expireIfNeeded, deleteExpiredKeyAndPropagate, setExpire, removeExpire,
 * getExpire, keyIsExpired).
 */
import { Dict } from '../datastructures/dict.js';
import type { Client } from '../server/client.js';
import type { Server } from '../server/server.js';
import type { RObj } from './redis-object.js';
import { touchAllWatchedKeysInDb, touchWatchedKey } from './watch.js';
import type { WatchedKey } from './watch.js';

export interface SetKeyOptions {
  /** Keep the key's TTL instead of dropping it (SET … KEEPTTL). */
  keepTtl?: boolean;
}

export class Db {
  /** key → object. Private in spirit: commands must go through the methods (rule 5). */
  readonly dict: Dict<RObj>;
  /** key → expiry in Unix ms. */
  readonly expires: Dict<number>;
  /** WATCH registry: key → its watchers, each with its entry (storage/watch.ts). */
  readonly watched = new Map<string, Map<Client, WatchedKey>>();

  constructor(
    readonly id: number,
    private readonly server: Server,
  ) {
    this.dict = new Dict<RObj>(server.dictOptions);
    this.expires = new Dict<number>(server.dictOptions);
  }

  get size(): number {
    return this.dict.size;
  }

  /** For reads: counts a hit or a miss and touches the key's LRU clock. */
  lookupRead(key: string): RObj | null {
    this.expireIfNeeded(key);
    const obj = this.dict.get(key);
    if (obj === undefined) {
      this.server.stats.keyspaceMisses++;
      return null;
    }
    this.server.stats.keyspaceHits++;
    obj.lru = this.server.lruClock;
    return obj;
  }

  /** Like lookupRead, without touching LRU/LFU or the stats (TYPE, TTL, EXISTS, OBJECT). */
  peek(key: string): RObj | null {
    this.expireIfNeeded(key);
    return this.dict.get(key) ?? null;
  }

  /** For writes: no hit/miss stats, as in Redis. The copy-on-write hook (step 13) goes here. */
  lookupWrite(key: string): RObj | null {
    this.expireIfNeeded(key);
    const obj = this.dict.get(key);
    if (obj === undefined) return null;
    obj.lru = this.server.lruClock;
    return obj;
  }

  /** Adds a key that must not exist yet. */
  add(key: string, obj: RObj): void {
    obj.lru = this.server.lruClock;
    if (!this.dict.set(key, obj)) throw new Error(`Db.add: key already exists`);
  }

  /** Creates or replaces a key's value; drops its TTL unless `keepTtl`. */
  setKey(key: string, obj: RObj, options?: SetKeyOptions): void {
    obj.lru = this.server.lruClock;
    this.dict.set(key, obj);
    if (!options?.keepTtl) this.expires.delete(key);
  }

  /** True if the key existed. */
  delete(key: string): boolean {
    if (!this.dict.delete(key)) return false;
    this.expires.delete(key);
    return true;
  }

  /** Moves `from`'s value (and TTL) to `to`, replacing whatever `to` held. Both are checked by RENAME. */
  rename(from: string, to: string): void {
    const obj = this.dict.get(from);
    if (obj === undefined) throw new Error('Db.rename: source key missing');
    const ttl = this.expires.get(from);
    this.delete(to);
    this.delete(from);
    this.dict.set(to, obj);
    if (ttl !== undefined) this.expires.set(to, ttl);
  }

  /**
   * Empties the db and returns how many keys it held, which all count as changes for save
   * points. Watchers are touched first, while the keys they watch can still be seen. The
   * snapshot hook (step 13) goes here.
   */
  flush(): number {
    touchAllWatchedKeysInDb(this);
    const removed = this.dict.size;
    this.dict.clear();
    this.expires.clear();
    this.server.dirty += removed;
    return removed;
  }

  /**
   * A random live key, or null if there is none. An expired pick is deleted and the draw
   * repeated; each retry shrinks the db, so this always ends.
   */
  randomKey(): string | null {
    for (;;) {
      const entry = this.dict.randomEntry();
      if (entry === null) return null;
      if (!this.expireIfNeeded(entry[0])) return entry[0];
    }
  }

  /**
   * Every live key: a full walk, for KEYS only (rule 10). Expired keys are skipped but not
   * deleted, since the dict can't change mid-walk, as in Redis's keysCommand.
   */
  allKeys(): string[] {
    const keys: string[] = [];
    const now = this.server.cmdTime;
    this.forEachKey((key, _obj, expireAt) => {
      if (expireAt === -1 || now <= expireAt) keys.push(key);
    });
    return keys;
  }

  /**
   * Every key with its value and deadline (-1 = none), expired ones included: for DEBUG DIGEST
   * and, later, snapshots. Rehashing pauses while it runs; `fn` must not change the db.
   */
  forEachKey(fn: (key: string, obj: RObj, expireAt: number) => void): void {
    this.dict.forEach((key, obj) => fn(key, obj, this.expires.get(key) ?? -1));
  }

  /** One SCAN step: visits the keys at `cursor`, returns the next cursor (0 = done). */
  scanStep(cursor: number, fn: (key: string, obj: RObj) => void): number {
    return this.dict.scan(cursor, fn);
  }

  /** Sets the key's deadline in Unix ms. The key must exist. */
  setExpire(key: string, ms: number): void {
    if (!this.dict.has(key)) throw new Error('Db.setExpire: key missing');
    this.expires.set(key, ms);
  }

  /** True if the key had a TTL. */
  removeExpire(key: string): boolean {
    return this.expires.delete(key);
  }

  /** The key's deadline in Unix ms, or -1 for none (or no key). */
  getExpire(key: string): number {
    return this.expires.get(key) ?? -1;
  }

  /** Past its deadline at `cmdTime`, whether or not it has been deleted yet. Never deletes. */
  isExpired(key: string): boolean {
    const expireAt = this.expires.get(key);
    return expireAt !== undefined && this.server.cmdTime > expireAt;
  }

  /** Stored right now, expired or not: WATCH bookkeeping only. Commands use the lookups. */
  hasEntry(key: string): boolean {
    return this.dict.has(key);
  }

  /**
   * Deletes the key if its deadline has passed (`cmdTime > deadline`, as in Redis's
   * keyIsExpired) and returns whether it did. Lookups call it; so do SCAN and RANDOMKEY.
   */
  expireIfNeeded(key: string): boolean {
    const expireAt = this.expires.get(key);
    if (expireAt === undefined || this.server.cmdTime <= expireAt) return false;
    // A replica (step 21) stops here: it hides the key and waits for its primary's DEL.
    this.deleteExpired(key);
    return true;
  }

  /**
   * One round of the active cycle (spec 9.3): draws `count` random keys with a TTL and deletes
   * those past `now`. Returns how many it looked at and how many it deleted, so the caller can
   * decide whether to sample again.
   *
   * Each key is its own randomEntry() draw, as in Redis's classic cycle (dictGetRandomKey), not
   * one randomEntries() run of consecutive buckets: deleting whole runs leaves the survivors in
   * clumps between cleared stretches, and a run that starts in a cleared stretch finds nothing,
   * which reads as "nothing left to expire" and ends the cycle early.
   */
  activeExpireSample(count: number, now: number): { sampled: number; expired: number } {
    let sampled = 0;
    let expired = 0;
    for (; sampled < count && this.expires.size > 0; sampled++) {
      const [key, expireAt] = this.expires.randomEntry()!;
      if (now > expireAt) {
        this.deleteExpired(key);
        expired++;
      }
    }
    return { sampled, expired };
  }

  /**
   * Lazy and active expiry share this: delete, count, and propagate `DEL key` now, ahead of the
   * running command's record. No dirty++ (see the header), but watchers see the deletion.
   */
  private deleteExpired(key: string): void {
    this.dict.delete(key);
    this.expires.delete(key);
    this.server.stats.expiredKeys++;
    this.server.propagator.propagateNow(this.id, ['DEL', key]);
    touchWatchedKey(this, key);
  }

  /**
   * Called exactly once after a command changes a key: fails the EXEC of every client watching
   * it and counts the change for save points and propagation. Blocked clients (18) and memory
   * accounting (19) join here.
   */
  signalModifiedKey(key: string): void {
    touchWatchedKey(this, key);
    this.server.dirty++;
  }

  /**
   * serverCron's share: shrink checks, then up to `ms` of rehashing for this db, given to the
   * keyspace first and to `expires` only when the keyspace has nothing to move (Redis's
   * incrementallyRehash), so one tick costs at most `ms` per db.
   */
  cron(ms: number): void {
    this.dict.maybeShrink();
    this.expires.maybeShrink();
    if (this.dict.isRehashing) this.dict.rehashMs(ms);
    else if (this.expires.isRehashing) this.expires.rehashMs(ms);
  }
}
