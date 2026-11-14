/**
 * serverCron (spec 9.1): background chores, `hz` times a second.
 *
 * Key design choice: one interval timer, re-armed whenever CONFIG SET changes hz, and unref'd
 * so it never keeps a process alive by itself (tests start and stop many servers). Each chore
 * gets a small time budget so cron never becomes a long pause (rule 10). For now it refreshes
 * the LRU clock, expires keys, rehashes, evicts while over `maxmemory` and records the memory
 * peak, runs the AOF's retries and `everysec` fsync, starts scheduled and automatic AOF
 * rewrites, starts BGSAVEs for save points, and runs the primary's replication chores (full
 * syncs waiting for a job, heartbeats, keepalives, replica timeouts and output limits) and, on a
 * replica, its link's (ACKs, reconnects, timeouts). Once a second it closes idle clients and
 * applies soft output limits (limits.ts). It also samples commands per second for INFO.
 *
 * Mirrors Redis server.c (serverCron, databasesCron).
 */
import { aofRewriteCron } from '../persistence/aof-rewrite.js';
import { snapshotCron } from '../persistence/snapshot-job.js';
import { performEvictions } from '../storage/eviction.js';
import { activeExpireCycle } from '../storage/expiry.js';
import { clientsCron } from './limits.js';
import type { Server } from './server.js';

/** Spec 7.5: Unix seconds in 24 bits, as Redis's LRU_CLOCK(). */
export const lruClockNow = (nowMs: number = Date.now()): number =>
  Math.floor(nowMs / 1000) & 0xffffff;

/** Time budget for incremental rehashing, per database, per run. */
const REHASH_MS = 1;

/** Share of each tick active expiry may use (spec 9.3: 25 ms at hz 10). */
const ACTIVE_EXPIRE_SHARE = 0.25;

export class Cron {
  private timer: NodeJS.Timeout | null = null;
  /** Runs so far; lets later chores run every N ticks (Redis's run_with_period). */
  ticks = 0;
  /** Unix ms of the last clients pass. */
  private lastClientsCron = 0;

  constructor(private readonly server: Server) {}

  get running(): boolean {
    return this.timer !== null;
  }

  /** Current period in ms. */
  get interval(): number {
    return 1000 / this.server.config.get('hz');
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), this.interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    this.ticks++;
    const now = Date.now();
    this.server.lruClock = lruClockNow();
    // Not on a replica: its keys go only when its primary sends DEL (spec 9.3).
    if (this.server.activeExpireEnabled && this.server.role === 'primary') {
      activeExpireCycle(this.server, this.interval * ACTIVE_EXPIRE_SHARE);
    }
    for (const db of this.server.dbs) db.cron(REHASH_MS);
    // Over the limit with no write to trigger it: evict a slice anyway (spec 9.4).
    performEvictions(this.server);
    this.server.updatePeakMemory();
    this.server.sampleOps(now);
    // A failed AOF write is retried, and the `everysec` fsync started (spec 9.6).
    this.server.aof?.cron();
    // A scheduled or automatic AOF rewrite goes first, as in Redis's serverCron (spec 9.7).
    aofRewriteCron(this.server);
    // Save points and a scheduled BGSAVE (spec 9.8).
    snapshotCron(this.server);
    // A full sync that waited for a job, then the once-a-second chores (spec 9.13); on a replica,
    // its link's: ACKs, reconnects and timeouts.
    this.server.repl.cron();
    this.server.primaryLink.cron();
    // Idle timeouts and soft output limits, once a second like Redis's clientsCron.
    if (now - this.lastClientsCron >= 1000) {
      this.lastClientsCron = now;
      clientsCron(this.server, now);
    }
  }
}
