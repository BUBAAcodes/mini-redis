/**
 * Eviction (spec 9.4): deleting keys to keep the memory estimate under `maxmemory`, and the
 * LRU and LFU bookkeeping that decides which keys go first.
 *
 * Key design choice: approximate, as in Redis. Finding the true least recently (or least
 * frequently) used key would mean a sorted index over every key, updated on every read. Instead
 * each round samples `maxmemory-samples` keys per db and merges them into a 16-slot pool of the
 * best candidates seen so far, so a few cheap random draws per eviction give a close
 * approximation that improves as rounds go by. The LRU clock is 24 bits of seconds; the LFU
 * field packs 16 bits of minutes with an 8-bit logarithmic counter that decays over time.
 *
 * Eviction is time-boxed (rule 10): after a slice it stops, lets the command run, and serverCron
 * (or the next denyoom command) carries on, as Redis's eviction timer does.
 *
 * Mirrors Redis evict.c (performEvictions, evictionPoolPopulate, estimateObjectIdleTime,
 * LFUGetTimeInMinutes, LFUTimeElapsed, LFULogIncr, LFUDecrAndReturn).
 */
import type { EvictionPolicy } from '../config.js';
import type { Server } from '../server/server.js';
import type { Random } from '../utils/random.js';
import type { Db } from './database.js';
import type { RObj } from './redis-object.js';

/** A new key's LFU counter, so it isn't evicted before it has had a chance to be read. */
export const LFU_INIT_VAL = 5;
/** Candidates kept between rounds. */
export const EVPOOL_SIZE = 16;
/** One eviction slice (Redis: 500 µs at the default maxmemory-eviction-tenacity). */
const EVICTION_TIME_LIMIT_MS = 0.5;
/** Keys evicted between clock reads, as in Redis. */
const KEYS_PER_CLOCK_CHECK = 16;
/** Rounds of sampling that may find no live candidate before giving up (never in practice). */
const MAX_EMPTY_ROUNDS = 100;

const LRU_CLOCK_MAX = 0xffffff;

/** Seconds since `lru` was stamped, on the 24-bit clock that wraps every 194 days. */
export const estimateIdleSeconds = (lru: number, lruClock: number): number =>
  (lruClock - lru) & LRU_CLOCK_MAX;

/** Unix minutes in 16 bits: the LFU field's clock. */
export const lfuTimeInMinutes = (ms: number): number => Math.floor(ms / 60_000) & 0xffff;

/** The counter in `lru` after decaying one step per `decayTime` minutes since it was stamped. */
export function lfuDecrAndReturn(lru: number, nowMinutes: number, decayTime: number): number {
  const counter = lru & 0xff;
  if (decayTime === 0) return counter;
  const elapsed = (nowMinutes - (lru >>> 8)) & 0xffff;
  const periods = Math.floor(elapsed / decayTime);
  return periods > counter ? 0 : counter - periods;
}

/**
 * One access: increments with probability 1 / ((counter − 5) × factor + 1), so each step costs
 * ten times more hits than the last at factor 10. `r` is a uniform draw from [0, 1).
 */
export function lfuLogIncr(counter: number, logFactor: number, r: number): number {
  if (counter === 255) return 255;
  const baseval = Math.max(0, counter - LFU_INIT_VAL);
  return r < 1 / (baseval * logFactor + 1) ? counter + 1 : counter;
}

/** The LFU field after one access at `nowMinutes`: decay, then maybe increment, then restamp. */
export function lfuTouch(
  lru: number,
  nowMinutes: number,
  logFactor: number,
  decayTime: number,
  rng: Random,
): number {
  const counter = lfuLogIncr(lfuDecrAndReturn(lru, nowMinutes, decayTime), logFactor, rng.next());
  return (nowMinutes << 8) | counter;
}

/** A new key's LFU field. */
export const lfuInit = (nowMinutes: number): number => (nowMinutes << 8) | LFU_INIT_VAL;

export const isLfuPolicy = (policy: EvictionPolicy): boolean => policy.endsWith('-lfu');

interface PoolEntry {
  score: number;
  dbId: number;
  key: string;
}

/**
 * The best candidates seen so far, sorted by score, highest (evict first) last. It survives
 * between evictions, so a key sampled earlier competes with every later sample. Entries can go
 * stale (the key was deleted, or changed since it was scored); the caller checks the key still
 * exists, as Redis does.
 */
export class EvictionPool {
  private readonly entries: PoolEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  insert(score: number, dbId: number, key: string): void {
    const e = this.entries;
    const dup = e.findIndex((x) => x.dbId === dbId && x.key === key);
    if (dup !== -1) e.splice(dup, 1);
    // The first slot holding a score at least as high: ties go left, so older entries go first.
    let k = 0;
    while (k < e.length && e[k]!.score < score) k++;
    if (e.length === EVPOOL_SIZE) {
      // Full: worse than everything kept means no room; otherwise the worst entry makes room.
      if (k === 0) return;
      e.shift();
      k--;
    }
    e.splice(k, 0, { score, dbId, key });
  }

  /** Takes the best candidate out, or null when the pool is empty. */
  pop(): { dbId: number; key: string } | null {
    const best = this.entries.pop();
    return best === undefined ? null : { dbId: best.dbId, key: best.key };
  }

  /** Scores from different policies can't be compared, so a policy change starts afresh. */
  clear(): void {
    this.entries.length = 0;
  }
}

/** What the dispatcher needs to know: `fail` means still over the limit, so -OOM. */
export type EvictResult = 'ok' | 'running' | 'fail';

/** Replicas follow their primary's DELs, and a load replays a file that once fit (spec 9.4). */
const evictionApplies = (server: Server): boolean =>
  server.config.get('maxmemory') > 0 && !server.loading && server.role !== 'replica';

/**
 * Evicts keys until the estimate is back under `maxmemory`. Returns `fail` if it can't (the
 * policy is noeviction, or no key is a candidate) and `running` if its time slice ran out first,
 * in which case the server carries on in later slices and the command may run meanwhile.
 */
export function performEvictions(server: Server): EvictResult {
  if (!evictionApplies(server)) return 'ok';
  const limit = server.config.get('maxmemory');
  if (server.usedMemory <= limit) return 'ok';
  const policy = server.config.get('maxmemory-policy');
  if (policy === 'noeviction') return 'fail';
  const start = performance.now();
  let evicted = 0;
  while (server.usedMemory > limit) {
    const victim = policy.endsWith('-random')
      ? pickRandom(server, policy === 'volatile-random')
      : pickFromPool(server, policy);
    if (victim === null) return 'fail';
    evictKey(server, victim.db, victim.key);
    if (++evicted % KEYS_PER_CLOCK_CHECK === 0) {
      if (performance.now() - start > EVICTION_TIME_LIMIT_MS) {
        server.scheduleEviction();
        return 'running';
      }
    }
  }
  return 'ok';
}

/** The pool's score: higher goes first. */
function score(server: Server, policy: EvictionPolicy, obj: RObj, expireAt: number): number {
  if (policy === 'volatile-ttl') return Number.MAX_SAFE_INTEGER - expireAt;
  if (isLfuPolicy(policy)) {
    const now = lfuTimeInMinutes(server.cmdTime);
    return 255 - lfuDecrAndReturn(obj.lru, now, server.config.get('lfu-decay-time'));
  }
  return estimateIdleSeconds(obj.lru, server.lruClock);
}

function pickFromPool(server: Server, policy: EvictionPolicy): { db: Db; key: string } | null {
  const volatile = policy.startsWith('volatile-');
  const samples = server.config.get('maxmemory-samples');
  const pool = server.evictionPool;
  for (let round = 0; round < MAX_EMPTY_ROUNDS; round++) {
    let candidates = 0;
    for (const db of server.dbs) {
      const n = volatile ? db.expires.size : db.size;
      if (n === 0) continue;
      candidates += n;
      for (const s of db.evictionSample(samples, volatile)) {
        pool.insert(score(server, policy, s.obj, s.expireAt), db.id, s.key);
      }
    }
    if (candidates === 0) return null;
    for (let e = pool.pop(); e !== null; e = pool.pop()) {
      const db = server.dbs[e.dbId]!;
      if (db.isEvictionCandidate(e.key, volatile)) return { db, key: e.key };
    }
  }
  return null;
}

/** A random key from the next db that has one, rotating through the dbs as Redis does. */
function pickRandom(server: Server, volatile: boolean): { db: Db; key: string } | null {
  const dbs = server.dbs;
  for (let i = 0; i < dbs.length; i++) {
    server.evictionNextDb = (server.evictionNextDb + 1) % dbs.length;
    const db = dbs[server.evictionNextDb]!;
    const key = db.randomEvictionCandidate(volatile);
    if (key !== null) return { db, key };
  }
  return null;
}

/**
 * Deletes the key and propagates `DEL` at once, ahead of the command that needed the room, so
 * replicas and the AOF never evict on their own (spec 9.5). Watchers and blocked clients hear
 * of it through signalModifiedKey, like any other change.
 */
function evictKey(server: Server, db: Db, key: string): void {
  db.delete(key);
  server.stats.evictedKeys++;
  server.propagator.propagateNow(db.id, ['DEL', key]);
  db.signalModifiedKey(key);
}
