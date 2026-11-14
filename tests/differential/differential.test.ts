// The differential test (spec 15.3): the same random commands go to Redis 7.4 and to an
// in-process MiniRedis, and every reply must match. This is the judge for rule 3.
//
// Key design choice: all commands are generated before the first one is sent, because the
// generator never looks at replies. That makes the run a pure function of SEED, so the printed
// command hash lets you check that a replay really sent the same bytes.
//
//   SEED=81723 OPS=20000 npm run test:diff     (REDIS_PORT overrides 6379)
//   PROTO=3 OPS=10000 npm run test:diff        the same run with both connections in RESP3
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCommandTable } from '../../src/commands/registry.js';
import { Random } from '../../src/utils/random.js';
import { TestClient, type Exchange } from '../helpers/resp-client.js';
import { startServer, type TestServer } from '../helpers/server.js';
import { execRepliesMatch, repliesMatch } from './compare.js';
import { DB_COUNT, Generator } from './generator.js';

const SEED = process.env.SEED ? Number(process.env.SEED) >>> 0 : Random.entropySeed();
const OPS = Number(process.env.OPS ?? 10_000);
const PROTO = process.env.PROTO === '3' ? '3' : '2';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const HISTORY = 20;

const show = (s: string): string => JSON.stringify(s).slice(0, 300);

/**
 * A whole-collection scan: the cursor is 0 and the items are the same number. Their order
 * differs by design (docs/DIFFERENCES.md), so only the shape is compared.
 */
const sameScanShape = (r: Exchange, m: Exchange): boolean => {
  const parts = (v: unknown): [unknown, number] | null =>
    Array.isArray(v) && v.length === 2 && Array.isArray(v[1]) ? [v[0], v[1].length] : null;
  const a = parts(r.value);
  const b = parts(m.value);
  return a !== null && b !== null && a[0] === b[0] && a[1] === b[1];
};

/** Random replies (ZRANDMEMBER, HRANDFIELD): same type and the same number of elements. */
const sameElements = (r: Exchange, m: Exchange): boolean => {
  const size = (v: unknown): number | null =>
    Array.isArray(v) ? v.length : v instanceof Map ? v.size : null;
  return r.raw === m.raw || (size(r.value) !== null && size(r.value) === size(m.value));
};

let mini: TestServer;
let ref: TestClient;
let mine: TestClient;

beforeAll(async () => {
  try {
    ref = await TestClient.connect(REDIS_PORT);
  } catch {
    throw new Error(
      `can't reach the reference Redis on port ${REDIS_PORT}: start it with ` +
        '`docker compose up -d redis` (or set REDIS_PORT)',
    );
  }
  mini = await startServer();
  mine = await TestClient.connect(mini.port);
  // Both servers start empty, and both connections start in db 0.
  for (const c of [ref, mine]) {
    if (PROTO === '3') await c.exchange('HELLO', '3');
    await c.exchange('FLUSHALL');
    await c.exchange('SELECT', '0');
  }
});

afterAll(async () => {
  await ref?.close();
  await mine?.close();
  await mini?.close();
});

describe('differential: MiniRedis against Redis 7.4', () => {
  it(`gives the same replies for ${OPS} random commands`, async () => {
    const registered = new Set(buildCommandTable().keys());
    const gen = new Generator(SEED, registered);
    const commands = Array.from({ length: OPS }, () => gen.next());
    commands.push(...gen.drain());
    const hash = createHash('sha1')
      .update(Buffer.from(JSON.stringify(commands), 'latin1'))
      .digest('hex');
    // Written straight to stderr: vitest hides console output of passing tests.
    process.stderr.write(`SEED=${SEED} OPS=${OPS} PROTO=${PROTO} commands-sha1=${hash}\n`);

    const history: string[] = [];
    // The commands Redis queued since MULTI, so EXEC's reply can be compared element by element.
    let queued: string[][] | null = null;
    for (const [i, argv] of commands.entries()) {
      const r: Exchange = await ref.exchange(...argv);
      const m: Exchange = await mine.exchange(...argv);
      const name = argv[0]!.toLowerCase();
      history.push(
        `${argv.map(show).join(' ')}\n      redis:     ${show(r.raw)}\n      miniredis: ${show(m.raw)}`,
      );
      if (history.length > HISTORY) history.shift();
      const match =
        name === 'exec' && queued !== null
          ? execRepliesMatch(queued, r, m)
          : repliesMatch(argv, r, m);
      if (name === 'multi' && queued === null && r.raw === '+OK\r\n') queued = [];
      else if (name === 'exec' || name === 'discard') queued = null;
      else if (queued !== null && r.raw === '+QUEUED\r\n') queued.push(argv);
      if (!match) {
        throw new Error(
          `replies differ (SEED=${SEED}, command ${i + 1} of ${OPS})\n` +
            `Last ${history.length} commands:\n  ${history.join('\n  ')}`,
        );
      }
    }
  });

  it('replies have the same shape in RESP2 and RESP3 for commands the generator never sends', async () => {
    // A fixed script, so every command whose RESP3 reply differs from its RESP2 one is hit on
    // both protocols: maps, sets, doubles, pairs, nulls, verbatim text and pushes.
    const setup = [
      ['RPUSH', 'l', 'a', 'b', 'c'],
      ['SADD', 's', 'a', 'b', 'c', 'd'],
      ['HSET', 'h', 'f1', 'v1', 'f2', 'v2'],
      ['ZADD', 'z', '1', 'a', '2.5', 'b', '3', 'c', 'inf', 'x', '-inf', 'y'],
      ['SET', 'str', '10'],
    ];
    const script = [
      ['ZSCORE', 'z', 'a'],
      ['ZSCORE', 'z', 'x'],
      ['ZSCORE', 'z', 'y'],
      ['ZSCORE', 'z', 'nope'],
      ['ZMSCORE', 'z', 'a', 'nope', 'b'],
      ['ZRANGE', 'z', '0', '-1'],
      ['ZRANGE', 'z', '0', '-1', 'WITHSCORES'],
      ['ZRANGE', 'z', '(1', '+inf', 'BYSCORE', 'WITHSCORES', 'LIMIT', '0', '2'],
      ['ZRANGEBYSCORE', 'z', '-inf', '+inf', 'WITHSCORES'],
      ['ZREVRANGE', 'z', '0', '-1', 'WITHSCORES'],
      ['ZREVRANGEBYSCORE', 'z', '+inf', '-inf', 'WITHSCORES', 'LIMIT', '1', '2'],
      ['ZRANK', 'z', 'b'],
      ['ZRANK', 'z', 'b', 'WITHSCORE'],
      ['ZREVRANK', 'z', 'b', 'WITHSCORE'],
      ['ZRANK', 'z', 'nope', 'WITHSCORE'],
      ['ZRANDMEMBER', 'z', '10', 'WITHSCORES'],
      ['ZRANDMEMBER', 'nokey', '3', 'WITHSCORES'],
      ['ZINTER', '1', 'z', 'WITHSCORES'],
      ['ZUNION', '2', 'z', 'z', 'WITHSCORES'],
      ['ZDIFF', '1', 'z', 'WITHSCORES'],
      ['ZSCAN', 'z', '0'],
      ['ZINCRBY', 'z', '1.5', 'a'],
      ['ZADD', 'z', 'INCR', '1', 'a'],
      ['ZADD', 'z', 'NX', 'INCR', '1', 'a'],
      ['ZPOPMIN', 'z'],
      ['ZPOPMAX', 'z', '2'],
      ['ZPOPMIN', 'nokey'],
      ['ZPOPMIN', 'nokey', '2'],
      ['HGETALL', 'h'],
      ['HGETALL', 'nokey'],
      ['HRANDFIELD', 'h', '10', 'WITHVALUES'],
      ['HRANDFIELD', 'h', '-3'],
      ['HSCAN', 'h', '0'],
      ['HMGET', 'h', 'f1', 'nope'],
      ['HINCRBYFLOAT', 'h', 'f3', '1.5'],
      ['SMEMBERS', 's'],
      ['SMISMEMBER', 's', 'a', 'nope'],
      ['SPOP', 's', '10'],
      ['SPOP', 'nokey', '2'],
      ['SPOP', 'nokey'],
      ['SADD', 's', 'a', 'b'],
      ['SRANDMEMBER', 's', '10'],
      ['SRANDMEMBER', 's', '-2'],
      ['SRANDMEMBER', 'nokey'],
      ['SINTERCARD', '1', 's'],
      ['SSCAN', 's', '0'],
      ['SINTER', 's', 'nokey'],
      ['BLPOP', 'nolist', '0.01'],
      ['BRPOP', 'nolist', '0.01'],
      ['BLMOVE', 'nolist', 'l', 'LEFT', 'RIGHT', '0.01'],
      ['BLPOP', 'l', '0'],
      ['BRPOP', 'l', 'nolist', '0'],
      ['LPOS', 'l', 'zz'],
      ['LPOS', 'l', 'c', 'COUNT', '0'],
      ['LRANGE', 'l', '0', '-1'],
      ['SCAN', '0', 'MATCH', 'nothing-like-this*'],
      ['GETEX', 'nokey'],
      ['INCRBYFLOAT', 'str', '0.25'],
      ['TTL', 'nokey'],
      ['OBJECT', 'ENCODING', 'nokey'],
      ['CONFIG', 'GET', 'maxmemory'],
      ['CONFIG', 'GET', 'nosuchdirective'],
      ['WATCH', 'w'],
      ['SET', 'w', '1'],
      ['MULTI'],
      ['PING'],
      ['EXEC'],
      ['MULTI'],
      ['NOSUCHCOMMAND'],
      ['EXEC'],
      ['MULTI'],
      ['ZSCORE', 'z', 'a'],
      ['HGETALL', 'h'],
      ['LPOP', 'nolist'],
      ['EXEC'],
      ['FLUSHALL'],
      ['RANDOMKEY'],
    ];
    // † commands and the ones out of scope (spec 2, 8) aren't registered; leave them out.
    const registered = buildCommandTable();
    const skipped = new Set<string>();
    const commands = [...setup, ...script].filter((argv) => {
      const known = registered.has(argv[0]!.toLowerCase());
      if (!known) skipped.add(argv[0]!.toUpperCase());
      return known;
    });
    process.stderr.write(`RESP shapes: not registered, skipped: ${[...skipped].join(' ')}\n`);
    for (const proto of ['2', '3']) {
      for (const c of [ref, mine]) {
        await c.exchange('HELLO', proto);
        await c.exchange('FLUSHALL');
      }
      let queued: string[][] | null = null;
      for (const argv of commands) {
        const r = await ref.exchange(...argv);
        const m = await mine.exchange(...argv);
        const name = argv[0]!.toLowerCase();
        const match =
          name === 'exec' && queued !== null
            ? execRepliesMatch(queued, r, m)
            : name === 'zrandmember' ||
                name === 'hrandfield' ||
                (name === 'srandmember' && argv[2]?.startsWith('-'))
              ? sameElements(r, m)
              : name === 'zscan' || name === 'hscan' || name === 'sscan'
                ? sameScanShape(r, m)
                : repliesMatch(argv, r, m);
        if (name === 'multi' && r.raw === '+OK\r\n') queued = [];
        else if (name === 'exec') queued = null;
        else if (queued !== null && r.raw === '+QUEUED\r\n') queued.push(argv);
        if (!match) {
          throw new Error(
            `RESP${proto}: ${argv.join(' ')}\n  redis:     ${show(r.raw)}\n  miniredis: ${show(m.raw)}`,
          );
        }
      }
    }
    // Back to the protocol the run was asked for.
    for (const c of [ref, mine]) await c.exchange('HELLO', PROTO);
  });

  it('INFO is plain text in RESP2 and verbatim text in RESP3', async () => {
    for (const proto of ['2', '3']) {
      for (const c of [ref, mine]) await c.exchange('HELLO', proto);
      const r = await ref.exchange('INFO', 'server');
      const m = await mine.exchange('INFO', 'server');
      expect(m.raw[0]).toBe(r.raw[0]); // '$' or '='
      if (proto === '3') expect(m.raw).toMatch(/^=\d+\r\ntxt:# Server\r\n/);
    }
    for (const c of [ref, mine]) await c.exchange('HELLO', PROTO);
  });

  it('SCAN returns the same set of keys on both servers in every database', async () => {
    for (let db = 0; db < DB_COUNT; db++) {
      const sets: string[][] = [];
      for (const c of [ref, mine]) {
        await c.exchange('SELECT', String(db));
        const found = new Set<string>();
        let cursor = '0';
        do {
          const reply = (await c.exchange('SCAN', cursor, 'COUNT', '7')).value as [
            string,
            string[],
          ];
          cursor = reply[0];
          for (const k of reply[1]) found.add(k);
        } while (cursor !== '0');
        sets.push([...found].sort());
      }
      expect(sets[1], `keys in db ${db}`).toEqual(sets[0]);
    }
  });
});
