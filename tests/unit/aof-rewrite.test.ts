// The AOF rewrite's pieces (spec 9.7), on servers that never listen: the command writer that
// turns keys into the fewest commands that rebuild them, the rewrite buffer, and the
// auto-rewrite rule.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { datasetDigest } from '../../src/commands/debug.js';
import { dispatch } from '../../src/commands/dispatch.js';
import { Config } from '../../src/config.js';
import {
  AofCommandWriter,
  REWRITE_ITEMS_PER_CMD,
  RewriteBuffer,
  needsAutoRewrite,
} from '../../src/persistence/aof-rewrite.js';
import { RespParser } from '../../src/protocol/parser.js';
import { Client } from '../../src/server/client.js';
import { Server } from '../../src/server/server.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'miniredis-rewrite-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const newServer = (seed = 1): Server => {
  const config = Config.fromDirectives([
    { args: ['dir', dir], where: 'in a test', line: `dir ${dir}` },
  ]);
  return new Server({ config, log: () => {}, seed });
};

const fakeClient = (server: Server) =>
  new Client(0, null, {
    maxBulkLen: () => server.config.get('proto-max-bulk-len'),
    authRequired: () => false,
  });

function run(server: Server, client: Client, ...argv: string[]): void {
  dispatch(server, client, argv);
  client.reply.take();
}

/** Every key of every db through one writer, as a walk with no hook would write them. */
function rewrite(server: Server): Buffer {
  const writer = new AofCommandWriter();
  for (const db of server.dbs) {
    db.forEachKey((key, obj, expireAt) => writer.writeKey(db.id, key, obj, expireAt));
  }
  writer.end();
  return Buffer.concat(writer.take());
}

function commands(data: Buffer): string[][] {
  const parser = new RespParser(
    { maxBulkLen: () => 1 << 30, authRequired: () => false },
    { multibulkOnly: true },
  );
  parser.feed(data);
  const out: string[][] = [];
  for (let cmd = parser.next(); cmd !== null; cmd = parser.next()) out.push(cmd.argv);
  expect(parser.pending).toBe(false);
  return out;
}

/** Runs `data` as commands on a fresh server and returns its digest. */
function replayedDigest(data: Buffer, now: number): string {
  const target = newServer(99);
  const client = fakeClient(target);
  for (const argv of commands(data)) run(target, client, ...argv);
  target.cmdTime = now;
  return datasetDigest(target);
}

describe('the command writer', () => {
  it('rebuilds every type, TTLs, binary data and several dbs to the same digest', () => {
    const server = newServer();
    const c = fakeClient(server);
    const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
    run(server, c, 'SET', 'str', 'hello');
    run(server, c, 'SET', binary, binary);
    run(server, c, 'SET', 'ttl', 'v', 'PX', '100000');
    for (let i = 0; i < 300; i++) {
      run(server, c, 'RPUSH', 'list', `item${i}`);
      run(server, c, 'HSET', 'hash', `f${i}`, `v${i}`);
      run(server, c, 'SADD', 'set', `m${i}`);
      run(server, c, 'ZADD', 'zset', String(i * 0.25 - 10), `z${i}`);
    }
    run(server, c, 'ZADD', 'zset', 'inf', 'top', '-inf', 'bottom', '1e-300', 'tiny');
    run(server, c, 'SELECT', '7');
    run(server, c, 'RPUSH', 'other', binary, '');
    run(server, c, 'HSET', 'h7', '', binary);
    run(server, c, 'EXPIRE', 'h7', '1000');
    const now = Date.now();
    server.cmdTime = now;
    const digest = datasetDigest(server);
    expect(replayedDigest(rewrite(server), now)).toBe(digest);
  });

  it('writes the fewest commands, at most 64 items each, then PEXPIREAT', () => {
    const server = newServer();
    const c = fakeClient(server);
    for (let i = 0; i < 130; i++) run(server, c, 'RPUSH', 'l', String(i));
    for (let i = 0; i < 65; i++) run(server, c, 'HSET', 'h', `f${i}`, 'v');
    run(server, c, 'SADD', 's', 'a', 'b');
    run(server, c, 'ZADD', 'z', '1.5', 'a');
    run(server, c, 'SET', 'k', 'v');
    run(server, c, 'PEXPIREAT', 'k', '4000000000000');
    const cmds = commands(rewrite(server));
    expect(cmds[0]).toEqual(['SELECT', '0']);
    const byKey = (key: string) => cmds.filter((argv) => argv[1] === key);
    const list = byKey('l');
    expect(list.map((argv) => argv[0])).toEqual(['RPUSH', 'RPUSH', 'RPUSH']);
    expect(list.map((argv) => argv.length - 2)).toEqual([64, 64, 2]);
    expect(list.flatMap((argv) => argv.slice(2))).toEqual(
      Array.from({ length: 130 }, (_, i) => String(i)),
    );
    const hash = byKey('h');
    expect(hash.map((argv) => (argv.length - 2) / 2)).toEqual([REWRITE_ITEMS_PER_CMD, 1]);
    expect(byKey('s')).toHaveLength(1);
    expect(byKey('z')).toEqual([['ZADD', 'z', '1.5', 'a']]);
    expect(byKey('k')).toEqual([
      ['SET', 'k', 'v'],
      ['PEXPIREAT', 'k', '4000000000000'],
    ]);
    expect(cmds.filter((argv) => argv[0] === 'SELECT')).toHaveLength(1);
  });

  it('writes a SELECT whenever the db changes, as hook records arrive in any order', () => {
    const server = newServer();
    const c = fakeClient(server);
    run(server, c, 'SET', 'a', '1');
    run(server, c, 'SELECT', '3');
    run(server, c, 'SET', 'b', '2');
    const writer = new AofCommandWriter();
    const a = server.dbs[0]!.peek('a')!;
    const b = server.dbs[3]!.peek('b')!;
    writer.writeKey(3, 'b', b, -1);
    writer.writeKey(0, 'a', a, -1);
    writer.writeKey(0, 'a2', a, -1);
    writer.writeKey(3, 'b2', b, -1);
    expect(commands(Buffer.concat(writer.take()))).toEqual([
      ['SELECT', '3'],
      ['SET', 'b', '2'],
      ['SELECT', '0'],
      ['SET', 'a', '1'],
      ['SET', 'a2', '1'],
      ['SELECT', '3'],
      ['SET', 'b2', '2'],
    ]);
  });

  it('counts what it has not handed out yet', () => {
    const server = newServer();
    const c = fakeClient(server);
    run(server, c, 'SET', 'k', 'v');
    const writer = new AofCommandWriter();
    expect(writer.pendingBytes).toBe(0);
    writer.writeKey(0, 'k', server.dbs[0]!.peek('k')!, -1);
    const pending = writer.pendingBytes;
    expect(pending).toBeGreaterThan(0);
    expect(Buffer.concat(writer.take()).length).toBe(pending);
    expect(writer.pendingBytes).toBe(0);
  });
});

describe('the rewrite buffer', () => {
  it('starts with a SELECT, adds one on each db change, and skips replicas-only records', () => {
    const buffer = new RewriteBuffer();
    buffer.append({ db: 0, argv: ['SET', 'a', '1'] });
    buffer.append({ db: 0, argv: ['PUBLISH', 'ch', 'm'], replicasOnly: true });
    buffer.append({ db: 0, argv: ['DEL', 'a'] });
    buffer.append({ db: 2, argv: ['SET', 'b', '\xff'] });
    expect(commands(buffer.take())).toEqual([
      ['SELECT', '0'],
      ['SET', 'a', '1'],
      ['DEL', 'a'],
      ['SELECT', '2'],
      ['SET', 'b', '\xff'],
    ]);
    expect(buffer.take().length).toBe(0);
  });
});

describe('auto-rewrite', () => {
  const MB = 1024 * 1024;

  it('starts once the file has grown by the percentage over its base, above the minimum', () => {
    expect(needsAutoRewrite(2 * MB, MB, 100, MB)).toBe(true);
    expect(needsAutoRewrite(2 * MB - 1, MB, 100, MB)).toBe(false);
    expect(needsAutoRewrite(1.5 * MB, MB, 50, MB)).toBe(true);
    // Never at or below the minimum size, however much it grew.
    expect(needsAutoRewrite(MB, 1, 100, MB)).toBe(false);
    expect(needsAutoRewrite(MB + 1, 1, 100, MB)).toBe(true);
    // A base of 0 (an empty file at startup) counts as 1, as in Redis.
    expect(needsAutoRewrite(MB + 1, 0, 100, MB)).toBe(true);
    // 0 turns it off.
    expect(needsAutoRewrite(100 * MB, MB, 0, MB)).toBe(false);
  });
});
