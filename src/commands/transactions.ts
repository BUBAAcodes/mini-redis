/**
 * Transactions (spec 8.8, 9.10): MULTI, EXEC, DISCARD, WATCH and UNWATCH.
 *
 * Key design choice: EXEC runs its queue through the dispatcher's own call(), one command after
 * another inside one handler, so nothing else can run in between: that alone makes a
 * transaction atomic on one thread. Each queued command adds exactly one reply to the client's
 * output, so EXEC only writes the array header and lets them follow; no reply is buffered
 * twice. WATCH is optimistic: nothing is locked, a change only flags the watchers (see
 * storage/watch.ts), and EXEC checks the flag before it runs anything. Nothing rolls back: a
 * command that fails at run time is one error reply among the others, as in Redis.
 *
 * Mirrors Redis multi.c (multiCommand, execCommand, discardCommand, watchCommand,
 * unwatchCommand).
 */
import { ERR, ReplyError } from '../protocol/errors.js';
import { isWatchedKeyExpired, unwatchAllKeys, watchKey } from '../storage/watch.js';
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';
import { call, discardTransaction } from './dispatch.js';

export function multiCommand(ctx: CommandContext): void {
  // Not a queueing error: the transaction carries on (checked against Redis 7.4).
  if (ctx.client.multi) throw new ReplyError(ERR.MULTI_NESTED);
  ctx.client.multi = true;
  ctx.reply.ok();
}

export function execCommand(ctx: CommandContext): void {
  const { server, client } = ctx;
  if (!client.multi) throw new ReplyError(ERR.EXEC_WITHOUT_MULTI);
  // A watched key past its deadline is gone for anyone reading it now, deleted yet or not.
  if (!client.dirtyCas && isWatchedKeyExpired(client)) client.dirtyCas = true;
  if (client.dirtyExec || client.dirtyCas) {
    const aborted = client.dirtyExec;
    discardTransaction(client);
    if (aborted) throw new ReplyError(ERR.EXECABORT);
    ctx.reply.nullArray();
    return;
  }
  const queued = client.queued;
  // Unwatch before running: the transaction's own writes must not flag it.
  unwatchAllKeys(client);
  ctx.reply.arrayLen(queued.length);
  server.propagator.multiStart();
  try {
    // `multi` stays set while the queue runs, as in Redis, so a blocking command (step 18) can
    // tell it must not block. call() never queues, so nothing is queued twice.
    for (const { spec, argv } of queued) call(server, client, spec, argv, { inExec: true });
  } finally {
    server.propagator.multiEnd();
    discardTransaction(client);
  }
}

export function discardCommand(ctx: CommandContext): void {
  if (!ctx.client.multi) throw new ReplyError(ERR.DISCARD_WITHOUT_MULTI);
  discardTransaction(ctx.client);
  ctx.reply.ok();
}

export function watchCommand(ctx: CommandContext): void {
  // Also not a queueing error (Redis 7.4).
  if (ctx.client.multi) throw new ReplyError(ERR.WATCH_INSIDE_MULTI);
  for (let i = 1; i < ctx.argv.length; i++) watchKey(ctx.client, ctx.db, ctx.argv[i]!);
  ctx.reply.ok();
}

export function unwatchCommand(ctx: CommandContext): void {
  unwatchAllKeys(ctx.client);
  // A change already seen is forgotten too: the client no longer cares about those keys.
  ctx.client.dirtyCas = false;
  ctx.reply.ok();
}

export const transactionCommands: CommandSpec[] = [
  command('multi', 1, ['stale'], [0, 0, 0], multiCommand),
  command('exec', 1, ['stale'], [0, 0, 0], execCommand),
  command('discard', 1, ['stale'], [0, 0, 0], discardCommand),
  command('watch', -2, ['stale'], [1, -1, 1], watchCommand),
  command('unwatch', 1, ['stale'], [0, 0, 0], unwatchCommand),
];
