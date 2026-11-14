// The fuzzer (spec 15.6, rule 11): hostile bytes in, and the server must never crash, hang,
// answer "internal error", leak connections or grow without bound.
//
// Each case opens a fresh connection, writes its bytes (in several pieces, so the parser sees
// partial input), and waits up to one second. The server may answer, answer with an error and
// close, or wait for more data; all three are fine. What is not fine is checked around them:
// a reply of `-ERR internal error` (a handler threw: that is a bug, and gets a test), a new
// connection that no longer gets PONG, the event loop stalling, connections left open on the
// server side, or the heap growing past its baseline.
//
// Cases come from inputs.ts as a pure function of (SEED, index), so a failure replays alone:
//   SEED=123 CASES=1000000 npm run test:fuzz      the run
//   SEED=123 CASE=48213 npm run test:fuzz         one case again
import net from 'node:net';
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Random } from '../../src/utils/random.js';
import { TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';
import { CORPUS, PASSWORD, encode, generateCase } from './inputs.js';
import type { Category, FuzzCase } from './inputs.js';

const SEED = process.env.SEED ? Number(process.env.SEED) >>> 0 : Random.entropySeed();
const CASES = Number(process.env.CASES ?? 10_000);
const ONLY = process.env.CASE === undefined ? null : Number(process.env.CASE);
// The clients here are open loop (a case ends after QUIET_MS whether or not the server has got
// to it), so too many at once outrun the accept queue and the kernel drops SYNs. 16 stays inside
// what the server accepts per second.
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16);
const DEADLINE_MS = 1000;
// Time is measured with performance.now() (monotonic): WSL's wall clock can jump, which
// once looked like a 14-minute event-loop stall.
/** No new bytes from the server for this long, after the last write: it is waiting for more. */
const QUIET_MS = 15;
const CHECKPOINT = 10_000;
const PONG_EVERY = 500;
const HEAP_GROWTH_LIMIT = 256 * 1024 * 1024;

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

let open: TestServer;
let locked: TestServer;

beforeAll(async () => {
  open = await startServer({ 'enable-debug-command': 'no' });
  locked = await startServer({ 'enable-debug-command': 'no', requirepass: PASSWORD });
  process.stderr.write(`fuzz: SEED=${SEED} CASES=${CASES} CONCURRENCY=${CONCURRENCY}\n`);
});

afterAll(async () => {
  await open?.close();
  await locked?.close();
});

/** `no-connect`: the TCP connection was never established (see runCaseOnce's caller). */
type Outcome = 'closed' | 'replied' | 'waiting' | 'deadline' | 'no-connect';

interface Result {
  outcome: Outcome;
  /** The first bytes the server sent, for the sanity checks. */
  head: string;
  error: string | null;
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One case on a fresh connection. Never rejects: what happened is in the Result. */
function runCaseOnce(port: number, fuzz: FuzzCase): Promise<Result> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let head = '';
    let received = 0;
    let error: string | null = null;
    let writing = true;
    let quiet: NodeJS.Timeout | null = null;
    let done = false;
    let connected = false;

    const finish = (outcome: Outcome): void => {
      if (done) return;
      done = true;
      if (quiet !== null) clearTimeout(quiet);
      clearTimeout(deadline);
      socket.destroy();
      resolve({
        outcome: outcome === 'deadline' && !connected ? 'no-connect' : outcome,
        head,
        error,
      });
    };
    const arm = (): void => {
      if (quiet !== null) clearTimeout(quiet);
      if (!writing)
        quiet = setTimeout(() => finish(received > 0 ? 'replied' : 'waiting'), QUIET_MS);
    };
    const deadline = setTimeout(() => finish('deadline'), DEADLINE_MS);

    socket.on('data', (d: Buffer) => {
      if (head.length < 4096) head += d.toString('latin1', 0, 4096 - head.length);
      received += d.length;
      arm();
    });
    // The server may close while we are still writing; that is an answer, not a failure.
    socket.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ECONNRESET' && e.code !== 'EPIPE') error = `${e.code ?? ''} ${e.message}`;
    });
    socket.on('close', () => finish('closed'));
    socket.on('connect', () => {
      connected = true;
      void (async () => {
        for (const [i, chunk] of fuzz.chunks.entries()) {
          if (done) return;
          socket.write(chunk);
          if (i < fuzz.chunks.length - 1) await pause(i % 2);
        }
        writing = false;
        arm();
      })();
    });
  });
}

/**
 * Runs a case, and once more if the connection could not even be made. A dropped SYN is the
 * kernel's accept queue overflowing under load, not the server's doing; a server that really
 * stopped accepting fails the retry too, and the PONG checks.
 */
async function runCase(port: number, fuzz: FuzzCase): Promise<Result> {
  const first = await runCaseOnce(port, fuzz);
  if (first.outcome !== 'no-connect') return first;
  const second = await runCaseOnce(port, fuzz);
  if (second.outcome === 'no-connect')
    throw new Error(`could not connect to the server twice in a row (port ${port})`);
  return second;
}

const show = (b: Buffer | string, n = 160): string =>
  JSON.stringify((typeof b === 'string' ? b : b.toString('latin1')).slice(0, n));

function describeCase(index: number, fuzz: FuzzCase): string {
  const size = fuzz.chunks.reduce((sum, c) => sum + c.length, 0);
  return (
    `case ${index} (${fuzz.category}${fuzz.locked ? ', locked server' : ''}, ${size} bytes in ` +
    `${fuzz.chunks.length} writes): ${show(Buffer.concat(fuzz.chunks))}\n` +
    `  replay: SEED=${SEED} CASE=${index} npm run test:fuzz`
  );
}

/** A new connection must still be served: the server is neither dead nor stuck. */
async function expectPong(t: TestServer, after: string): Promise<void> {
  const c = await Promise.race([TestClient.connect(t.port), pause(DEADLINE_MS).then(() => null)]);
  if (c === null) throw new Error(`the server stopped accepting connections ${after}`);
  try {
    const reply = locked === t ? await authedPing(c) : await c.raw('PING');
    if (reply !== '+PONG\r\n') throw new Error(`PING answered ${show(reply)} ${after}`);
  } finally {
    c.socket.destroy();
  }
}

async function authedPing(c: TestClient): Promise<string> {
  await c.raw('AUTH', PASSWORD);
  return c.raw('PING');
}

describe('fuzz: hostile input never crashes or hangs the server', () => {
  it(
    `survives ${ONLY === null ? CASES : 1} cases`,
    async () => {
      const counts = new Map<string, number>();
      const bump = (key: string): void => void counts.set(key, (counts.get(key) ?? 0) + 1);
      let maxLag = 0;
      const lagTimer = setInterval(
        (() => {
          let last = performance.now();
          return () => {
            const now = performance.now();
            maxLag = Math.max(maxLag, now - last - 50);
            last = now;
          };
        })(),
        50,
      );
      const started = performance.now();
      let baseline = 0;

      const one = async (index: number): Promise<void> => {
        const fuzz = generateCase(SEED, index);
        const server = fuzz.locked ? locked : open;
        const result = await runCase(server.port, fuzz);
        bump(`${fuzz.category}:${result.outcome}`);
        if (result.error !== null) {
          throw new Error(`socket error ${result.error}\n  ${describeCase(index, fuzz)}`);
        }
        if (/internal error/i.test(result.head)) {
          throw new Error(
            `a handler threw: ${show(result.head)}\n  ${describeCase(index, fuzz)}\n  ` +
              `log: ${[...open.logs, ...locked.logs].filter((l) => l.includes('Internal error')).slice(-1)[0] ?? '(none)'}`,
          );
        }
        // Whatever it says first must at least look like RESP.
        if (result.head !== '' && !/^[+\-:$*%~_,#=>(]/.test(result.head)) {
          throw new Error(
            `reply is not RESP: ${show(result.head)}\n  ${describeCase(index, fuzz)}`,
          );
        }
        if (index % PONG_EVERY === 0) {
          await expectPong(open, `after ${describeCase(index, fuzz)}`);
          await expectPong(locked, `after ${describeCase(index, fuzz)}`);
        }
      };

      try {
        if (ONLY !== null) {
          await one(ONLY);
          return;
        }
        const admin = await TestClient.connect(open.port);
        for (let from = 0; from < CASES; from += CHECKPOINT) {
          const to = Math.min(from + CHECKPOINT, CASES);
          let next = from;
          let failure: unknown = null;
          await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, to - from) }, async () => {
              while (failure === null && next < to) {
                const index = next++;
                try {
                  await one(index);
                } catch (e) {
                  failure ??= e;
                }
              }
            }),
          );
          if (failure !== null) throw failure;

          // Checkpoint: nothing left open, the dataset emptied, the heap where it should be.
          for (const t of [open, locked]) {
            const end = performance.now() + 3000;
            // Our own admin connection stays open on the open server.
            const idle = t === open ? 1 : 0;
            while (t.server.clients.size > idle && performance.now() < end) await pause(10);
            expect(t.server.clients.size, `connections left open after case ${to}`).toBe(idle);
          }
          await admin.raw('FLUSHALL');
          gc();
          const heap = process.memoryUsage().heapUsed;
          if (baseline === 0 || from === 0) baseline = Math.max(baseline, heap);
          process.stderr.write(
            `fuzz: ${to}/${CASES} cases, heap ${(heap / 1048576).toFixed(0)} MB, ` +
              `${((to / (performance.now() - started)) * 1000).toFixed(0)} cases/s, max loop lag ${maxLag} ms\n`,
          );
          expect(
            heap - baseline,
            `heap grew by ${heap - baseline} bytes after ${to} cases`,
          ).toBeLessThan(HEAP_GROWTH_LIMIT);
          expect(maxLag, 'the event loop stalled').toBeLessThan(DEADLINE_MS);
        }
        admin.socket.destroy();
        await expectPong(open, 'at the end');
        await expectPong(locked, 'at the end');
        const internal = [...open.logs, ...locked.logs].filter((l) => l.includes('Internal error'));
        expect(internal, 'the server logged an internal error').toEqual([]);
      } finally {
        clearInterval(lagTimer);
        const summary = [...counts.entries()].sort().map(([k, n]) => `${k}=${n}`);
        process.stderr.write(`fuzz outcomes: ${summary.join(' ')}\n`);
      }
    },
    Math.max(120_000, CASES * 20),
  );

  // Spec 15.6: frames cut at every position. Every corpus command, cut after each byte, with
  // the connection then left open (waiting) and closed (a client that hung up mid-frame).
  it('every cut position of every corpus frame leaves the server serving', async () => {
    const jobs: { argv: readonly string[]; cut: number }[] = [];
    for (const argv of CORPUS) {
      for (let cut = 0; cut < encode(argv).length; cut++) jobs.push({ argv, cut });
    }
    let next = 0;
    await Promise.all(
      Array.from({ length: 32 }, async () => {
        while (next < jobs.length) {
          const { argv, cut } = jobs[next++]!;
          const fuzz: FuzzCase = {
            category: 'cut-frame' satisfies Category,
            locked: false,
            chunks: [encode(argv).subarray(0, cut)],
          };
          const result = await runCase(open.port, fuzz);
          expect(result.error).toBeNull();
          expect(result.head, `${argv.join(' ')} cut at ${cut}`).not.toMatch(/internal error/i);
        }
      }),
    );
    const n = jobs.length;
    await expectPong(open, `after ${n} cut frames`);
  }, 120_000);
});
