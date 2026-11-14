/**
 * Blocked clients (spec 9.12): who waits on which key, their timeouts, and serving them in
 * arrival order once a key becomes ready.
 *
 * Key design choice: serving a waiter re-runs its blocked command, as Redis 7 does
 * (processCommandAndResetClient from unblockClientOnKey). BLPOP and BLMOVE therefore have one
 * code path for "data is there", whether it was there at once or arrived later: the reply, the
 * `LPOP key` / `LMOVE …` propagation rewrite, and errors found at serve time (a BLMOVE whose
 * destination became a string gets WRONGTYPE) all come out the same. Each key holds a FIFO of
 * clients; a push marks the key ready through Db.signalModifiedKey, and after the command (or
 * the whole EXEC) the dispatcher drains the ready keys. A waiter is only re-run while its key
 * holds a list, so it can't block again, and one that sees another type keeps waiting.
 *
 * Redis re-runs a served command through processCommand, so its memory check applies again: a
 * served BLMOVE (denyoom) over `maxmemory` gets -OOM and its source keeps the item, while a
 * served BLPOP, which frees memory, always runs (checked against redis:7.4).
 *
 * Timeouts are one Node timer per blocked client (docs/adr/0008-one-timer-per-blocked-client.md).
 * A served or timed-out client's later pipelined input runs from beforeSleep, on a fresh stack,
 * never nested inside the command that woke it.
 *
 * Mirrors Redis blocked.c (blockForKeys, unblockClient, signalKeyAsReady,
 * handleClientsBlockedOnKeys, replyToBlockedClientTimedOut) and timeout.c
 * (getTimeoutFromObjectOrReply).
 */
import type { CommandContext, CommandSpec } from '../commands/command.js';
import { call } from '../commands/dispatch.js';
import { ERR, ReplyError } from '../protocol/errors.js';
import type { Client } from '../server/client.js';
import type { Server } from '../server/server.js';
import type { Db } from '../storage/database.js';
import { performEvictions } from '../storage/eviction.js';
import { parseStrictDouble } from '../utils/numbers.js';

/** LLONG_MAX as a double: every double at or past it is out of int64 range. */
const LLONG_MAX = 2 ** 63;

/** Node's largest setTimeout delay; anything longer fires after 1 ms with a warning. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * A blocking command's timeout in seconds, as milliseconds to wait (0 = forever). Rounded up,
 * so `0.0001` still waits 1 ms and `-0.0001` rounds to 0, which is forever, as in Redis.
 */
export function parseTimeout(s: string, now: number): number {
  const seconds = parseStrictDouble(s);
  if (seconds === null) throw new ReplyError(ERR.TIMEOUT_NOT_FLOAT);
  const ms = seconds * 1000;
  if (ms >= LLONG_MAX) throw new ReplyError(ERR.TIMEOUT_OUT_OF_RANGE);
  const timeout = Math.ceil(ms);
  if (timeout < 0) throw new ReplyError(ERR.TIMEOUT_NEGATIVE);
  // The absolute deadline must fit in int64 too.
  if (timeout > 0 && timeout > LLONG_MAX - now) throw new ReplyError(ERR.TIMEOUT_OUT_OF_RANGE);
  return timeout === 0 ? 0 : timeout; // -0 → 0
}

/** How long the next timer waits for `deadline`: capped, so a long timeout re-arms. */
export function timerDelay(deadline: number, now: number): number {
  return Math.min(Math.max(deadline - now, 0), MAX_TIMER_MS);
}

/** What a blocked client is waiting for; null on a client that isn't blocked. */
export interface BlockState {
  readonly db: Db;
  /** Each key once, in the order given. */
  readonly keys: readonly string[];
  /** Unix ms when it times out; 0 = never. */
  readonly deadline: number;
  /** The command to re-run when served. */
  readonly spec: CommandSpec;
  readonly argv: readonly string[];
  timer: NodeJS.Timeout | null;
}

export class Waiters {
  private readonly blocked = new Set<Client>();
  /** Dbs with at least one ready key, so serving never scans all 16. */
  private readonly readyDbs = new Set<Db>();
  /** True while handleClientsBlockedOnKeys runs: a re-run command must not serve recursively. */
  private serving = false;

  constructor(private readonly server: Server) {}

  /** For INFO's blocked_clients (step 23) and tests. */
  get blockedCount(): number {
    return this.blocked.size;
  }

  /**
   * Parks the running command's client on `keys` (spec 9.12 step 2). The handler has replied
   * nothing; the reply comes when it's served or times out.
   */
  block(ctx: CommandContext, keys: readonly string[], timeoutMs: number): void {
    const { client, db, argv } = ctx;
    const spec = this.server.commands.get(argv[0]!.toLowerCase())!;
    const unique = [...new Set(keys)];
    for (const key of unique) {
      const waiting = db.blockingKeys.get(key);
      if (waiting === undefined) db.blockingKeys.set(key, [client]);
      else waiting.push(client);
    }
    const deadline = timeoutMs === 0 ? 0 : this.server.cmdTime + timeoutMs;
    const state: BlockState = { db, keys: unique, deadline, spec, argv, timer: null };
    client.bstate = state;
    this.blocked.add(client);
    if (deadline !== 0) this.arm(client, state);
  }

  /** Removes every registration and the timer (spec 9.12 step 5); no reply. */
  unblock(client: Client): void {
    const state = client.bstate;
    if (state === null) return;
    client.bstate = null;
    this.blocked.delete(client);
    if (state.timer !== null) clearTimeout(state.timer);
    for (const key of state.keys) {
      const waiting = state.db.blockingKeys.get(key)!;
      waiting.splice(waiting.indexOf(client), 1);
      if (waiting.length === 0) state.db.blockingKeys.delete(key);
    }
  }

  /** Db.signalModifiedKey calls this for a key that has waiters. */
  signalKeyAsReady(db: Db, key: string): void {
    db.readyKeys.add(key);
    this.readyDbs.add(db);
  }

  /**
   * Serves every ready key (spec 9.12 step 3): the dispatcher calls it after each top-level
   * command. Re-run commands can make more keys ready (a BLMOVE pushing into a key another
   * client waits on), so it loops until nothing is ready.
   */
  handleClientsBlockedOnKeys(): void {
    if (this.serving || this.readyDbs.size === 0) return;
    this.serving = true;
    try {
      while (this.readyDbs.size > 0) {
        const db = first(this.readyDbs);
        this.readyDbs.delete(db);
        while (db.readyKeys.size > 0) {
          const key = first(db.readyKeys);
          db.readyKeys.delete(key);
          this.serveKey(db, key);
        }
      }
    } finally {
      this.serving = false;
    }
  }

  /**
   * Re-runs the commands of the clients waiting on `key`, oldest first, while it holds a list.
   * Only those waiting now are served; the list empties itself out of the loop, because the
   * last pop deletes the key.
   */
  private serveKey(db: Db, key: string): void {
    const waiting = db.blockingKeys.get(key);
    if (waiting === undefined) return;
    for (const client of [...waiting]) {
      if (client.bstate === null) continue;
      // Lookups expire by cmdTime; between commands it's stale.
      this.server.cmdTime = Date.now();
      const obj = db.peek(key);
      // Another type (or no key) leaves every waiter blocked, as Redis 7 does for lists.
      if (obj === null || obj.type !== 'list') return;
      const { spec, argv } = client.bstate;
      this.unblock(client);
      if (this.deniedOnOom(spec)) client.reply.error(ERR.OOM);
      else call(this.server, client, spec, argv);
      this.server.queueUnblocked(client);
    }
  }

  /** The dispatcher's memory check (rule 14), for a command about to be re-run. */
  private deniedOnOom(spec: CommandSpec): boolean {
    const server = this.server;
    if (server.config.get('maxmemory') === 0 || !spec.flags.includes('denyoom')) return false;
    return performEvictions(server) === 'fail';
  }

  private arm(client: Client, state: BlockState): void {
    state.timer = setTimeout(() => this.onTimer(client), timerDelay(state.deadline, Date.now()));
    // A parked client must not keep a test process alive on its own.
    state.timer.unref();
  }

  /** Spec 9.12 step 4: a null array, then the client's buffered input runs. */
  private onTimer(client: Client): void {
    const state = client.bstate;
    if (state === null) return;
    if (Date.now() < state.deadline) {
      this.arm(client, state);
      return;
    }
    this.unblock(client);
    client.reply.nullArray();
    // The handler's run was not counted when it blocked; its one call is counted now.
    this.server.recordCommandStats(state.spec.name, 0);
    this.server.queueUnblocked(client);
  }
}

function first<T>(set: Set<T>): T {
  return set.values().next().value as T;
}
