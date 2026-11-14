/**
 * Db: one numbered database and the only door to its keys (spec 6.1, rule 5).
 *
 * Key design choice: commands never see the dicts. Every read and change goes through a
 * method here, so lazy expiry, WATCH, blocked-key wakeups, memory accounting, LRU/LFU, the
 * copy-on-write snapshot hook and the dirty counter all hang off a handful of places instead
 * of every command.
 *
 * Memory (spec 10.5): the db keeps a running total of its keys' estimates. Each object
 * remembers the estimate last counted for it (`memBytes`); inserting, replacing, deleting or
 * changing a TTL adjusts the total at once, and signalModifiedKey adds the difference after a
 * command changed a value in place. Every structure counts its own bytes, so this is O(1).
 *
 * LRU/LFU (spec 9.4): every lookup but `peek` touches the key: the LRU clock, or under an LFU
 * policy a decayed and maybe incremented counter. New objects start at the clock, or at the
 * LFU starting counter; an overwrite under LFU keeps the old counter, as Redis's dbSetValue.
 *
 * Snapshots (spec 9.8): every method that changes or removes an existing key, or its TTL, first
 * hands the old value to a running snapshot job (`beforeChange`), and every object a method
 * inserts is stamped with the job's epoch, so the job saves each key exactly once, as it was
 * when the job started. `lookupWrite` counts as a change: its caller is about to mutate the
 * object in place.
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
import { lfuInit, lfuTimeInMinutes, lfuTouch } from './eviction.js';
import { entryBytes } from './memory.js';
import type { RObj } from './redis-object.js';
import { touchAllWatchedKeysInDb, touchWatchedKey } from './watch.js';
import type { WatchedKey } from './watch.js';

export interface SetKeyOptions {
  /** Keep the key's TTL instead of dropping it (SET … KEEPTTL). */
  keepTtl?: boolean;
}

export class Db {
  private _dict: Dict<RObj>;
  private _expires: Dict<number>;
  /** WATCH registry: key → its watchers, each with its entry (storage/watch.ts). */
  readonly watched = new Map<string, Map<Client, WatchedKey>>();
  /** key → clients blocked on it, oldest first (blocking/waiters.ts). */
  readonly blockingKeys = new Map<string, Client[]>();
  /** Keys with waiters that changed since blocked clients were last served. */
  readonly readyKeys = new Set<string>();
  /** The sum of this db's keys' estimates (spec 10.5); the server's used memory adds them up. */
  usedMemory = 0;

  constructor(
    readonly id: number,
    private readonly server: Server,
  ) {
    this._dict = new Dict<RObj>(server.dictOptions);
    this._expires = new Dict<number>(server.dictOptions);
  }

  /** key → object. Private in spirit: commands must go through the methods (rule 5). */
  get dict(): Dict<RObj> {
    return this._dict;
  }

  /** key → expiry in Unix ms. */
  get expires(): Dict<number> {
    return this._expires;
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
    this.touch(obj);
    return obj;
  }

  /** Like lookupRead, without touching LRU/LFU or the stats (TYPE, TTL, EXISTS, OBJECT). */
  peek(key: string): RObj | null {
    this.expireIfNeeded(key);
    return this.dict.get(key) ?? null;
  }

  /**
   * For writes: no hit/miss stats, as in Redis. The caller may change the object in place, so a
   * running snapshot saves it first.
   */
  lookupWrite(key: string): RObj | null {
    this.expireIfNeeded(key);
    const obj = this.dict.get(key);
    if (obj === undefined) return null;
    this.beforeChange(key, obj);
    this.touch(obj);
    return obj;
  }

  /** Adds a key that must not exist yet. */
  add(key: string, obj: RObj): void {
    this.stampNew(obj);
    this.server.snapshotJob?.stamp(obj);
    if (!this.dict.set(key, obj)) throw new Error(`Db.add: key already exists`);
    this.account(key, obj);
  }

  /** Creates or replaces a key's value; drops its TTL unless `keepTtl`. */
  setKey(key: string, obj: RObj, options?: SetKeyOptions): void {
    const old = this.dict.get(key);
    if (old !== undefined && old !== obj) {
      this.beforeChange(key, old);
      this.unaccount(old);
    }
    this.stampNew(obj, old);
    this.server.snapshotJob?.stamp(obj);
    this.dict.set(key, obj);
    if (!options?.keepTtl) this.expires.delete(key);
    this.account(key, obj);
  }

  /** True if the key existed. */
  delete(key: string): boolean {
    const obj = this.dict.get(key);
    if (obj === undefined) return false;
    this.beforeChange(key, obj);
    this.dict.delete(key);
    this.expires.delete(key);
    this.unaccount(obj);
    return true;
  }

  /**
   * For loaders filling a fresh Db (a snapshot, a replica's full sync): inserts with no hooks,
   * stats or dirty count. `expireAt` is -1 for none. False if the key is already there.
   */
  load(key: string, obj: RObj, expireAt: number): boolean {
    this.stampNew(obj);
    if (!this.dict.set(key, obj)) return false;
    if (expireAt !== -1) this.expires.set(key, expireAt);
    this.account(key, obj);
    return true;
  }

  /**
   * Takes `other`'s keys and TTLs as this db's own: DEBUG RELOAD and startup swap in a loaded
   * snapshot this way. Watchers of keys that were stored see a change, as after a flush, and
   * clients blocked on a key that now exists are woken. A running job must have been aborted.
   */
  replaceData(other: Db): void {
    touchAllWatchedKeysInDb(this);
    this._dict = other._dict;
    this._expires = other._expires;
    this.usedMemory = other.usedMemory;
    for (const key of this.blockingKeys.keys()) {
      if (this._dict.has(key)) this.server.waiters.signalKeyAsReady(this, key);
    }
  }

  /** Moves `from`'s value (and TTL) to `to`, replacing whatever `to` held. Both are checked by RENAME. */
  rename(from: string, to: string): void {
    const obj = this.dict.get(from);
    if (obj === undefined) throw new Error('Db.rename: source key missing');
    const ttl = this.expires.get(from);
    // Both deletes run the snapshot hook, so a running job saves both keys as they were; the
    // object then moves already stamped, and the walk won't save it again under its new name.
    this.delete(to);
    this.delete(from);
    this.dict.set(to, obj);
    if (ttl !== undefined) this.expires.set(to, ttl);
    this.account(to, obj);
  }

  /**
   * Empties the db and returns how many keys it held, which all count as changes for save
   * points. Watchers are touched first, while the keys they watch can still be seen. A snapshot
   * still walking is aborted (spec 9.8): saving every key here through the hook would be one
   * long pause (rule 10).
   */
  flush(): number {
    const job = this.server.snapshotJob;
    if (job !== null && job.walking && this.dict.size > 0) job.abort('the dataset was flushed');
    touchAllWatchedKeysInDb(this);
    const removed = this.dict.size;
    this.dict.clear();
    this.expires.clear();
    this.usedMemory = 0;
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
    const obj = this.dict.get(key);
    if (obj === undefined) throw new Error('Db.setExpire: key missing');
    this.beforeChange(key, obj);
    this.expires.set(key, ms);
    this.account(key, obj);
  }

  /** True if the key had a TTL. */
  removeExpire(key: string): boolean {
    if (!this.expires.has(key)) return false;
    const obj = this.dict.get(key);
    if (obj !== undefined) this.beforeChange(key, obj);
    this.expires.delete(key);
    if (obj !== undefined) this.account(key, obj);
    return true;
  }

  /** The estimate counted for the key (MEMORY USAGE), or null if it's missing. */
  memoryUsage(key: string): number | null {
    return this.peek(key)?.memBytes ?? null;
  }

  /**
   * Up to `count` eviction candidates from consecutive buckets after a random start (spec 9.4),
   * from every key or, for a volatile policy, the keys with a TTL. Expired keys are included:
   * evicting one is as good as expiring it.
   */
  evictionSample(
    count: number,
    volatile: boolean,
  ): Array<{ key: string; obj: RObj; expireAt: number }> {
    const out: Array<{ key: string; obj: RObj; expireAt: number }> = [];
    if (volatile) {
      for (const [key, expireAt] of this.expires.randomEntries(count)) {
        const obj = this.dict.get(key);
        if (obj !== undefined) out.push({ key, obj, expireAt });
      }
    } else {
      for (const [key, obj] of this.dict.randomEntries(count)) out.push({ key, obj, expireAt: -1 });
    }
    return out;
  }

  /** For a pool entry that may be stale: still stored (with a TTL, for a volatile policy)? */
  isEvictionCandidate(key: string, volatile: boolean): boolean {
    return volatile ? this.expires.has(key) : this.dict.has(key);
  }

  /** A random key (with a TTL, for volatile-random), or null: for the random policies. */
  randomEvictionCandidate(volatile: boolean): string | null {
    return (volatile ? this.expires.randomEntry() : this.dict.randomEntry())?.[0] ?? null;
  }

  /** The key's deadline in Unix ms, or -1 for none (or no key). */
  getExpire(key: string): number {
    return this.expires.get(key) ?? -1;
  }

  /** Past its deadline at `cmdTime`, whether or not it has been deleted yet. Never deletes. */
  isExpired(key: string): boolean {
    // Nothing expires while the AOF loads (Redis's keyIsExpired): the file already holds the
    // DEL for every key that expired before it was written, and the rest go after loading.
    if (this.server.loading) return false;
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
    if (!this.isExpired(key)) return false;
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
    const obj = this.dict.get(key);
    if (obj !== undefined) this.beforeChange(key, obj);
    this.dict.delete(key);
    this.expires.delete(key);
    if (obj !== undefined) this.unaccount(obj);
    this.server.stats.expiredKeys++;
    this.server.propagator.propagateNow(this.id, ['DEL', key]);
    touchWatchedKey(this, key);
  }

  /**
   * The copy-on-write hook (spec 9.8): before `obj`, still stored under `key`, changes or goes,
   * a running snapshot that hasn't saved it yet writes it now, with its TTL, as it was when the
   * job started. A no-op when no job is walking, or once this object is saved.
   */
  private beforeChange(key: string, obj: RObj): void {
    this.server.snapshotJob?.save(this, key, obj);
  }

  /**
   * Called exactly once after a command changes a key: fails the EXEC of every client watching
   * it, marks it ready for the clients blocked on it, counts what an in-place change did to the
   * memory estimate, and counts the change for save points and propagation. Any change marks a
   * key ready, not just a push: serving checks that the key holds a list, so an extra mark costs
   * one lookup.
   */
  signalModifiedKey(key: string): void {
    touchWatchedKey(this, key);
    if (this.blockingKeys.has(key)) this.server.waiters.signalKeyAsReady(this, key);
    const obj = this.dict.get(key);
    if (obj !== undefined) this.account(key, obj);
    this.server.dirty++;
  }

  /** A lookup's touch: the LRU clock, or under an LFU policy one LFU access. */
  private touch(obj: RObj): void {
    const server = this.server;
    if (!server.lfuEnabled) {
      obj.lru = server.lruClock;
      return;
    }
    const config = server.config;
    obj.lru = lfuTouch(
      obj.lru,
      lfuTimeInMinutes(server.cmdTime),
      config.get('lfu-log-factor'),
      config.get('lfu-decay-time'),
      server.rng,
    );
  }

  /** A new object's LRU/LFU field; replacing `old` under LFU keeps its counter. */
  private stampNew(obj: RObj, old?: RObj): void {
    const server = this.server;
    if (!server.lfuEnabled) obj.lru = server.lruClock;
    else if (old !== undefined) obj.lru = old.lru;
    else obj.lru = lfuInit(lfuTimeInMinutes(server.cmdTime));
  }

  /** Recounts the stored key's estimate and adds the difference to the total. */
  private account(key: string, obj: RObj): void {
    const bytes = entryBytes(key, obj, this.expires.has(key));
    this.usedMemory += bytes - obj.memBytes;
    obj.memBytes = bytes;
  }

  /** Takes a removed object's estimate back out of the total. */
  private unaccount(obj: RObj): void {
    this.usedMemory -= obj.memBytes;
    obj.memBytes = 0;
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
