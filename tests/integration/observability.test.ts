// Step 23: full INFO, SLOWLOG, MONITOR, CLIENT LIST/INFO, /metrics, SHUTDOWN (spec 9.14, 13).
import http from 'node:http';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RespError, TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.socket.destroy();
  await t?.close();
  t = null;
});
const start = async (d: Record<string, string> = {}, exit?: (code: number) => void) => {
  t = await startServer(d, undefined, exit ? { exit } : {});
  return t;
};
const connect = async (): Promise<TestClient> => {
  const c = await TestClient.connect(t!.port);
  clients.push(c);
  return c;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const infoFields = (text: string): Map<string, string> =>
  new Map(
    text
      .split('\r\n')
      .filter((l) => l.includes(':'))
      .map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]),
  );

describe('INFO', () => {
  it('has every section and field of spec 13.1', async () => {
    await start();
    const c = await connect();
    await c.call('SET', 'a', '1');
    await c.call('SET', 'b', '1', 'EX', '100');
    const text = (await c.call('INFO')) as string;
    const sections = text.split('\r\n').filter((l) => l.startsWith('# '));
    expect(sections).toEqual([
      '# Server',
      '# Clients',
      '# Memory',
      '# Persistence',
      '# Stats',
      '# Replication',
      '# CPU',
      '# Keyspace',
    ]);
    const f = infoFields(text);
    for (const name of [
      'redis_version',
      'miniredis_version',
      'redis_mode',
      'os',
      'arch_bits',
      'process_id',
      'run_id',
      'tcp_port',
      'uptime_in_seconds',
      'uptime_in_days',
      'hz',
      'executable',
      'config_file',
      'node_version',
      'connected_clients',
      'blocked_clients',
      'maxclients',
      'used_memory',
      'used_memory_human',
      'used_memory_rss',
      'used_memory_peak',
      'maxmemory',
      'maxmemory_human',
      'maxmemory_policy',
      'loading',
      'rdb_changes_since_last_save',
      'rdb_bgsave_in_progress',
      'rdb_last_save_time',
      'rdb_last_bgsave_status',
      'aof_enabled',
      'aof_rewrite_in_progress',
      'aof_rewrite_scheduled',
      'aof_last_bgrewrite_status',
      'aof_last_write_status',
      'total_connections_received',
      'total_commands_processed',
      'instantaneous_ops_per_sec',
      'rejected_connections',
      'expired_keys',
      'evicted_keys',
      'keyspace_hits',
      'keyspace_misses',
      'pubsub_channels',
      'pubsub_patterns',
      'sync_full',
      'sync_partial_ok',
      'sync_partial_err',
      'role',
      'connected_slaves',
      'master_replid',
      'master_repl_offset',
      'used_cpu_sys',
      'used_cpu_user',
    ]) {
      expect(f.has(name), name).toBe(true);
    }
    expect(f.get('redis_mode')).toBe('standalone');
    expect(f.get('connected_clients')).toBe('1');
    expect(f.get('aof_last_write_status')).toBe('ok');
    expect(f.get('db0')).toMatch(/^keys=2,expires=1,avg_ttl=\d+$/);
  });

  it('INFO <section> returns only that section; empty dbs are left out', async () => {
    await start();
    const c = await connect();
    expect(await c.call('INFO', 'keyspace')).toBe('# Keyspace\r\n');
    const text = (await c.call('INFO', 'clients', 'cpu')) as string;
    expect(text.split('\r\n').filter((l) => l.startsWith('# '))).toEqual(['# Clients', '# CPU']);
  });

  it('counts pubsub channels and patterns and blocked clients', async () => {
    await start();
    const sub = await connect();
    sub.send('SUBSCRIBE', 'x', 'y');
    await sub.read();
    await sub.read();
    sub.send('PSUBSCRIBE', 'p*');
    await sub.read();
    const blocked = await connect();
    blocked.send('BLPOP', 'nolist', '0');
    await sleep(30);
    const c = await connect();
    const f = infoFields((await c.call('INFO')) as string);
    expect(f.get('pubsub_channels')).toBe('2');
    expect(f.get('pubsub_patterns')).toBe('1');
    expect(f.get('blocked_clients')).toBe('1');
  });
});

describe('SLOWLOG', () => {
  it('records a slow command with the entry shape of spec 13.2', async () => {
    await start({ 'slowlog-log-slower-than': '10000' });
    const c = await connect();
    await c.call('CLIENT', 'SETNAME', 'worker');
    await c.call('DEBUG', 'SLEEP', '0.02');
    expect(await c.call('SLOWLOG', 'LEN')).toBe(1);
    const [entry] = (await c.call('SLOWLOG', 'GET')) as unknown[][];
    expect(entry![0]).toBe(0);
    expect(entry![1]).toBeGreaterThan(1_700_000_000);
    expect(entry![2]).toBeGreaterThanOrEqual(20000);
    expect(entry![3]).toEqual(['DEBUG', 'SLEEP', '0.02']);
    expect(entry![4]).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(entry![5]).toBe('worker');
  });

  it('ids count up, newest first; GET n limits; RESET empties; max-len trims', async () => {
    await start({ 'slowlog-log-slower-than': '0', 'slowlog-max-len': '3' });
    const c = await connect();
    for (let i = 0; i < 5; i++) await c.call('SET', `k${i}`, 'v');
    const all = (await c.call('SLOWLOG', 'GET')) as unknown[][];
    // The log keeps 3; the SLOWLOG GET above isn't in its own reply yet.
    expect(all.map((e) => e[0])).toEqual([4, 3, 2]);
    expect(((await c.call('SLOWLOG', 'GET', '1')) as unknown[][]).length).toBe(1);
    expect(await c.call('SLOWLOG', 'RESET')).toBe('OK');
    // RESET itself is logged after it runs, as in Redis; ids keep counting.
    const after = (await c.call('SLOWLOG', 'GET')) as unknown[][];
    expect(after.length).toBe(1);
    expect(after[0]![0]).toBe(7);
  });

  it('-1 disables it; arguments are capped at 32 and 128 bytes', async () => {
    await start({ 'slowlog-log-slower-than': '-1' });
    const c = await connect();
    await c.call('SET', 'a', 'b');
    expect(await c.call('SLOWLOG', 'LEN')).toBe(0);
    await c.call('CONFIG', 'SET', 'slowlog-log-slower-than', '0');
    await c.call('SLOWLOG', 'RESET');
    await c.call('RPUSH', 'l', ...Array.from({ length: 40 }, (_, i) => String(i)));
    await c.call('SET', 'big', 'x'.repeat(200));
    const [bigE, pushE] = (await c.call('SLOWLOG', 'GET', '3')) as unknown[][];
    const pushArgs = pushE![3] as string[];
    expect(pushArgs.length).toBe(32);
    expect(pushArgs[31]).toBe('... (11 more arguments)');
    const bigArgs = bigE![3] as string[];
    expect(bigArgs[2]).toBe('x'.repeat(128) + '... (72 more bytes)');
  });

  it('HELP and errors', async () => {
    await start();
    const c = await connect();
    expect(((await c.call('SLOWLOG', 'HELP')) as string[])[0]).toMatch(/^SLOWLOG <subcommand>/);
    expect(await c.call('SLOWLOG', 'GET', 'x')).toBeInstanceOf(RespError);
    expect(await c.call('SLOWLOG', 'NOPE')).toBeInstanceOf(RespError);
  });
});

describe('MONITOR', () => {
  it('shows other clients commands, redacts AUTH and HELLO, hides admin commands', async () => {
    await start();
    const mon = await connect();
    expect(await mon.call('MONITOR')).toBe('OK');
    const c = await connect();
    await c.call('SELECT', '3');
    await c.call('SET', 'user:1', 'al"ice\n');
    await c.call('AUTH', 'secret');
    await c.call('HELLO', '2', 'AUTH', 'default', 'secret');
    await c.call('CONFIG', 'GET', 'hz');
    await c.call('GET', 'user:1');
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) lines.push((await mon.read()) as string);
    expect(lines[0]).toMatch(/^\d+\.\d{6} \[3 127\.0\.0\.1:\d+\] "SELECT" "3"$/);
    expect(lines[1]).toMatch(/^\d+\.\d{6} \[3 127\.0\.0\.1:\d+\] "SET" "user:1" "al\\"ice\\n"$/);
    expect(lines[2]).toMatch(/\] "AUTH" "\(redacted\)"$/);
    expect(lines[3]).toMatch(/\] "HELLO" "2" "AUTH" "\(redacted\)" "\(redacted\)"$/);
    // CONFIG is admin: skipped, so the next line is the GET.
    expect(lines[4]).toMatch(/\] "GET" "user:1"$/);
  });

  it('is not idle-closed and stays in the monitor flow inside EXEC', async () => {
    await start({ timeout: '1' });
    const mon = await connect();
    await mon.call('MONITOR');
    const c = await connect();
    await c.call('MULTI');
    await c.call('SET', 'a', '1');
    const exec = c.call('EXEC');
    await exec;
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) seen.push((await mon.read()) as string);
    expect(seen[0]).toMatch(/"MULTI"$/);
    expect(seen[1]).toMatch(/"SET" "a" "1"$/);
    expect(seen[2]).toMatch(/"EXEC"$/);
    await sleep(2300);
    expect(mon.socket.destroyed).toBe(false);
  });
});

describe('CLIENT LIST and CLIENT INFO', () => {
  it('prints every field of spec 13.4', async () => {
    await start();
    const c = await connect();
    await c.call('CLIENT', 'SETNAME', 'me');
    const info = (await c.call('CLIENT', 'INFO')) as string;
    expect(info.endsWith('\n')).toBe(true);
    const f = Object.fromEntries(
      info
        .trim()
        .split(' ')
        .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]),
    );
    expect(Object.keys(f)).toEqual([
      'id',
      'addr',
      'laddr',
      'name',
      'age',
      'idle',
      'flags',
      'db',
      'sub',
      'psub',
      'multi',
      'qbuf',
      'omem',
      'cmd',
      'resp',
    ]);
    expect(f.name).toBe('me');
    expect(f.flags).toBe('N');
    expect(f.db).toBe('0');
    expect(f.multi).toBe('-1');
    expect(f.cmd).toBe('client|info');
    expect(f.resp).toBe('2');
  });

  it('lists every client, with flags for subscribers, multi and RESP3', async () => {
    await start();
    const a = await connect();
    const b = await connect();
    await b.call('HELLO', '3');
    await b.call('MULTI');
    await b.call('SET', 'k', 'v');
    const list = (await a.call('CLIENT', 'LIST')) as string;
    const lines = list.trim().split('\n');
    expect(lines.length).toBe(2);
    const bl = lines.find((l) => l.includes('resp=3'))!;
    expect(bl).toMatch(/flags=x /);
    expect(bl).toMatch(/multi=1 /);
    expect(await a.call('CLIENT', 'LIST', 'ID', '1', '99')).toContain('id=1 ');
    expect(await a.call('CLIENT', 'LIST', 'TYPE', 'pubsub')).toBe('');
  });
});

describe('/metrics', () => {
  it('serves the Prometheus metrics of spec 13.5', async () => {
    await start({ 'metrics-port': String(await freePort()) });
    const port = t!.server.config.get('metrics-port');
    const c = await connect();
    await c.call('SET', 'a', '1');
    await c.call('GET', 'a');
    await c.call('GET', 'nope');
    const { body } = await httpGet(port, '/metrics');
    for (const m of [
      'miniredis_connected_clients',
      'miniredis_blocked_clients',
      'miniredis_commands_processed_total',
      'miniredis_command_calls_total{cmd="get"} 2',
      'miniredis_command_duration_seconds_sum{cmd="get"}',
      'miniredis_keyspace_hits_total 1',
      'miniredis_keyspace_misses_total 1',
      'miniredis_expired_keys_total',
      'miniredis_evicted_keys_total',
      'miniredis_used_memory_bytes',
      'miniredis_keys{db="0"} 1',
      'miniredis_replication_offset',
      'miniredis_connected_replicas',
      'miniredis_last_save_timestamp_seconds',
      'miniredis_aof_last_write_ok 1',
    ]) {
      expect(body, m).toContain(m);
    }
    expect(body).toMatch(/# TYPE miniredis_commands_processed_total counter/);
    expect((await httpGet(port, '/nope')).status).toBe(404);
  });

  it('is off when metrics-port is 0', async () => {
    await start();
    expect(t!.server.config.get('metrics-port')).toBe(0);
  });
});

describe('SHUTDOWN', () => {
  it('saves when save points exist, closes the connection and exits 0', async () => {
    const codes: number[] = [];
    await start({ save: '900 1' }, (code) => codes.push(code));
    const c = await connect();
    await c.call('SET', 'a', '1');
    c.send('SHUTDOWN');
    await c.closed;
    await sleep(20);
    expect(codes).toEqual([0]);
    expect(existsSync(join(t!.dir, 'dump.mrdb'))).toBe(true);
    expect(t!.logs.join('\n')).toContain('MiniRedis is now ready to exit, bye bye...');
  });

  it('NOSAVE skips the save; SAVE forces it even with no save points', async () => {
    const codes: number[] = [];
    await start({ save: '' }, (code) => codes.push(code));
    const c = await connect();
    await c.call('SET', 'a', '1');
    c.send('SHUTDOWN', 'SAVE');
    await c.closed;
    expect(existsSync(join(t!.dir, 'dump.mrdb'))).toBe(true);
  });

  it('NOSAVE writes nothing', async () => {
    const codes: number[] = [];
    await start({ save: '900 1' }, (code) => codes.push(code));
    const c = await connect();
    await c.call('SET', 'a', '1');
    c.send('SHUTDOWN', 'NOSAVE');
    await c.closed;
    expect(existsSync(join(t!.dir, 'dump.mrdb'))).toBe(false);
  });

  it('with no save points a plain SHUTDOWN writes no snapshot; bad flags are syntax errors', async () => {
    const codes: number[] = [];
    await start({ save: '' }, (code) => codes.push(code));
    const c = await connect();
    expect(await c.call('SHUTDOWN', 'NOSAVE', 'SAVE')).toBeInstanceOf(RespError);
    expect(await c.call('SHUTDOWN', 'BOGUS')).toBeInstanceOf(RespError);
    expect(codes).toEqual([]);
    c.send('SHUTDOWN');
    await c.closed;
    expect(existsSync(join(t!.dir, 'dump.mrdb'))).toBe(false);
  });

  it('a failing save keeps the server up and replies with the error', async () => {
    const codes: number[] = [];
    await start({ save: '900 1' }, (code) => codes.push(code));
    const c = await connect();
    await c.call('SET', 'a', '1');
    // Make the snapshot unwritable: a directory sits where the file goes.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(t!.dir, 'dump.mrdb'));
    const reply = await c.call('SHUTDOWN');
    expect(reply).toEqual(new RespError('ERR Errors trying to SHUTDOWN. Check logs.'));
    expect(codes).toEqual([]);
    expect(await c.call('GET', 'a')).toBe('1');
  });
});

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (d: Buffer) => (body += d.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}
