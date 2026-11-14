// Replica lag under load (spec 18): while redis-benchmark writes to the primary, sample the
// primary's `master_repl_offset` and each replica's acknowledged offset once a second. Lag is
// their difference in bytes of replication stream not yet confirmed by the replica.
//
// Run: docker compose --profile replication up -d --build
//      npx tsx bench/repl-lag.ts
//
// The replica's offset here is the one from its last REPLCONF ACK (sent every second), so a
// lag of up to one second of traffic is the measuring instrument, not the replica falling
// behind. A lag that keeps growing across samples is what would mean the replica can't keep up.
import { spawn } from 'node:child_process';
import { call, sleep } from './lib.js';

const PRIMARY = 6380;
const N = process.env.N ?? '1000000';

const bench = spawn(
  'docker',
  [
    'compose',
    'exec',
    '-T',
    'redis',
    'redis-benchmark',
    '-h',
    'miniredis',
    '-p',
    '6380',
    '-n',
    N,
    '-c',
    '50',
    '-t',
    'set,lpush,incr',
    '-q',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
let running = true;
bench.on('exit', () => (running = false));

const samples: number[][] = [];
let offsetAtStart: number | undefined;
let lastOffset = 0;
while (running) {
  await sleep(1000);
  const text = await call(PRIMARY, 'INFO', 'replication');
  const master = Number(/^master_repl_offset:(\d+)\r$/m.exec(text)?.[1]);
  const replicas = [...text.matchAll(/^slave\d+:.*offset=(\d+)/gm)].map((m) => Number(m[1]));
  if (replicas.length === 0) throw new Error('no replicas: start the compose replication profile');
  offsetAtStart ??= master;
  lastOffset = master;
  samples.push(replicas.map((r) => master - r));
  console.error(`t=${samples.length}s offset=${master} lag=${samples.at(-1)!.join(', ')}`);
}

const seconds = samples.length;
const rate = (lastOffset - (offsetAtStart ?? 0)) / Math.max(1, seconds - 1);
console.log('| Replica | Samples | Mean lag | Max lag | Last lag | Stream rate |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
for (let r = 0; r < (samples[0]?.length ?? 0); r++) {
  const lags = samples.map((s) => s[r]!);
  const mean = lags.reduce((a, b) => a + b, 0) / lags.length;
  console.log(
    `| replica${r + 1} | ${seconds} | ${(mean / 1024).toFixed(0)} KB | ${(Math.max(...lags) / 1024).toFixed(0)} KB | ${(lags.at(-1)! / 1024).toFixed(0)} KB | ${(rate / 1024 / 1024).toFixed(1)} MB/s |`,
  );
}
