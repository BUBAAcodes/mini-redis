/**
 * Key commands. Step 5 has DEL; step 6 adds the rest of section 8.2 and SCAN.
 *
 * Key design choice: DEL signals each key it actually removed, once, and counts only those, so
 * `DEL a a` replies 1 and a DEL of missing keys changes nothing and propagates nothing.
 *
 * Mirrors Redis db.c (delCommand, delGenericCommand).
 */
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';

export function delCommand(ctx: CommandContext): void {
  let deleted = 0;
  for (let i = 1; i < ctx.argv.length; i++) {
    const key = ctx.argv[i]!;
    ctx.db.lookupWrite(key);
    if (ctx.db.delete(key)) {
      ctx.db.signalModifiedKey(key);
      deleted++;
    }
  }
  ctx.reply.integer(deleted);
}

export const keyCommands: CommandSpec[] = [command('del', -2, ['write'], [1, -1, 1], delCommand)];
