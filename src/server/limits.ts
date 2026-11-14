/**
 * Per-client limits that need a clock or a byte count: the output buffer limits (spec 9.1
 * step 5) and the idle timeout (spec 5 `timeout`), plus the once-a-second clients chore of
 * serverCron that applies them.
 *
 * Key design choice: a client's output is what we still hold for it, our own queue plus what
 * Node's socket couldn't hand to the kernel (`writableLength`). The hard limit is checked right
 * after each write in beforeSleep, so a subscriber that stops reading is cut off in the turn it
 * crosses the line, not at the next cron tick; the soft limit needs the clock, so cron checks
 * it. Closing is immediate: killClient drops the socket and with it the bytes Node queued, so
 * the memory comes back at once. Replicas count their own queue as well (Primary.outputBytes)
 * but use the same rule, through enforceOutputLimit.
 *
 * Mirrors Redis networking.c (checkClientOutputBufferLimits, closeClientOnOutputBufferLimitReached)
 * and server.c (clientsCronHandleTimeout).
 */
import { clientType } from '../commands/connection.js';
import type { OutputLimit } from '../config.js';
import type { Client } from './client.js';
import type { Server } from './server.js';

/** Redis counts the link to our primary as a normal client when it looks up a limit. */
const limitClass = (client: Client): 'normal' | 'replica' | 'pubsub' => {
  const type = clientType(client);
  return type === 'master' ? 'normal' : type;
};

/**
 * Applies the limit of `client`'s class to `used` bytes of waiting output: past the hard limit
 * at once, past the soft one for longer than its seconds. Closes the client and returns true
 * if it was over. A 0 limit means none.
 */
export function enforceOutputLimit(
  server: Server,
  client: Client,
  used: number,
  now: number = Date.now(),
): boolean {
  const limit: OutputLimit = server.config.get('client-output-buffer-limit')[limitClass(client)];
  const hard = limit.hard > 0 && used >= limit.hard;
  let soft = limit.soft > 0 && used >= limit.soft;
  if (!soft) client.softLimitSince = 0;
  else if (client.softLimitSince === 0) {
    client.softLimitSince = now;
    soft = false;
  } else if (now - client.softLimitSince <= limit.softSeconds * 1000) soft = false;
  if (!hard && !soft) return false;
  server.log.warning(
    `Client ${client.describe()} scheduled to be closed ASAP for overcoming of output buffer limits.`,
  );
  server.killClient(client);
  return true;
}

/** An ordinary client's waiting output: its queue plus what the socket still buffers. */
export const outputBytes = (client: Client): number =>
  client.reply.pendingBytes + (client.socket?.writableLength ?? 0);

/** Replicas are measured and limited by the primary, which owns their stream. */
export function checkOutputLimits(server: Server, client: Client, now?: number): boolean {
  if (client.closed || client.repl !== null || client.socket === null) return false;
  return enforceOutputLimit(server, client, outputBytes(client), now);
}

/**
 * Closes a client that has said nothing for `timeout` seconds. Not replicas, the link to our
 * primary, clients parked in a blocking command, or subscribers: they are meant to wait
 * (Redis's clientsCronHandleTimeout; MONITOR clients join the exceptions in step 23).
 */
function closeIfIdle(server: Server, client: Client, now: number): boolean {
  const timeout = server.config.get('timeout');
  if (timeout === 0 || client.repl !== null || client.primaryLink || client.blocked) return false;
  if (clientType(client) === 'pubsub') return false;
  if (now - client.lastInteraction <= timeout * 1000) return false;
  server.log.verbose(`Closing idle client: ${client.describe()}`);
  server.killClient(client);
  return true;
}

/** serverCron's once-a-second pass over every client (Redis's clientsCron). */
export function clientsCron(server: Server, now: number = Date.now()): void {
  for (const client of [...server.clients.values()]) {
    if (client.closed || client.socket === null) continue;
    if (closeIfIdle(server, client, now)) continue;
    checkOutputLimits(server, client, now);
  }
}
