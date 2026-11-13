/**
 * The dispatcher (spec 9.1, step 3): from a parsed argv to a reply, a propagated record and
 * updated stats, with every check in Redis's order.
 *
 * Key design choice: checks that reject a command run before the clock is read or the handler
 * starts, and the handler is the only code that can change data, so an error reply always
 * means nothing changed (rule 4). A ReplyError is an expected error reply; any other exception
 * is a bug: it's logged with its stack and answered with -ERR internal error, and the server
 * keeps serving everyone else.
 *
 * Inside MULTI, a command that fails a check gets its error and flags the transaction, so EXEC
 * will abort; one that passes is queued and runs later through call(), the same path as a
 * normal command, so stats and propagation can't differ between the two.
 *
 * The AOF loader's client is obeyed: it skips the client-facing checks (MISCONF, subscriber
 * mode, and later NOAUTH, READONLY and OOM), and while the server loads, call() keeps no stats
 * and serves no blocked clients, so a replay changes nothing but the data.
 *
 * Mirrors Redis server.c (processCommand, rejectCommand, call, writeCommandsDeniedByDiskError)
 * and multi.c (queueMultiCommand, flagTransaction, discardTransaction, execCommandAbort).
 */
import {
  ERR,
  ReplyError,
  misconf,
  subscriberContext,
  unknownCommand,
  unknownSubcommand,
  wrongArity,
} from '../protocol/errors.js';
import { inSubscriberMode } from '../pubsub/hub.js';
import type { Client } from '../server/client.js';
import type { Server } from '../server/server.js';
import { unwatchAllKeys } from '../storage/watch.js';
import { CommandContext, arityOk, lookupSubcommand } from './command.js';
import type { CommandSpec } from './command.js';

/** What a RESP2 client with subscriptions may run (spec 9.11); RESET joins in step 22. */
const SUBSCRIBER_COMMANDS = new Set([
  'subscribe',
  'psubscribe',
  'unsubscribe',
  'punsubscribe',
  'ping',
  'quit',
]);

/** The commands that run at once inside MULTI instead of being queued (spec 9.1 step 5). */
const RUN_INSIDE_MULTI = new Set(['exec', 'discard', 'multi', 'watch', 'quit']);

export function dispatch(server: Server, client: Client, argv: readonly string[]): void {
  // 1. Look up the command, then its subcommand.
  const top = server.commands.get(argv[0]!.toLowerCase());
  if (top === undefined) {
    reject(client, null, unknownCommand(argv));
    return;
  }
  // 2. Arity, of the container first and then of the subcommand, as Redis checks them.
  if (!arityOk(top.arity, argv.length)) {
    reject(client, top, wrongArity(top.name));
    return;
  }
  let spec = top;
  if (top.subcommands && argv.length >= 2) {
    const sub = lookupSubcommand(top, argv[1]!);
    if (sub === undefined) {
      reject(client, top, unknownSubcommand(argv[1]!, top.name));
      return;
    }
    spec = sub;
    if (!arityOk(spec.arity, argv.length)) {
      reject(client, spec, wrongArity(spec.name));
      return;
    }
  }
  // The AOF loader's client is obeyed, as in Redis: nothing below applies to it.
  if (client.isAofClient) {
    if (client.multi && !RUN_INSIDE_MULTI.has(top.name)) client.queued.push({ spec, argv });
    else call(server, client, spec, argv);
    return;
  }
  // 3 joins in step 22: NOAUTH.
  // The AOF can't be written: refuse writes, and PING so health checks notice, until a write
  // succeeds. Redis checks this between OOM and READONLY, ahead of subscriber mode.
  const diskError = server.aof?.error ?? null;
  if (diskError !== null && deniedByDiskError(client, spec, top.name)) {
    reject(client, spec, misconf(diskError));
    return;
  }
  // 4. RESP2 subscriber mode: only the subscription commands, PING and QUIT.
  if (inSubscriberMode(client) && !SUBSCRIBER_COMMANDS.has(top.name)) {
    reject(client, spec, subscriberContext(spec.name));
    return;
  }
  // 5. MULTI: refuse what can't run in a transaction, queue everything else.
  if (client.multi && spec.flags.includes('nomulti')) {
    reject(client, spec, ERR.NOT_ALLOWED_IN_MULTI);
    return;
  }
  // 6–7 join here: -READONLY on a replica (21), eviction and -OOM for denyoom commands (19).
  if (client.multi && !RUN_INSIDE_MULTI.has(top.name)) {
    client.queued.push({ spec, argv });
    client.reply.simple('QUEUED');
    return;
  }
  call(server, client, spec, argv);
}

/** A write, PING, or an EXEC whose queue holds a write (Redis's is_write_command). */
function deniedByDiskError(client: Client, spec: CommandSpec, name: string): boolean {
  if (spec.flags.includes('write') || name === 'ping') return true;
  return name === 'exec' && client.queued.some((q) => q.spec.flags.includes('write'));
}

/**
 * A command that failed a check before running. Inside MULTI it also dooms the transaction.
 * EXEC itself failing a check (only its arity can) ends the transaction at once with the
 * reason, in or out of MULTI, as Redis's execCommandAbort does.
 */
function reject(client: Client, spec: CommandSpec | null, message: string): void {
  if (spec?.name === 'exec') {
    discardTransaction(client);
    const reason = message.startsWith('ERR ') ? message.slice(4) : message;
    client.reply.error(`EXECABORT Transaction discarded because of: ${reason}`);
    return;
  }
  if (client.multi) client.dirtyExec = true;
  client.reply.error(message);
}

/** Leaves MULTI (or makes sure it's left): drops the queue, both dirty flags and every WATCH. */
export function discardTransaction(client: Client): void {
  client.multi = false;
  client.dirtyCas = false;
  client.dirtyExec = false;
  client.queued = [];
  unwatchAllKeys(client);
}

export interface CallOptions {
  /** Run by EXEC: the clock was read once for the whole transaction (spec 7.5). */
  inExec?: boolean;
}

/** Steps 8–11 of spec 9.1: run the handler, record stats, propagate. */
export function call(
  server: Server,
  client: Client,
  spec: CommandSpec,
  argv: readonly string[],
  options: CallOptions = {},
): void {
  // The db is read per command: a queued SELECT moves the commands after it.
  const db = server.dbs[client.db]!;
  const ctx = new CommandContext(server, client, db, argv);
  const dirtyBefore = server.dirty;
  server.propagator.begin();
  // Read the clock once, so a key can't expire halfway through a command (spec 7.5).
  if (!options.inExec) server.cmdTime = Date.now();
  const start = process.hrtime.bigint();
  try {
    spec.handler(ctx);
  } catch (e) {
    if (e instanceof ReplyError) {
      client.reply.error(e.message);
    } else {
      const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
      server.log.warning(`Internal error running '${spec.name}': ${detail}`);
      client.reply.error(ERR.INTERNAL);
    }
  }
  const usec = Number(process.hrtime.bigint() - start) / 1000;

  // 9. Stats; SLOWLOG and MONITOR (step 23) also feed from here. A command that blocked is
  //    counted once, when it's served (it runs again) or times out, as in Redis.
  //    Replaying the AOF counts nothing, as Redis's loader calls handlers directly.
  if (!server.loading) {
    server.stats.totalCommandsProcessed++;
    if (!client.blocked) server.recordCommandStats(spec.name, usec);
  }
  client.lastCommand = spec.name;

  // 10. Propagate: the command's own record only if it's a write that changed something.
  const changed = server.dirty > dirtyBefore && spec.flags.includes('write');
  server.propagator.end(db.id, argv, changed);
  // 11. Serve blocked clients whose keys became ready, after this command's record so each
  //    pop replays after the push that fed it, and after the whole EXEC rather than after
  //    each of its commands.
  //    Not while the AOF loads: a pop served mid-replay would change data the file doesn't
  //    hold. Keys made ready by the replay are served once the command that loaded it ends.
  if (!options.inExec && !server.loading) server.waiters.handleClientsBlockedOnKeys();
}
