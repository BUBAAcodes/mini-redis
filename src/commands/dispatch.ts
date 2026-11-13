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
 * Mirrors Redis server.c (processCommand, call).
 */
import {
  ERR,
  ReplyError,
  unknownCommand,
  unknownSubcommand,
  wrongArity,
} from '../protocol/errors.js';
import type { Client } from '../server/client.js';
import type { Server } from '../server/server.js';
import { CommandContext, arityOk, lookupSubcommand } from './command.js';
import type { CommandSpec } from './command.js';

export function dispatch(server: Server, client: Client, argv: readonly string[]): void {
  const reply = client.reply;
  // 1. Look up the command, then its subcommand. (Inside MULTI, step 16 also flags the
  //    transaction on these errors.)
  let spec = server.commands.get(argv[0]!.toLowerCase());
  if (spec === undefined) {
    reply.error(unknownCommand(argv));
    return;
  }
  // 2. Arity, of the container first and then of the subcommand, as Redis checks them.
  if (!arityOk(spec.arity, argv.length)) {
    reply.error(wrongArity(spec.name));
    return;
  }
  if (spec.subcommands && argv.length >= 2) {
    const sub = lookupSubcommand(spec, argv[1]!);
    if (sub === undefined) {
      reply.error(unknownSubcommand(argv[1]!, spec.name));
      return;
    }
    spec = sub;
    if (!arityOk(spec.arity, argv.length)) {
      reply.error(wrongArity(spec.name));
      return;
    }
  }
  // 3–7 join in later steps, in this order: NOAUTH (22), RESP2 subscriber mode (17), MULTI
  // queueing (16), -READONLY on a replica (21), eviction and -OOM for denyoom commands (19).
  call(server, client, spec, argv);
}

/** Steps 8–11 of spec 9.1: run the handler, record stats, propagate. */
function call(server: Server, client: Client, spec: CommandSpec, argv: readonly string[]): void {
  const db = server.dbs[client.db]!;
  const ctx = new CommandContext(server, client, db, argv);
  const dirtyBefore = server.dirty;
  server.propagator.begin();
  // Read the clock once, so a key can't expire halfway through a command (spec 7.5).
  server.cmdTime = Date.now();
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

  // 9. Stats; SLOWLOG and MONITOR (step 23) also feed from here.
  server.stats.totalCommandsProcessed++;
  server.recordCommandStats(spec.name, usec);
  client.lastCommand = spec.name;

  // 10. Propagate: the command's own record only if it's a write that changed something.
  const changed = server.dirty > dirtyBefore && spec.flags.includes('write');
  server.propagator.end(db.id, argv, changed);
  // 11. Serving blocked clients whose keys became ready (step 18) goes here.
}
