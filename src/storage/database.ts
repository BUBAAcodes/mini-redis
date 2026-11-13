/**
 * Db: one numbered database and the only door to its keys (spec 6.1, rule 5).
 *
 * Key design choice: commands never see the dicts. Every read and change goes through a
 * method here, so lazy expiry (step 7), WATCH (16), blocked-key wakeups (18), memory accounting
 * (19), the copy-on-write snapshot hook (13) and the dirty counter all hang off a handful of
 * places instead of every command. This first version has the methods and the dirty counter;
 * each later step fills in its hook where the comments say.
 *
 * Mirrors Redis db.c (lookupKeyRead, lookupKeyWrite, dbAdd, setKey, dbDelete,
 * signalModifiedKey).
 */
import { Dict } from '../datastructures/dict.js';
import type { Server } from '../server/server.js';
import type { RObj } from './redis-object.js';

export interface SetKeyOptions {
  /** Keep the key's TTL instead of dropping it (SET … KEEPTTL). */
  keepTtl?: boolean;
}

export class Db {
  /** key → object. Private in spirit: commands must go through the methods (rule 5). */
  readonly dict: Dict<RObj>;
  /** key → expiry in Unix ms. */
  readonly expires: Dict<number>;

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
    return this.dict.get(key) ?? null;
  }

  /** For writes: no hit/miss stats, as in Redis. The copy-on-write hook (step 13) goes here. */
  lookupWrite(key: string): RObj | null {
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

  /**
   * Called exactly once after a command changes a key. WATCH (step 16), blocked clients (18)
   * and memory accounting (19) join here; for now it counts the change for save points and
   * propagation.
   */
  signalModifiedKey(_key: string): void {
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
