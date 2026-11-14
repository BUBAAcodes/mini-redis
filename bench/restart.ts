// Restart time with 1M keys (spec 18), from the AOF and from a snapshot: the built server is
// started in a child process on a temp dir, filled, killed, and started again; the time from
// spawn to "Ready to accept connections" is the restart time, data loading included.
//
// Run: npm run build && npx tsx bench/restart.ts [keys]
//
// An empty start is timed too, so the loading cost can be read as the difference. The kill is
// SIGKILL after every reply arrived: a reply means its AOF bytes were already handed to the OS
// (rule 8), so the AOF is complete without a clean shutdown.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, fill, mb } from './lib.js';

const KEYS = Number(process.argv[2] ?? 1_000_000);
const ENTRY = join(import.meta.dirname, '../dist/index.js');

interface Running {
  port: number;
  kill(): Promise<void>;
}

/** Spawns the built server on `dir` and resolves once its log says it accepts connections. */
function start(dir: string, directives: Record<string, string>): Promise<Running> {
  const flags = Object.entries({ port: '0', dir, ...directives }).flatMap(([k, v]) => [
    `--${k}`,
    v,
  ]);
  const child: ChildProcess = spawn(process.execPath, [ENTRY, ...flags], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (d: Buffer): void => {
      out += d.toString('latin1');
      const port = /Running mode=standalone, port=(\d+)\./.exec(out);
      if (port && out.includes('Ready to accept connections tcp')) {
        resolve({
          port: Number(port[1]),
          kill: async () => {
            child.kill('SIGKILL'); // kill -9: no shutdown code runs
            await exited;
          },
        });
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    void exited.then(() => reject(new Error(`server exited before it was ready:\n${out}`)));
  });
}

async function timedStart(dir: string, directives: Record<string, string>) {
  const begin = process.hrtime.bigint();
  const server = await start(dir, directives);
  const ms = Number(process.hrtime.bigint() - begin) / 1e6;
  return { server, ms };
}

async function measure(label: string, directives: Record<string, string>, file: string) {
  const dir = mkdtempSync(join(tmpdir(), 'miniredis-restart-'));
  try {
    const empty = await timedStart(dir, directives);
    await fill(empty.server.port, KEYS, 100);
    if (directives.appendonly !== 'yes') await call(empty.server.port, 'SAVE');
    await empty.server.kill();
    const size = statSync(join(dir, file)).size;
    const loaded = await timedStart(dir, directives);
    const dbsize = (await call(loaded.server.port, 'DBSIZE')).trim();
    await loaded.server.kill();
    if (dbsize !== `:${KEYS}`) throw new Error(`${label}: DBSIZE ${dbsize} after restart`);
    console.log(
      `| ${label} | ${KEYS.toLocaleString('en-US')} | ${mb(size)} | ${empty.ms.toFixed(0)} ms | ${(loaded.ms / 1000).toFixed(2)} s |`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('| Restart from | Keys | File size | Empty start | Start with data |');
console.log('| --- | ---: | ---: | ---: | ---: |');
await measure(
  'AOF (everysec)',
  { appendonly: 'yes', appendfsync: 'everysec', save: '' },
  'appendonly.aof',
);
await measure('Snapshot', { appendonly: 'no', save: '' }, 'dump.mrdb');
