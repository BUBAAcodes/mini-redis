/**
 * Server commands: COMMAND (COUNT, INFO), CONFIG (GET, SET, RESETSTAT, HELP), TIME, INFO, the
 * snapshot commands SAVE, BGSAVE and LASTSAVE (step 13), and OBJECT and MEMORY USAGE (step 19).
 * SHUTDOWN, SLOWLOG and MONITOR come later; DEBUG lives in debug.ts.
 *
 * Key design choice: COMMAND INFO is generated from the command table, so it can never
 * disagree with what the dispatcher enforces. COMMAND DOCS is deliberately not a subcommand:
 * it replies "unknown subcommand", and redis-cli then falls back to its built-in help, as it
 * does with servers older than Redis 7 (spec 8.9).
 *
 * OBJECT and MEMORY USAGE look keys up with `peek`, so asking about a key never changes its
 * LRU/LFU data. OBJECT ENCODING is worked out from the value (spec 6.1), with Redis's names
 * for the encodings we have; MEMORY USAGE replies with the key's estimate (spec 10.5).
 *
 * Mirrors Redis server.c (commandCommand, commandInfoCommand, addReplyCommandInfo,
 * timeCommand, infoCommand), config.c (configGetCommand, configSetCommand,
 * configHelpCommand), rdb.c (saveCommand, bgsaveCommand, lastsaveCommand) and object.c
 * (objectCommand, memoryCommand).
 */
import type { Reply } from '../protocol/encoder.js';
import { genInfoString } from '../observability/info.js';
import { saveSnapshot } from '../persistence/snapshot-format.js';
import { startAofRewrite } from '../persistence/aof-rewrite.js';
import { startBgsave } from '../persistence/snapshot-job.js';
import { ERR, ReplyError } from '../protocol/errors.js';
import { estimateIdleSeconds, lfuDecrAndReturn, lfuTimeInMinutes } from '../storage/eviction.js';
import type { RObj } from '../storage/redis-object.js';
import { parseInt64 } from '../utils/numbers.js';
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

/** The longest string Redis keeps as embstr (OBJ_ENCODING_EMBSTR_SIZE_LIMIT). */
const EMBSTR_SIZE_LIMIT = 44;

/**
 * The encoding Redis would report for this value, minus the compact ones we don't have
 * (listpack, intset: docs/DIFFERENCES.md). A string is `int` if it reads as a 64-bit integer
 * in at most 20 characters, as tryObjectEncoding decides.
 */
export function objectEncoding(obj: RObj): string {
  switch (obj.type) {
    case 'string':
      if (obj.value.length <= 20 && parseInt64(obj.value) !== null) return 'int';
      return obj.value.length <= EMBSTR_SIZE_LIMIT ? 'embstr' : 'raw';
    case 'list':
      return 'quicklist';
    case 'hash':
    case 'set':
      return 'hashtable';
    case 'zset':
      return 'skiplist';
  }
}

/** The key's object for OBJECT, or null after replying nil (Redis's objectCommandLookupOrReply). */
function objectLookup(ctx: CommandContext): RObj | null {
  const obj = ctx.db.peek(ctx.argv[2]!);
  if (obj === null) ctx.reply.nullBulk();
  return obj;
}

export function objectEncodingCommand(ctx: CommandContext): void {
  const obj = objectLookup(ctx);
  if (obj !== null) ctx.reply.bulk(objectEncoding(obj));
}

export function objectFreqCommand(ctx: CommandContext): void {
  const obj = objectLookup(ctx);
  if (obj === null) return;
  if (!ctx.server.lfuEnabled) throw new ReplyError(ERR.OBJECT_FREQ_NOT_LFU);
  const now = lfuTimeInMinutes(ctx.server.cmdTime);
  ctx.reply.integer(lfuDecrAndReturn(obj.lru, now, ctx.server.config.get('lfu-decay-time')));
}

export function objectIdletimeCommand(ctx: CommandContext): void {
  const obj = objectLookup(ctx);
  if (obj === null) return;
  if (ctx.server.lfuEnabled) throw new ReplyError(ERR.OBJECT_IDLETIME_LFU);
  ctx.reply.integer(estimateIdleSeconds(obj.lru, ctx.server.lruClock));
}

/** Values are never shared between keys here, so always 1 (Redis shares small integers). */
export function objectRefcountCommand(ctx: CommandContext): void {
  if (objectLookup(ctx) !== null) ctx.reply.integer(1);
}

const OBJECT_HELP = [
  'OBJECT <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
  'ENCODING <key>',
  '    Return the kind of internal representation used in order to store the value',
  '    associated with a <key>.',
  'FREQ <key>',
  '    Return the access frequency index of the <key>. The returned integer is',
  '    proportional to the logarithm of the recent access frequency of the key.',
  'IDLETIME <key>',
  '    Return the idle time of the <key>, that is the approximated number of',
  '    seconds elapsed since the last access to the key.',
  'REFCOUNT <key>',
  '    Return the number of references of the value associated with the specified',
  '    <key>.',
  'HELP',
  '    Print this help.',
];

export function objectHelpCommand(ctx: CommandContext): void {
  ctx.reply.arrayLen(OBJECT_HELP.length);
  for (const line of OBJECT_HELP) ctx.reply.simple(line);
}

/**
 * `MEMORY USAGE key [SAMPLES count]`. Our estimate is exact for the structures we keep, so
 * SAMPLES is checked as Redis checks it, then has nothing to do. Options are checked before
 * the key is looked up, as in Redis.
 */
export function memoryUsageCommand(ctx: CommandContext): void {
  const argv = ctx.argv;
  for (let j = 3; j < argv.length; j++) {
    if (argv[j]!.toLowerCase() === 'samples' && j + 1 < argv.length) {
      const samples = parseInt64(argv[++j]!);
      if (samples === null) throw new ReplyError(ERR.NOT_INTEGER);
      if (samples < 0n) throw new ReplyError(ERR.SYNTAX);
    } else {
      throw new ReplyError(ERR.SYNTAX);
    }
  }
  const usage = ctx.db.memoryUsage(argv[2]!);
  if (usage === null) ctx.reply.nullBulk();
  else ctx.reply.integer(usage);
}

/** Only the subcommands we have: DOCTOR, MALLOC-STATS, PURGE and STATS are allocator reports. */
const MEMORY_HELP = [
  'MEMORY <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
  'USAGE <key> [SAMPLES <count>]',
  '    Return memory in bytes used by <key> and its value. Nested values are',
  '    sampled up to <count> times (default: 5, 0 means sample all).',
  'HELP',
  '    Print this help.',
];

export function memoryHelpCommand(ctx: CommandContext): void {
  ctx.reply.arrayLen(MEMORY_HELP.length);
  for (const line of MEMORY_HELP) ctx.reply.simple(line);
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
  command('object', -2, [], [0, 0, 0], containerOnly, [
    command('object|encoding', 3, ['readonly'], [2, 2, 1], objectEncodingCommand),
    command('object|freq', 3, ['readonly'], [2, 2, 1], objectFreqCommand),
    command('object|idletime', 3, ['readonly'], [2, 2, 1], objectIdletimeCommand),
    command('object|refcount', 3, ['readonly'], [2, 2, 1], objectRefcountCommand),
    command('object|help', 2, ['stale'], [0, 0, 0], objectHelpCommand),
  ]),
  command('memory', -2, [], [0, 0, 0], containerOnly, [
    command('memory|usage', -3, ['readonly'], [2, 2, 1], memoryUsageCommand),
    command('memory|help', 2, ['stale'], [0, 0, 0], memoryHelpCommand),
  ]),
];
