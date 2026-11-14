/**
 * Server commands: COMMAND (COUNT, INFO), CONFIG (GET, SET, RESETSTAT, HELP), TIME, INFO, and
 * the snapshot commands SAVE, BGSAVE and LASTSAVE (step 13). SHUTDOWN, SLOWLOG, MONITOR, MEMORY
 * and OBJECT come later; DEBUG lives in debug.ts.
 *
 * Key design choice: COMMAND INFO is generated from the command table, so it can never
 * disagree with what the dispatcher enforces. COMMAND DOCS is deliberately not a subcommand:
 * it replies "unknown subcommand", and redis-cli then falls back to its built-in help, as it
 * does with servers older than Redis 7 (spec 8.9).
 *
 * Mirrors Redis server.c (commandCommand, commandInfoCommand, addReplyCommandInfo,
 * timeCommand, infoCommand), config.c (configGetCommand, configSetCommand,
 * configHelpCommand) and rdb.c (saveCommand, bgsaveCommand, lastsaveCommand).
 */
import type { Reply } from '../protocol/encoder.js';
import { genInfoString } from '../observability/info.js';
import { saveSnapshot } from '../persistence/snapshot-format.js';
import { startAofRewrite } from '../persistence/aof-rewrite.js';
import { startBgsave } from '../persistence/snapshot-job.js';
import { ERR, ReplyError } from '../protocol/errors.js';
import { command, containerOnly, lookupSubcommand } from './command.js';
import type { CommandContext, CommandFlag, CommandSpec, CommandTable } from './command.js';

/** Our flag names as Redis spells them in COMMAND INFO. */
const WIRE_FLAGS: Record<CommandFlag, string> = {
  write: 'write',
  readonly: 'readonly',
  denyoom: 'denyoom',
  admin: 'admin',
  pubsub: 'pubsub',
  blocking: 'blocking',
  noauth: 'no_auth',
  nomulti: 'no_multi',
  stale: 'stale',
};

/** ACL categories, derived from flags since we have no ACLs (docs/DIFFERENCES.md). */
const CATEGORIES: Partial<Record<CommandFlag, readonly string[]>> = {
  write: ['@write'],
  readonly: ['@read'],
  admin: ['@admin', '@dangerous'],
  pubsub: ['@pubsub'],
  blocking: ['@blocking'],
};

const simpleSet = (reply: Reply, items: readonly string[]): void => {
  reply.setLen(items.length);
  for (const item of items) reply.simple(item);
};

/** Redis 7's 10-item COMMAND INFO entry. */
function addCommandInfo(reply: Reply, spec: CommandSpec): void {
  reply.arrayLen(10);
  reply.bulk(spec.name);
  reply.integer(spec.arity);
  simpleSet(
    reply,
    spec.flags.map((f) => WIRE_FLAGS[f]),
  );
  reply.integer(spec.firstKey);
  reply.integer(spec.lastKey);
  reply.integer(spec.step);
  simpleSet(
    reply,
    spec.flags.flatMap((f) => CATEGORIES[f] ?? []),
  );
  reply.setLen(0); // tips
  addKeySpecs(reply, spec);
  const subs = Object.values(spec.subcommands ?? {});
  reply.arrayLen(subs.length);
  for (const sub of subs) addCommandInfo(reply, sub);
}

/** One range key spec from first/last/step: what clients use to find a command's keys. */
function addKeySpecs(reply: Reply, spec: CommandSpec): void {
  if (spec.firstKey === 0) {
    reply.arrayLen(0);
    return;
  }
  const flags = spec.flags.includes('write')
    ? ['RW', 'update']
    : spec.flags.includes('readonly')
      ? ['RO', 'access']
      : [];
  reply.arrayLen(1);
  reply.mapLen(3);
  reply.bulk('flags');
  simpleSet(reply, flags);
  reply.bulk('begin_search');
  reply.mapLen(2);
  reply.bulk('type');
  reply.bulk('index');
  reply.bulk('spec');
  reply.mapLen(1);
  reply.bulk('index');
  reply.integer(spec.firstKey);
  reply.bulk('find_keys');
  reply.mapLen(2);
  reply.bulk('type');
  reply.bulk('range');
  reply.bulk('spec');
  reply.mapLen(3);
  reply.bulk('lastkey');
  // Relative to the first key; negative counts from the end, as in Redis.
  reply.integer(spec.lastKey >= 0 ? spec.lastKey - spec.firstKey : spec.lastKey);
  reply.bulk('keystep');
  reply.integer(spec.step);
  reply.bulk('limit');
  reply.integer(0);
}

/** 'get' or 'config|get'. */
function lookupByFullName(table: CommandTable, name: string): CommandSpec | undefined {
  const [parent, sub, ...rest] = name.toLowerCase().split('|');
  const spec = table.get(parent!);
  if (spec === undefined || sub === undefined) return spec;
  return rest.length === 0 ? lookupSubcommand(spec, sub) : undefined;
}

export function commandCommand(ctx: CommandContext): void {
  const table = ctx.server.commands;
  ctx.reply.arrayLen(table.size);
  for (const spec of table.values()) addCommandInfo(ctx.reply, spec);
}

export function commandCountCommand(ctx: CommandContext): void {
  ctx.reply.integer(ctx.server.commands.size);
}

export function commandInfoCommand(ctx: CommandContext): void {
  if (ctx.argv.length === 2) {
    commandCommand(ctx);
    return;
  }
  ctx.reply.arrayLen(ctx.argv.length - 2);
  for (let i = 2; i < ctx.argv.length; i++) {
    const spec = lookupByFullName(ctx.server.commands, ctx.argv[i]!);
    if (spec === undefined) ctx.reply.nullBulk();
    else addCommandInfo(ctx.reply, spec);
  }
}

export function configGetCommand(ctx: CommandContext): void {
  ctx.reply.map(ctx.server.config.getMatching(ctx.argv.slice(2)));
}

export function configSetCommand(ctx: CommandContext): void {
  ctx.server.config.setMany(ctx.argv.slice(2));
  ctx.reply.ok();
}

export function configResetstatCommand(ctx: CommandContext): void {
  ctx.server.resetStats();
  ctx.reply.ok();
}

/** Redis's text minus REWRITE, which we don't have. */
const CONFIG_HELP = [
  'CONFIG <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
  'GET <pattern>',
  '    Return parameters matching the glob-like <pattern> and their values.',
  'SET <directive> <value>',
  '    Set the configuration <directive> to <value>.',
  'RESETSTAT',
  '    Reset statistics reported by the INFO command.',
  'HELP',
  '    Print this help.',
];

export function configHelpCommand(ctx: CommandContext): void {
  ctx.reply.arrayLen(CONFIG_HELP.length);
  for (const line of CONFIG_HELP) ctx.reply.simple(line);
}

export function timeCommand(ctx: CommandContext): void {
  // performance.timeOrigin + now() is the wall clock with sub-millisecond precision, and its
  // microseconds (~1.8e15) stay well inside a double's exact integers.
  const us = BigInt(Math.floor((performance.timeOrigin + performance.now()) * 1000));
  ctx.reply.array([String(us / 1_000_000n), String(us % 1_000_000n)]);
}

export function infoCommand(ctx: CommandContext): void {
  ctx.reply.verbatim(genInfoString(ctx.server, ctx.argv.slice(1)));
}

/**
 * SAVE blocks the server by design (spec 8.9). Refused while a BGSAVE runs; beside an AOF
 * rewrite it runs, as in Redis 7.4 (checked against the reference), since writing the dataset
 * changes nothing the rewrite is copying.
 */
export function saveCommand(ctx: CommandContext): void {
  const job = ctx.server.snapshotJob;
  if (job !== null && job.kind !== 'rewrite') throw new ReplyError(ERR.BGSAVE_IN_PROGRESS);
  if (!saveSnapshot(ctx.server)) throw new ReplyError(ERR.BARE);
  ctx.reply.ok();
}

/** `BGSAVE [SCHEDULE]`. Replies are Redis 7.4's, checked against the reference. */
export function bgsaveCommand(ctx: CommandContext): void {
  const { server, argv } = ctx;
  if (argv.length > 2 || (argv.length === 2 && argv[1]!.toLowerCase() !== 'schedule')) {
    throw new ReplyError(ERR.SYNTAX);
  }
  const job = server.snapshotJob;
  if (job !== null && job.kind === 'bgsave') throw new ReplyError(ERR.BGSAVE_IN_PROGRESS);
  // Another job (an AOF rewrite) runs, or we're inside EXEC (`multi` stays set while the queue
  // runs), as Redis's server.in_exec: a job started now would see the transaction half done.
  // Either way serverCron starts the BGSAVE afterwards; with another job, only if asked.
  if (job !== null || ctx.client.multi) {
    if (argv.length === 1 && !ctx.client.multi) throw new ReplyError(ERR.BGSAVE_OTHER_JOB);
    server.bgsaveScheduled = true;
    ctx.reply.simple('Background saving scheduled');
    return;
  }
  if (!startBgsave(server)) throw new ReplyError(ERR.BARE);
  ctx.reply.simple('Background saving started');
}

/** BGREWRITEAOF (spec 9.7). Replies are Redis 7.4's, checked against the reference. */
export function bgrewriteaofCommand(ctx: CommandContext): void {
  const server = ctx.server;
  const job = server.snapshotJob;
  if (job !== null && job.kind === 'rewrite') throw new ReplyError(ERR.AOF_REWRITE_IN_PROGRESS);
  if (job !== null || ctx.client.multi) {
    server.aofRewriteScheduled = true;
    // Asked for by hand: no pause after an earlier failure (Redis resets its failure count).
    server.lastAofRewriteTry = 0;
    ctx.reply.simple('Background append only file rewriting scheduled');
    return;
  }
  if (!startAofRewrite(server)) throw new ReplyError(ERR.AOF_REWRITE_FAILED);
  ctx.reply.simple('Background append only file rewriting started');
}

export function lastsaveCommand(ctx: CommandContext): void {
  ctx.reply.integer(ctx.server.lastSave);
}

export const serverCommands: CommandSpec[] = [
  command('command', -1, ['stale'], [0, 0, 0], commandCommand, [
    command('command|count', 2, ['stale'], [0, 0, 0], commandCountCommand),
    command('command|info', -2, ['stale'], [0, 0, 0], commandInfoCommand),
  ]),
  command('config', -2, ['admin'], [0, 0, 0], containerOnly, [
    command('config|get', -3, ['admin', 'stale'], [0, 0, 0], configGetCommand),
    command('config|set', -4, ['admin', 'stale'], [0, 0, 0], configSetCommand),
    command('config|resetstat', 2, ['admin', 'stale'], [0, 0, 0], configResetstatCommand),
    command('config|help', 2, ['stale'], [0, 0, 0], configHelpCommand),
  ]),
  command('time', 1, ['stale'], [0, 0, 0], timeCommand),
  command('info', -1, ['stale'], [0, 0, 0], infoCommand),
  command('save', 1, ['admin', 'nomulti'], [0, 0, 0], saveCommand),
  command('bgsave', -1, ['admin'], [0, 0, 0], bgsaveCommand),
  command('bgrewriteaof', 1, ['admin'], [0, 0, 0], bgrewriteaofCommand),
  command('lastsave', 1, ['stale'], [0, 0, 0], lastsaveCommand),
];
