/**
 * `/metrics` (spec 13.5): Prometheus text format over `node:http`, when `metrics-port` is set.
 *
 * Key design choice: the HTTP server is a thin reader of Server state. A scrape runs between
 * commands in the same thread, so the numbers are consistent with each other, and it costs
 * a few microseconds, never a keyspace walk. It binds to the same address as the main listener
 * (127.0.0.1 by default, spec 12) and answers only GET /metrics.
 *
 * Mirrors nothing in Redis (a redis_exporter does this job); the metric names are ours.
 */
import http from 'node:http';
import type { Server } from '../server/server.js';

/** One metric family: its HELP and TYPE lines, then a sample line per label set. */
function family(
  out: string[],
  name: string,
  type: 'counter' | 'gauge',
  help: string,
  samples: ReadonlyArray<readonly [labels: string, value: number]>,
): void {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const [labels, value] of samples) out.push(`${name}${labels} ${value}`);
}

/** The exposition text for the server's current state. */
export function renderMetrics(server: Server): string {
  const out: string[] = [];
  const stats = server.stats;
  family(out, 'miniredis_connected_clients', 'gauge', 'Connected clients.', [
    ['', server.clients.size],
  ]);
  let blocked = 0;
  for (const c of server.clients.values()) if (c.blocked) blocked++;
  family(out, 'miniredis_blocked_clients', 'gauge', 'Clients blocked in a blocking command.', [
    ['', blocked],
  ]);
  family(out, 'miniredis_commands_processed_total', 'counter', 'Commands processed.', [
    ['', stats.totalCommandsProcessed],
  ]);
  const byCmd = [...server.commandStats].sort(([a], [b]) => (a < b ? -1 : 1));
  family(
    out,
    'miniredis_command_calls_total',
    'counter',
    'Calls per command.',
    byCmd.map(([cmd, s]) => [`{cmd="${cmd}"}`, s.calls]),
  );
  family(
    out,
    'miniredis_command_duration_seconds_sum',
    'counter',
    'Time spent per command, in seconds.',
    byCmd.map(([cmd, s]) => [`{cmd="${cmd}"}`, s.usec / 1e6]),
  );
  family(out, 'miniredis_keyspace_hits_total', 'counter', 'Successful key lookups.', [
    ['', stats.keyspaceHits],
  ]);
  family(out, 'miniredis_keyspace_misses_total', 'counter', 'Failed key lookups.', [
    ['', stats.keyspaceMisses],
  ]);
  family(out, 'miniredis_expired_keys_total', 'counter', 'Keys deleted by expiry.', [
    ['', stats.expiredKeys],
  ]);
  family(out, 'miniredis_evicted_keys_total', 'counter', 'Keys deleted by eviction.', [
    ['', stats.evictedKeys],
  ]);
  family(out, 'miniredis_used_memory_bytes', 'gauge', 'Estimated dataset memory.', [
    ['', server.usedMemory],
  ]);
  family(
    out,
    'miniredis_keys',
    'gauge',
    'Keys per database.',
    server.dbs.filter((db) => db.size > 0).map((db) => [`{db="${db.id}"}`, db.size]),
  );
  family(out, 'miniredis_replication_offset', 'gauge', 'Replication offset.', [
    ['', server.repl.masterReplOffset],
  ]);
  family(out, 'miniredis_connected_replicas', 'gauge', 'Connected replicas.', [
    ['', server.repl.replicas.size],
  ]);
  family(out, 'miniredis_last_save_timestamp_seconds', 'gauge', 'Unix time of the last save.', [
    ['', server.lastSave],
  ]);
  family(out, 'miniredis_aof_last_write_ok', 'gauge', '1 if the last AOF write succeeded.', [
    ['', (server.aof?.error ?? null) === null ? 1 : 0],
  ]);
  return out.join('\n') + '\n';
}

export class MetricsServer {
  private readonly http: http.Server;

  constructor(server: Server) {
    this.http = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.split('?')[0] === '/metrics') {
        const body = renderMetrics(server);
        res.writeHead(200, {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found\n');
      }
    });
  }

  start(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen({ port, host }, () => {
        this.http.off('error', reject);
        resolve();
      });
    });
  }

  stop(): void {
    this.http.close();
    this.http.closeAllConnections();
  }
}
