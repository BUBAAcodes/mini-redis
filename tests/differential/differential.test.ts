// The differential test (spec 15.3): the same random commands go to Redis 7.4 and to an
// in-process MiniRedis, and every reply must match. This is the judge for rule 3.
//
// Key design choice: all commands are generated before the first one is sent, because the
// generator never looks at replies. That makes the run a pure function of SEED, so the printed
// command hash lets you check that a replay really sent the same bytes.
//
//   SEED=81723 OPS=20000 npm run test:diff     (REDIS_PORT overrides 6379)
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
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const HISTORY = 20;

const show = (s: string): string => JSON.stringify(s).slice(0, 300);

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
    process.stderr.write(`SEED=${SEED} OPS=${OPS} commands-sha1=${hash}\n`);

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
