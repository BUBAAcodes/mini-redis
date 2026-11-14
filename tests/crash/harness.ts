// The crash suite's tools (spec 15.5): the built server in a child process, a write load whose
// guarantees can be checked after a SIGKILL, and the checks themselves.
//
// Key design choice: the load is built so that every guarantee is a cheap exact check. Each INCR
// writer has at most one command in flight, so after a restart its counter must be the last
// acknowledged value or one more. Transfers keep A + B constant. Hashes and lists are always
// rewritten whole by one command or one MULTI, so a loaded one with mixed values was half-written.
//
// Mirrors Redis's tests/integration/aof.tcl and rdb.tcl, which also restart a real server
// process on the files a killed one left behind.
import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { Random } from '../../src/utils/random.js';
import { type RespValue, TestClient } from '../helpers/resp-client.js';

/** Kill-restart cycles per scenario: 50 locally, 10 in CI. */
export const KILLS = Number(process.env.KILLS ?? 50);

/** One seed per run, printed, so the kill timings and the load's choices can be replayed. */
export const SEED =
  process.env.SEED === undefined ? Random.entropySeed() : Number(process.env.SEED);
console.log(`crash suite: SEED=${SEED} KILLS=${KILLS}`);

export const ENTRY = join(import.meta.dirname, '../../dist/index.js');

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'miniredis-crash-'));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Temp files a job left behind in `dir` (spec 6.2). */
export function leftoverTemps(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('temp-'));
}

/** The built server (`npm run test:crash` builds it first) running in a child process. */
export class CrashServer {
  private out = '';
  private readonly exited: Promise<void>;
  private exitCode: number | null | undefined = undefined;

  private constructor(
    readonly child: ChildProcess,
    readonly dir: string,
  ) {
    child.stdout!.on('data', (d: Buffer) => (this.out += d.toString('latin1')));
    child.stderr!.on('data', (d: Buffer) => (this.out += d.toString('latin1')));
    this.exited = new Promise((resolve) =>
      child.on('exit', (code) => {
        this.exitCode = code;
        resolve();
      }),
    );
  }

  port = 0;

  /** Starts the server on `dir` and resolves once it accepts connections (the data is loaded). */
  static async start(dir: string, directives: Record<string, string>): Promise<CrashServer> {
    const flags = Object.entries({ port: '0', dir, ...directives }).flatMap(([k, v]) => [
      `--${k}`,
      v,
    ]);
    const s = new CrashServer(
      spawn(process.execPath, [ENTRY, ...flags], { stdio: ['ignore', 'pipe', 'pipe'] }),
      dir,
    );
    const deadline = Date.now() + 30_000;
    for (;;) {
      const port = /Running mode=standalone, port=(\d+)\./.exec(s.out);
      if (port && s.out.includes('Ready to accept connections tcp')) {
        s.port = Number(port[1]);
        return s;
      }
      if (s.exitCode !== undefined || Date.now() > deadline) {
        s.child.kill('SIGKILL');
        await s.exited;
        throw new Error(`server didn't start (exit code ${s.exitCode}); output:\n${s.out}`);
      }
      await sleep(10);
    }
  }

  get output(): string {
    return this.out;
  }

  /** kill -9: no shutdown code runs, exactly like a crash. */
  async kill(): Promise<void> {
    this.child.kill('SIGKILL');
    await this.exited;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `INFO` field `name` as a string. */
export async function info(c: TestClient, name: string): Promise<string> {
  const text = (await c.call('INFO', 'persistence')) as string;
  const m = new RegExp(`^${name}:(.*)\r$`, 'm').exec(text);
  if (!m) throw new Error(`no ${name} in INFO`);
  return m[1]!;
}

const WRITERS = 10;
const TRANSFER_CLIENTS = 50;
const SHAPES = 50; // hashes and lists the filler keeps rewriting whole
const FIELDS = 10;
const ITEMS = 20;
export const TOTAL = 2_000_000;

/** How the counters may have moved across a crash. */
export type Durability =
  // Every acknowledged write survives (the AOF, any fsync mode).
  | 'acked'
  // Some point-in-time state at or after the last load (snapshots).
  | 'snapshot'
  // Exactly the state of the last load (a snapshot job killed before it renamed its file).
  | 'unchanged';

interface Loaded {
  counters: number[];
  a: number;
  b: number;
}

/**
 * The write load and its bookkeeping, kept across every kill and restart of one scenario.
 * Counters are `ctr:<i>`; A and B hold the transfer total; `h:<n>` and `l:<n>` are the shapes.
 */
export class Workload {
  readonly rng = new Random(SEED);
  /** Highest counter value each writer has seen acknowledged. */
  private acked = new Array<number>(WRITERS).fill(0);
  /** Whether a writer's INCR was in flight when the server died. */
  private inFlight = new Array<boolean>(WRITERS).fill(false);
  private loaded: Loaded = { counters: new Array<number>(WRITERS).fill(0), a: 0, b: 0 };
  /** Acknowledged transfers and filler writes over the whole scenario, to prove load happened. */
  transfers = 0;
  fills = 0;

  /** Initial data: counters, A and B, and every shape, plus `extra` padding keys. */
  async seed(c: TestClient, extra = 0): Promise<void> {
    expect(await c.call('SET', 'A', String(TOTAL / 2))).toBe('OK');
    expect(await c.call('SET', 'B', String(TOTAL / 2))).toBe('OK');
    for (let i = 0; i < WRITERS; i++) c.send('SET', `ctr:${i}`, '0');
    for (let n = 0; n < SHAPES; n++) {
      c.send('HSET', `h:${n}`, ...hashArgs(0));
      c.send('RPUSH', `l:${n}`, ...new Array<string>(ITEMS).fill('0'));
    }
    for (let i = 0; i < extra; i++) c.send('SET', `pad:${i}`, `value-${i}`);
    for (let i = 0; i < WRITERS + 2 * SHAPES + extra; i++) await c.read();
    this.loaded = { counters: new Array<number>(WRITERS).fill(0), a: TOTAL / 2, b: TOTAL / 2 };
  }

  /** Checks the restarted server against what the load did before the kill. */
  async verify(c: TestClient, durability: Durability, extra = 0): Promise<void> {
    const a = Number(await c.call('GET', 'A'));
    const b = Number(await c.call('GET', 'B'));
    expect(a + b, 'A + B').toBe(TOTAL);

    const counters: number[] = [];
    for (let i = 0; i < WRITERS; i++) {
      const v = Number(await c.call('GET', `ctr:${i}`));
      const upper = this.acked[i]! + (this.inFlight[i] ? 1 : 0);
      if (durability === 'acked') {
        expect(v, `ctr:${i} lost an acknowledged write`).toBeGreaterThanOrEqual(this.acked[i]!);
        expect(v, `ctr:${i}`).toBeLessThanOrEqual(upper);
      } else if (durability === 'snapshot') {
        expect(v, `ctr:${i} went back past the last load`).toBeGreaterThanOrEqual(
          this.loaded.counters[i]!,
        );
        expect(v, `ctr:${i}`).toBeLessThanOrEqual(upper);
      } else {
        expect(v, `ctr:${i} isn't the previous snapshot's`).toBe(this.loaded.counters[i]);
      }
      counters.push(v);
    }
    if (durability === 'unchanged') {
      expect(a, 'A').toBe(this.loaded.a);
      expect(b, 'B').toBe(this.loaded.b);
    }

    for (let n = 0; n < SHAPES; n++) {
      const h = (await c.call('HGETALL', `h:${n}`)) as string[];
      expect(h.length, `h:${n} field count`).toBe(2 * FIELDS);
      const hv = new Set(h.filter((_, i) => i % 2 === 1));
      expect(hv.size, `h:${n} was half-written: ${h.join(' ')}`).toBe(1);
      const l = (await c.call('LRANGE', `l:${n}`, '0', '-1')) as string[];
      expect(l.length, `l:${n} length`).toBe(ITEMS);
      expect(new Set(l).size, `l:${n} was half-written: ${l.join(' ')}`).toBe(1);
    }
    for (let i = 0; i < extra; i += Math.max(1, Math.floor(extra / 100))) {
      expect(await c.call('GET', `pad:${i}`)).toBe(`value-${i}`);
    }
    expect(await c.call('DBSIZE')).toBe(WRITERS + 2 + 2 * SHAPES + extra);

    this.acked = [...counters];
    this.inFlight.fill(false);
    this.loaded = { counters, a, b };
  }

  /**
   * Starts the load against `port`: INCR writers, transfer clients and one filler. It runs until
   * the server dies (or `stop` is called); `stopped` resolves once every client has given up.
   */
  async run(port: number): Promise<{ stop(): void; stopped: Promise<void> }> {
    let stop = false;
    const connect = (): Promise<TestClient> => TestClient.connect(port);
    const writers = await Promise.all(Array.from({ length: WRITERS }, connect));
    const transfers = await Promise.all(Array.from({ length: TRANSFER_CLIENTS }, connect));
    const filler = await connect();
    const all = [...writers, ...transfers, filler];

    // A client loop ends when its connection dies: that's the crash.
    const loop = async (body: () => Promise<void>): Promise<void> => {
      try {
        while (!stop) await body();
      } catch {
        // connection closed
      }
    };

    const loops = [
      ...writers.map((w, i) =>
        loop(async () => {
          this.inFlight[i] = true;
          const v = (await w.call('INCR', `ctr:${i}`)) as RespValue;
          this.inFlight[i] = false;
          this.acked[i] = Number(v);
        }),
      ),
      ...transfers.map((t, i) =>
        loop(async () => {
          const n = String(1 + ((i * 7 + this.transfers) % 100));
          t.send('MULTI');
          t.send('DECRBY', 'A', n);
          t.send('INCRBY', 'B', n);
          t.send('EXEC');
          for (let k = 0; k < 4; k++) await t.read();
          this.transfers++;
        }),
      ),
      loop(async () => {
        const n = this.rng.int(SHAPES);
        const v = String(++this.fills);
        // One command rewrites the hash; one transaction rewrites the list.
        filler.send('HSET', `h:${n}`, ...hashArgs(v));
        filler.send('MULTI');
        filler.send('DEL', `l:${n}`);
        filler.send('RPUSH', `l:${n}`, ...new Array<string>(ITEMS).fill(v));
        filler.send('EXEC');
        for (let k = 0; k < 5; k++) await filler.read();
      }),
    ];
    const stopped = Promise.all(loops).then(async () => {
      for (const c of all) c.socket.destroy();
    });
    return {
      stop: () => {
        stop = true;
      },
      stopped,
    };
  }
}

const hashArgs = (v: number | string): string[] =>
  Array.from({ length: FIELDS }, (_, f) => [`f${f}`, String(v)]).flat();
