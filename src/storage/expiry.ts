/**
 * Active expiry (spec 9.3): the serverCron chore that deletes expired keys nobody reads.
 * Lazy expiry, its other half, lives in Db.expireIfNeeded.
 *
 * Key design choice: the classic adaptive sampler from Redis's EXPIRE docs. Draw 20 random keys
 * with a TTL and delete the expired ones. If more than a quarter of the sample was expired,
 * the db probably holds many more, so sample again. Otherwise move on. A time budget caps each
 * run, and the next run resumes at the db where this one stopped, so a db full of expired keys
 * is cleared over several ticks and never becomes a long pause (rule 10). Where the cycle
 * stopped lives on the Server, since there is no module state (spec 4).
 *
 * Mirrors Redis expire.c (activeExpireCycle, ACTIVE_EXPIRE_CYCLE_KEYS_PER_LOOP). Redis 6+ adds
 * `active-expire-effort` and a fast cycle in beforeSleep; we keep the slow cycle only.
 */
import type { Server } from '../server/server.js';

/** Keys sampled per round (ACTIVE_EXPIRE_CYCLE_KEYS_PER_LOOP). */
export const KEYS_PER_LOOP = 20;

/** Runs one active-expiry cycle of at most `budgetMs` milliseconds. */
export function activeExpireCycle(server: Server, budgetMs: number): void {
  const deadline = performance.now() + budgetMs;
  const dbs = server.dbs;
  for (let visited = 0; visited < dbs.length; visited++) {
    const db = dbs[server.activeExpireDb]!;
    let more = db.expires.size > 0;
    while (more) {
      // Out of time: return without advancing, so the next tick resumes at this db.
      if (performance.now() >= deadline) return;
      const { sampled, expired } = db.activeExpireSample(KEYS_PER_LOOP, Date.now());
      // More than 25% of the sample was expired (more than 5 of 20).
      more = sampled > 0 && expired * 4 > sampled;
    }
    server.activeExpireDb = (server.activeExpireDb + 1) % dbs.length;
  }
}
