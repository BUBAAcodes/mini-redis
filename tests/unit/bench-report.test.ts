import { describe, expect, it } from 'vitest';
import { compareTable, parseBenchmarkCsv } from '../../bench/report.js';

const HEADER =
  '"test","rps","avg_latency_ms","min_latency_ms","p50_latency_ms","p95_latency_ms","p99_latency_ms","max_latency_ms"';

const REDIS = [
  HEADER,
  '"PING_INLINE","100000.00","0.257","0.064","0.247","0.399","0.503","1.200"',
  '"SET","80000.00","0.300","0.080","0.287","0.455","0.615","2.000"',
  '"LRANGE_100 (first 100 elements)","40000.00","0.700","0.200","0.650","1.100","1.500","3.000"',
].join('\n');

const MINI = [
  HEADER,
  '"PING_INLINE","50000.00","0.500","0.100","0.479","0.800","1.031","4.000"',
  '"SET","20000.00","1.250","0.200","1.199","2.000","2.503","9.000"',
].join('\n');

describe('parseBenchmarkCsv', () => {
  it('reads every row of redis-benchmark --csv, quoted names with spaces included', () => {
    const rows = parseBenchmarkCsv(REDIS);
    expect([...rows.keys()]).toEqual(['PING_INLINE', 'SET', 'LRANGE_100 (first 100 elements)']);
    expect(rows.get('SET')).toEqual({ rps: 80000, avg: 0.3, p50: 0.287, p99: 0.615 });
  });

  it('ignores blank lines and a trailing newline', () => {
    expect(parseBenchmarkCsv(`${MINI}\n\n`).size).toBe(2);
  });

  it('rejects a file that is not redis-benchmark CSV', () => {
    expect(() => parseBenchmarkCsv('hello\nworld')).toThrow(/not redis-benchmark --csv/);
  });
});

describe('compareTable', () => {
  const table = compareTable(parseBenchmarkCsv(REDIS), parseBenchmarkCsv(MINI));
  const lines = table.trim().split('\n');

  it('has a header, a separator and one row per test, in Redis order', () => {
    expect(lines[0]).toBe(
      '| Test | Redis ops/s | MiniRedis ops/s | MiniRedis / Redis | Redis p50 ms | MiniRedis p50 ms | Redis p99 ms | MiniRedis p99 ms |',
    );
    expect(lines[1]).toMatch(/^\|( ?-+:? ?\|)+$/);
    expect(lines).toHaveLength(5);
  });

  it('shows the throughput ratio as a percentage and both latencies', () => {
    expect(lines[2]).toBe(
      '| PING_INLINE | 100,000 | 50,000 | 50% | 0.247 | 0.479 | 0.503 | 1.031 |',
    );
    expect(lines[3]).toBe('| SET | 80,000 | 20,000 | 25% | 0.287 | 1.199 | 0.615 | 2.503 |');
  });

  it('shows a non-positive rps (a redis-benchmark counter overflow) as a dash, not a number', () => {
    const bad = parseBenchmarkCsv(
      [HEADER, '"LPUSH","-215517.00","1.0","0.1","1.655","2.0","3.759","9.0"'].join('\n'),
    );
    const row = compareTable(bad, bad).trim().split('\n')[2];
    expect(row).toBe('| LPUSH | — | — | — | 1.655 | 1.655 | 3.759 | 3.759 |');
  });

  it('marks a test one side is missing with a dash instead of dropping it', () => {
    expect(lines[4]).toBe(
      '| LRANGE_100 (first 100 elements) | 40,000 | — | — | 0.650 | — | 1.500 | — |',
    );
  });
});
