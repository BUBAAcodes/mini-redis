/**
 * The INFO text (spec 13.1): `# Section` headers, `field:value` lines, sections separated by a
 * blank line.
 *
 * Key design choice: each section is a function from the Server to its fields, listed in
 * Redis's order, so `INFO a b` and `INFO all` share one code path and print sections in the
 * same order whatever order they were asked for. Step 5 has the fields ioredis and the tests
 * need (`loading:0` is how ioredis knows the server is ready); step 23 fills in the rest of
 * section 13.1.
 *
 * Mirrors Redis server.c (genRedisInfoString, infoCommand).
 */
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
      ['run_id', s.runId],
      ['tcp_port', s.port],
      ['uptime_in_seconds', Math.floor((Date.now() - s.startTime) / 1000)],
    ],
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
      ['rdb_bgsave_in_progress', s.snapshotJob?.kind === 'bgsave' ? 1 : 0],
      ['rdb_last_save_time', s.lastSave],
      ['rdb_last_bgsave_status', s.lastBgsaveStatus],
      ['aof_enabled', s.aofState === 'off' ? 0 : 1],
      ['aof_rewrite_in_progress', s.snapshotJob?.kind === 'rewrite' ? 1 : 0],
      ['aof_rewrite_scheduled', s.aofRewriteScheduled ? 1 : 0],
      ['aof_last_bgrewrite_status', s.aofLastRewriteStatus],
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
