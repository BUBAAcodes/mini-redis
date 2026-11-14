// The RESP parser on its own, without sockets (step 24's before/after): a pipeline of SET and
// MSET commands is cut into 16 KB chunks, as a socket would deliver them, and parsed again
// and again. No network and no scheduler in the loop, so unlike redis-benchmark through
// WSL2 or Docker the number repeats to within a few percent from run to run.
//
// Run: npx tsx bench/parser.ts
import { RespParser } from '../src/protocol/parser.js';

const CHUNK = 16 * 1024;
const ROUNDS = 15;
const WARMUP = 3;

const encode = (argv: string[]): string =>
  `*${argv.length}\r\n` + argv.map((a) => `$${a.length}\r\n${a}\r\n`).join('');

function workload(name: string, commands: number, make: (i: number) => string[]) {
  let text = '';
  for (let i = 0; i < commands; i++) text += encode(make(i));
  const bytes = Buffer.from(text, 'latin1');
  const chunks: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += CHUNK) chunks.push(bytes.subarray(at, at + CHUNK));
  return { name, commands, bytes: bytes.length, chunks };
}

const WORKLOADS = [
  workload('SET key:<n> <3 bytes>', 200_000, (i) => ['SET', `key:${i % 100_000}`, 'xxx']),
  workload('MSET, 10 pairs', 20_000, (i) =>
    [
      'MSET',
      ...Array.from({ length: 10 }, (_, j) => [`key:${(i * 10 + j) % 100_000}`, 'xxx']),
    ].flat(),
  ),
  workload('SET with a 100-byte value', 200_000, (i) => ['SET', `key:${i}`, 'v'.repeat(100)]),
];

function run(w: (typeof WORKLOADS)[number]): number {
  const parser = new RespParser();
  let parsed = 0;
  const start = process.hrtime.bigint();
  for (const chunk of w.chunks) {
    parser.feed(chunk);
    while (parser.next() !== null) parsed++;
  }
  const ns = Number(process.hrtime.bigint() - start);
  if (parsed !== w.commands) throw new Error(`parsed ${parsed} of ${w.commands}`);
  return (w.commands / ns) * 1e9;
}

console.log('| Workload | Commands | MB | Best commands/s | Median commands/s |');
console.log('| --- | ---: | ---: | ---: | ---: |');
for (const w of WORKLOADS) {
  for (let i = 0; i < WARMUP; i++) run(w); // let the JIT compile the hot paths first
  const rates = Array.from({ length: ROUNDS }, () => run(w)).sort((a, b) => a - b);
  const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');
  console.log(
    `| ${w.name} | ${w.commands.toLocaleString('en-US')} | ${(w.bytes / 1e6).toFixed(1)} | ${fmt(rates.at(-1)!)} | ${fmt(rates[ROUNDS >> 1]!)} |`,
  );
}
