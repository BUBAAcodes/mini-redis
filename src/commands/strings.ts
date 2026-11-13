/**
 * String commands. Step 5 has GET and SET without options; step 6 adds the rest of section 8.1
 * and SET's NX/XX/GET, step 7 its TTL options.
 *
 * Key design choice: values are byte strings stored as-is in a string RObj (spec 7.1), so GET
 * replies with exactly the bytes SET received and STRLEN will be `value.length`.
 *
 * Mirrors Redis t_string.c (getCommand, setCommand, setGenericCommand).
 */
import { ERR, ReplyError } from '../protocol/errors.js';
import { createStringObject } from '../storage/redis-object.js';
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';

export function getCommand(ctx: CommandContext): void {
  const obj = ctx.db.lookupRead(ctx.argv[1]!);
  if (obj === null) ctx.reply.nullBulk();
  else if (obj.type !== 'string') throw new ReplyError(ERR.WRONGTYPE);
  else ctx.reply.bulk(obj.value);
}

export function setCommand(ctx: CommandContext): void {
  // Every option is a syntax error until steps 6 and 7 parse them, as unknown ones are in Redis.
  if (ctx.argv.length > 3) throw new ReplyError(ERR.SYNTAX);
  const key = ctx.argv[1]!;
  // Looked up even though SET overwrites anything: lazy expiry (step 7) and the snapshot hook
  // (step 13) must see the old value first (rule 5).
  ctx.db.lookupWrite(key);
  ctx.db.setKey(key, createStringObject(ctx.argv[2]!));
  ctx.db.signalModifiedKey(key);
  ctx.reply.ok();
}

export const stringCommands: CommandSpec[] = [
  command('get', 2, ['readonly'], [1, 1, 1], getCommand),
  command('set', -3, ['write', 'denyoom'], [1, 1, 1], setCommand),
];
