// Turns two `redis-benchmark --csv` files, one per server, into the markdown comparison table
// in bench/RESULTS.md (spec 18): ops/sec for both, the ratio, and p50 and p99 latency for both.
//
// Run: npx tsx bench/report.ts bench/redis.csv bench/miniredis.csv
//
// A test only one side reports stays in the table with dashes, so a server that skipped or
// crashed on a test shows up as a hole instead of silently vanishing from the comparison.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface BenchRow {
  rps: number;
  avg: number;
  p50: number;
  p99: number;
}

const COLUMNS = ['test', 'rps', 'avg_latency_ms', 'p50_latency_ms', 'p99_latency_ms'] as const;

/** One CSV line; redis-benchmark quotes every field and never puts quotes inside one. */
function fields(line: string): string[] {
  return line.split(',').map((f) => f.trim().replace(/^"(.*)"$/, '$1'));
}

export function parseBenchmarkCsv(text: string): Map<string, BenchRow> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = fields(lines[0] ?? '');
  const at = COLUMNS.map((c) => header.indexOf(c));
  if (at.some((i) => i < 0)) throw new Error('not redis-benchmark --csv output');
  const [iTest, iRps, iAvg, iP50, iP99] = at as [number, number, number, number, number];
  const rows = new Map<string, BenchRow>();
  for (const line of lines.slice(1)) {
    // A test name can contain a comma-free space ("LRANGE_100 (first 100 elements)"), but the
    // numeric fields are always last, so splitting on commas is safe.
    const f = fields(line);
    rows.set(f[iTest]!, {
      rps: Number(f[iRps]),
      avg: Number(f[iAvg]),
      p50: Number(f[iP50]),
      p99: Number(f[iP99]),
    });
  }
  return rows;
}

const DASH = '—';
/** redis-benchmark's counters can overflow on a fast test and print a negative rps. */
const valid = (n: number | undefined): n is number =>
  n !== undefined && Number.isFinite(n) && n > 0;
const ops = (n: number | undefined): string =>
  valid(n) ? Math.round(n).toLocaleString('en-US') : DASH;
const ms = (n: number | undefined): string => (n === undefined ? DASH : n.toFixed(3));

export function compareTable(redis: Map<string, BenchRow>, mini: Map<string, BenchRow>): string {
  const names = [...redis.keys(), ...[...mini.keys()].filter((k) => !redis.has(k))];
  const out = [
    '| Test | Redis ops/s | MiniRedis ops/s | MiniRedis / Redis | Redis p50 ms | MiniRedis p50 ms | Redis p99 ms | MiniRedis p99 ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const name of names) {
    const r = redis.get(name);
    const m = mini.get(name);
    const ratio = valid(r?.rps) && valid(m?.rps) ? `${Math.round((m!.rps / r!.rps) * 100)}%` : DASH;
    out.push(
      `| ${name} | ${ops(r?.rps)} | ${ops(m?.rps)} | ${ratio} | ${ms(r?.p50)} | ${ms(m?.p50)} | ${ms(r?.p99)} | ${ms(m?.p99)} |`,
    );
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [redisFile, miniFile] = process.argv.slice(2);
  if (redisFile === undefined || miniFile === undefined) {
    console.error('usage: tsx bench/report.ts <redis.csv> <miniredis.csv>');
    process.exit(1);
  }
  process.stdout.write(
    compareTable(
      parseBenchmarkCsv(readFileSync(redisFile, 'utf8')),
      parseBenchmarkCsv(readFileSync(miniFile, 'utf8')),
    ),
  );
}
