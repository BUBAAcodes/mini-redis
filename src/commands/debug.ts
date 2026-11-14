/**
 * DEBUG (spec 8.9): DIGEST, DIGEST-VALUE, RELOAD, LOADAOF, SLEEP and SET-ACTIVE-EXPIRE. Refused
 * unless `enable-debug-command yes`.
 *
 * Key design choice: DEBUG DIGEST is our own fingerprint of the dataset: the XOR of one SHA-1
 * per key, taken over (db, key, type, value, deadline). Every field is length-prefixed, so no
 * two different keys can hash the same bytes. XOR makes the result independent of key order
 * and dict layout, so two servers with the same data agree even if they built it in a
 * different order (after a reload, on a replica). Keys that are already logically expired are
 * left out, so a primary that collected a key and a replica still waiting for its DEL agree
 * too. Each value is hashed in a canonical form: lists in order, and unordered collections
 * sorted first (steps 10 and 11). The digest is only comparable between MiniRedis servers.
 *
 * DEBUG is one command with a switch, as in Redis, not a container with subcommand specs.
 *
 * Mirrors Redis debug.c (debugCommand, computeDatasetDigest, xorObjectDigest, mixDigest).
 */
import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import { formatDouble } from '../protocol/encoder.js';
import { reloadAof } from '../persistence/aof.js';
import { reloadSnapshot } from '../persistence/snapshot-format.js';
import { ERR, ReplyError, unknownSubcommand } from '../protocol/errors.js';
import type { Server } from '../server/server.js';
import type { RObj } from '../storage/redis-object.js';
import { command } from './command.js';
import type { CommandContext, CommandSpec } from './command.js';

const DIGEST_BYTES = 20;

/** A byte string with its length in front, so field boundaries are unambiguous. */
function field(h: Hash, s: string): void {
  h.update(`${s.length}:`, 'latin1');
  h.update(s, 'latin1');
}

/** The value's type and canonical form. */
function hashValue(h: Hash, obj: RObj): void {
  field(h, obj.type);
  switch (obj.type) {
    case 'string':
      field(h, obj.value);
      break;
    case 'list':
      // In order: the order is part of a list's value.
      field(h, String(obj.value.length));
      obj.value.forEach((item) => field(h, item));
      break;
    case 'hash': {
      // Sorted by field (byte order), so the dict's layout and history don't matter.
      const pairs: Array<[string, string]> = [];
      obj.value.forEach((f, v) => pairs.push([f, v]));
      pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      field(h, String(pairs.length));
      for (const [f, v] of pairs) {
        field(h, f);
        field(h, v);
      }
      break;
    }
    case 'set': {
      const members: string[] = [];
      obj.value.forEach((m) => members.push(m));
      members.sort();
      field(h, String(members.length));
      for (const m of members) field(h, m);
      break;
    }
    case 'zset': {
      // In the set's own order (score, then member), which both sides compute identically.
      field(h, String(obj.value.size));
      for (let n = obj.value.zsl.first; n !== null; n = n.next) {
        field(h, n.member);
        field(h, formatDouble(n.score));
      }
      break;
    }
    default: {
      // Each new type must add its canonical form here; this stops compiling until it does.
      const unknown: never = obj;
      throw new Error(`digest: no canonical form for type ${(unknown as RObj).type}`);
    }
  }
}

function xorInto(acc: Buffer, digest: Buffer): void {
  for (let i = 0; i < DIGEST_BYTES; i++) acc[i]! ^= digest[i]!;
}

/** DEBUG DIGEST: 40 hex characters for the whole dataset, all zeros when it's empty. */
export function datasetDigest(server: Server): string {
  const acc = Buffer.alloc(DIGEST_BYTES);
  const now = server.cmdTime;
  for (const db of server.dbs) {
    db.forEachKey((key, obj, expireAt) => {
      if (expireAt !== -1 && now > expireAt) return;
      const h = createHash('sha1');
      field(h, String(db.id));
      field(h, key);
      hashValue(h, obj);
      field(h, String(expireAt));
      xorInto(acc, h.digest());
    });
  }
  return acc.toString('hex');
}

/** DEBUG DIGEST-VALUE: one value's digest, all zeros for a missing key. */
export function valueDigest(obj: RObj | null): string {
  if (obj === null) return '0'.repeat(DIGEST_BYTES * 2);
  const h = createHash('sha1');
  hashValue(h, obj);
  return h.digest('hex');
}

/** Blocks the whole thread, as Redis's nanosleep does: DEBUG SLEEP exists to make a slow command. */
function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const DEBUG_HELP = [
  'DEBUG <subcommand> [<arg> [value] [opt] ...]. Subcommands are:',
  'DIGEST',
  '    Output a hex signature representing the current DB content.',
  'DIGEST-VALUE <key> [<key> ...]',
  '    Output a hex signature of the values of all the specified keys.',
  'LOADAOF',
  '    Flush the AOF buffers on disk and reload the AOF in memory.',
  'RELOAD',
  '    Save the snapshot on disk and reload it back to memory.',
  'SET-ACTIVE-EXPIRE <0|1>',
  '    Setting it to 0 disables expiring keys in background when they are not accessed',
  '    (otherwise the Redis behavior). Setting it to 1 reenables back the default.',
  'SLEEP <seconds>',
  '    Stop the server for <seconds>. Decimals allowed.',
  'HELP',
  '    Print this help.',
];

export function debugCommand(ctx: CommandContext): void {
  if (!ctx.server.config.get('enable-debug-command')) {
    throw new ReplyError(ERR.DEBUG_NOT_ALLOWED);
  }
  const sub = ctx.argv[1]!.toLowerCase();
  const argc = ctx.argv.length;
  if (sub === 'help' && argc === 2) {
    ctx.reply.arrayLen(DEBUG_HELP.length);
    for (const line of DEBUG_HELP) ctx.reply.simple(line);
  } else if (sub === 'digest' && argc === 2) {
    ctx.reply.simple(datasetDigest(ctx.server));
  } else if (sub === 'digest-value') {
    ctx.reply.arrayLen(argc - 2);
    for (let i = 2; i < argc; i++) ctx.reply.simple(valueDigest(ctx.db.peek(ctx.argv[i]!)));
  } else if (sub === 'reload' && argc === 2) {
    // Redis's replies: a bare -ERR when the save fails, its load-error text when loading does.
    const result = reloadSnapshot(ctx.server);
    if (result === 'save-failed') throw new ReplyError(ERR.BARE);
    if (result === 'load-failed') throw new ReplyError(ERR.RDB_LOAD_FAILED);
    ctx.reply.ok();
  } else if (sub === 'loadaof' && argc === 2) {
    // As in Redis: the data is emptied first, so a missing or damaged file leaves only what
    // loaded before the damage, and the reply says to look at the logs.
    if (!reloadAof(ctx.server)) throw new ReplyError(ERR.AOF_LOAD_FAILED);
    ctx.reply.ok();
  } else if (sub === 'sleep' && argc === 3) {
    // strtod semantics: a leading number is read and anything unreadable counts as 0.
    const seconds = Number.parseFloat(ctx.argv[2]!);
    sleepSync(Number.isFinite(seconds) ? seconds * 1000 : 0);
    ctx.reply.ok();
  } else if (sub === 'set-active-expire' && argc === 3) {
    // atoi semantics, as in Redis: anything but a non-zero number turns it off.
    const n = Number.parseInt(ctx.argv[2]!, 10);
    ctx.server.activeExpireEnabled = Number.isFinite(n) && n !== 0;
    ctx.reply.ok();
  } else {
    throw new ReplyError(unknownSubcommand(ctx.argv[1]!, 'debug'));
  }
}

export const debugCommands: CommandSpec[] = [
  command('debug', -2, ['admin', 'stale'], [0, 0, 0], debugCommand),
];
