/**
 * Typed key lookups shared by the collection commands: the object under a key if it has the
 * expected type, null if the key is missing, and WRONGTYPE otherwise.
 *
 * Key design choice: the type check lives next to the lookup, so no handler can forget it, and
 * TypeScript narrows the result to the right object (a ListObject's value is a Quicklist), so
 * handlers need no casts. The lookups still go through Db (rule 5): reads count hits and
 * misses, writes run the copy-on-write hook.
 *
 * Mirrors Redis object.c (checkType) and db.c (lookupKeyReadOrReply, lookupKeyWriteOrReply).
 */
import { ERR, ReplyError } from '../protocol/errors.js';
import type { ObjectOf, RType } from '../storage/redis-object.js';
import type { CommandContext } from './command.js';

export function lookupReadOfType<T extends RType>(
  ctx: CommandContext,
  key: string,
  type: T,
): ObjectOf<T> | null {
  const obj = ctx.db.lookupRead(key);
  if (obj === null) return null;
  if (obj.type !== type) throw new ReplyError(ERR.WRONGTYPE);
  return obj as ObjectOf<T>;
}

export function lookupWriteOfType<T extends RType>(
  ctx: CommandContext,
  key: string,
  type: T,
): ObjectOf<T> | null {
  const obj = ctx.db.lookupWrite(key);
  if (obj === null) return null;
  if (obj.type !== type) throw new ReplyError(ERR.WRONGTYPE);
  return obj as ObjectOf<T>;
}
