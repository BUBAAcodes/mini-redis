/**
 * serverCron (spec 9.1): background chores, `hz` times a second.
 *
 * Key design choice: one interval timer, re-armed whenever CONFIG SET changes hz, and unref'd
 * so it never keeps a process alive by itself (tests start and stop many servers). Each chore
 * gets a small time budget so cron never becomes a long pause (rule 10). For now it refreshes
 * the LRU clock and rehashes; active expiry (step 7), save points and AOF rewrite (12–14),
 * timeouts and output limits (22), replication (20–21) and ops/sec sampling (23) join later.
 *
 * Mirrors Redis server.c (serverCron, databasesCron).
 */
import type { Server } from './server.js';

/** Spec 7.5: Unix seconds in 24 bits, as Redis's LRU_CLOCK(). */
export const lruClockNow = (nowMs: number = Date.now()): number =>
  Math.floor(nowMs / 1000) & 0xffffff;

/** Time budget for incremental rehashing, per database, per run. */
const REHASH_MS = 1;

export class Cron {
  private timer: NodeJS.Timeout | null = null;
  /** Runs so far; lets later chores run every N ticks (Redis's run_with_period). */
  ticks = 0;

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
    this.server.lruClock = lruClockNow();
    for (const db of this.server.dbs) db.cron(REHASH_MS);
  }
}
