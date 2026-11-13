/**
 * What a command is (spec 7.9): the CommandSpec every command is described by, the
 * CommandContext its handler receives, and small helpers for defining and looking them up.
 *
 * Key design choice: specs are plain immutable data defined next to their handlers, and
 * subcommands are full specs too ('config|get'), so arity checks, flags and COMMAND INFO treat
 * them exactly like top-level commands, as Redis 7 does. Kept apart from registry.ts so the
 * command modules can import it without an import cycle.
 *
 * Mirrors the redisCommand struct in Redis server.h and the arity checks in server.c.
 */
import type { Reply } from '../protocol/encoder.js';
import type { Client } from '../server/client.js';
import type { Server } from '../server/server.js';
import type { Db } from '../storage/database.js';

export type CommandFlag =
  | 'write'
  | 'readonly'
  | 'denyoom'
  | 'admin'
  | 'pubsub'
  | 'blocking'
  | 'noauth'
  | 'nomulti'
  | 'stale';

export interface CommandSpec {
  /** Lowercase: 'zadd', or 'config|get' for a subcommand. */
  name: string;
  /** Like Redis: 3 = exactly 3 words including the name; -3 = at least 3. */
  arity: number;
  flags: readonly CommandFlag[];
  /** Key positions, for COMMAND INFO: first, last (-1 = the last argument) and step. */
  firstKey: number;
  lastKey: number;
  step: number;
  /** Synchronous, always (rule 1). A container's handler runs only when no subcommand is given. */
  handler: (ctx: CommandContext) => void;
  subcommands?: Readonly<Record<string, CommandSpec>>;
}

export type CommandTable = Map<string, CommandSpec>;

/** What a handler gets: who's asking, the db, the arguments, and its propagation helpers. */
export class CommandContext {
  constructor(
    readonly server: Server,
    readonly client: Client,
    readonly db: Db,
    /** Byte strings (spec 7.1); argv[0] is the command name as the client typed it. */
    readonly argv: readonly string[],
  ) {}

  get reply(): Reply {
    return this.client.reply;
  }

  /** Propagate `argv` instead of the command as it arrived (spec 9.5). */
  rewritePropagation(argv: readonly string[]): void {
    this.server.propagator.rewrite(argv);
  }

  /** Propagate `argv` in this db; the command as it arrived is then not propagated. */
  alsoPropagate(argv: readonly string[], replicasOnly = false): void {
    this.server.propagator.alsoPropagate(this.db.id, argv, replicasOnly);
  }

  preventPropagation(): void {
    this.server.propagator.prevent();
  }
}

/** Builds a top-level spec. `keys` is [first, last, step]; [0, 0, 0] for no keys. */
export function command(
  name: string,
  arity: number,
  flags: readonly CommandFlag[],
  keys: readonly [number, number, number],
  handler: (ctx: CommandContext) => void,
  subcommands?: readonly CommandSpec[],
): CommandSpec {
  const spec: CommandSpec = {
    name,
    arity,
    flags,
    firstKey: keys[0],
    lastKey: keys[1],
    step: keys[2],
    handler,
  };
  if (subcommands) {
    const subs: Record<string, CommandSpec> = {};
    for (const sub of subcommands) subs[sub.name.slice(name.length + 1)] = sub;
    spec.subcommands = subs;
  }
  return spec;
}

/** A container command (CONFIG, CLIENT) has no meaning without a subcommand. */
export const containerOnly = (ctx: CommandContext): never => {
  throw new Error(`'${ctx.argv[0]}' reached its container handler`);
};

export const arityOk = (arity: number, argc: number): boolean =>
  arity >= 0 ? argc === arity : argc >= -arity;

/** The subcommand spec for `argv[1]` of a container, or undefined. */
export const lookupSubcommand = (spec: CommandSpec, sub: string): CommandSpec | undefined => {
  const name = sub.toLowerCase();
  return spec.subcommands && Object.hasOwn(spec.subcommands, name)
    ? spec.subcommands[name]
    : undefined;
};
