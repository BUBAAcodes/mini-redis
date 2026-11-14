/**
 * The INFO text (spec 13.1): `# Section` headers, `field:value` lines, sections separated by a
 * blank line.
 *
 * Key design choice: each section is a function from the Server to its fields, listed in
 * Redis's order, so `INFO a b` and `INFO all` share one code path and print sections in the
 * same order whatever order they were asked for. `loading:0` is how ioredis knows the server is
 * ready. A few fields cost a little to compute (avg_ttl samples the expires dict), so they are
 * evaluated only when their section is asked for.
 *
 * Mirrors Redis server.c (genRedisInfoString, infoCommand).
 */
import { arch, platform, release } from 'node:os';
import type { Server } from '../server/server.js';
import { MINIREDIS_VERSION, REDIS_VERSION } from '../server/version.js';

type Fields = Array<[string, string | number]>;

/** Redis's bytesToHuman: `1023B`, `1.00K`, `4.02M`, `3.00G` … */
export function bytesToHuman(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ['K', 'M', 'G', 'T', 'P'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(2)}${units[unit]}`;
}

const SECTIONS: ReadonlyArray<
  readonly [name: string, title: string, fields: (s: Server) => Fields]
> = [
  [
    'server',
    'Server',
    (s) => [
      ['redis_version', REDIS_VERSION],
      ['miniredis_version', MINIREDIS_VERSION],
      ['redis_mode', 'standalone'],
      ['os', `${platform()} ${release()} ${arch()}`],
      ['arch_bits', arch().includes('64') || arch() === 's390x' ? 64 : 32],
      ['process_id', process.pid],
      ['run_id', s.runId],
      ['tcp_port', s.port],
      ['uptime_in_seconds', Math.floor((Date.now() - s.startTime) / 1000)],
      ['uptime_in_days', Math.floor((Date.now() - s.startTime) / 86_400_000)],
      ['hz', s.config.get('hz')],
      ['executable', process.argv[1] ?? ''],
      ['config_file', s.config.file],
      ['node_version', process.versions.node],
    ],
  ],
  [
    'clients',
    'Clients',
    (s) => {
      let blocked = 0;
      for (const c of s.clients.values()) if (c.blocked) blocked++;
      return [
        ['connected_clients', s.clients.size],
        ['blocked_clients', blocked],
        ['maxclients', s.config.get('maxclients')],
      ];
    },
  ],
  [
    'memory',
    'Memory',
    (s) => {
      s.updatePeakMemory();
      const used = s.usedMemory;
      const max = s.config.get('maxmemory');
      return [
        // The estimate (spec 10.5), which `maxmemory` is enforced against; RSS is the real cost.
        ['used_memory', used],
        ['used_memory_human', bytesToHuman(used)],
        ['used_memory_rss', process.memoryUsage.rss()],
        ['used_memory_peak', s.peakMemory],
        ['maxmemory', max],
        ['maxmemory_human', bytesToHuman(max)],
        ['maxmemory_policy', s.config.get('maxmemory-policy')],
      ];
    },
  ],
  [
    'persistence',
    'Persistence',
    (s) => [
      ['loading', 0],
      ['rdb_changes_since_last_save', s.dirty],
      // A full sync is a BGSAVE to Redis too (its fork writes an RDB).
      [
        'rdb_bgsave_in_progress',
        s.snapshotJob !== null && s.snapshotJob.kind !== 'rewrite' ? 1 : 0,
      ],
      ['rdb_last_save_time', s.lastSave],
      ['rdb_last_bgsave_status', s.lastBgsaveStatus],
      ['aof_enabled', s.aofState === 'off' ? 0 : 1],
      ['aof_rewrite_in_progress', s.snapshotJob?.kind === 'rewrite' ? 1 : 0],
      ['aof_rewrite_scheduled', s.aofRewriteScheduled ? 1 : 0],
      ['aof_last_bgrewrite_status', s.aofLastRewriteStatus],
      ['aof_last_write_status', (s.aof?.error ?? null) === null ? 'ok' : 'err'],
      ['aof_rewrites', s.aofRewrites],
      // Only while an AOF is open, as Redis prints them only with the AOF on.
      ...((s.aof === null
        ? []
        : [
            ['aof_current_size', s.aof.size],
            ['aof_base_size', s.aof.baseSize],
          ]) satisfies Fields),
    ],
  ],
  [
    'stats',
    'Stats',
    (s) => [
      ['total_connections_received', s.stats.totalConnectionsReceived],
      ['total_commands_processed', s.stats.totalCommandsProcessed],
      ['instantaneous_ops_per_sec', s.instantaneousOps],
      ['rejected_connections', s.stats.rejectedConnections],
      ['sync_full', s.stats.syncFull],
      ['sync_partial_ok', s.stats.syncPartialOk],
      ['sync_partial_err', s.stats.syncPartialErr],
      ['expired_keys', s.stats.expiredKeys],
      ['evicted_keys', s.stats.evictedKeys],
      ['keyspace_hits', s.stats.keyspaceHits],
      ['keyspace_misses', s.stats.keyspaceMisses],
      ['pubsub_channels', s.pubsub.numChannels()],
      ['pubsub_patterns', s.pubsub.numPat()],
    ],
  ],
  ['replication', 'Replication', (s) => s.repl.infoFields()],
  [
    'cpu',
    'CPU',
    () => {
      // process.cpuUsage() is in microseconds.
      const usage = process.cpuUsage();
      return [
        ['used_cpu_sys', (usage.system / 1e6).toFixed(6)],
        ['used_cpu_user', (usage.user / 1e6).toFixed(6)],
      ];
    },
  ],
  [
    'keyspace',
    'Keyspace',
    (s) => {
      const now = Date.now();
      const fields: Fields = [];
      for (const db of s.dbs) {
        if (db.size === 0) continue;
        // Like Redis, the average TTL is an estimate from a sample of the keys that expire.
        const sample = db.expires.randomEntries(20);
        const avgTtl =
          sample.length === 0
            ? 0
            : Math.round(
                sample.reduce((sum, [, at]) => sum + Math.max(0, at - now), 0) / sample.length,
              );
        fields.push([`db${db.id}`, `keys=${db.size},expires=${db.expires.size},avg_ttl=${avgTtl}`]);
      }
      return fields;
    },
  ],
];

/** Words that select every section; Redis's `default` set equals `all` until we have more. */
const ALL = new Set(['all', 'everything', 'default']);

/** INFO's text for the requested sections (none = all). Unknown names are ignored. */
export function genInfoString(server: Server, requested: readonly string[]): string {
  const wanted = new Set(requested.map((r) => r.toLowerCase()));
  const all = wanted.size === 0 || [...wanted].some((w) => ALL.has(w));
  const parts: string[] = [];
  for (const [name, title, fields] of SECTIONS) {
    if (!all && !wanted.has(name)) continue;
    let text = `# ${title}\r\n`;
    for (const [field, value] of fields(server)) text += `${field}:${value}\r\n`;
    parts.push(text);
  }
  return parts.join('\r\n');
}
