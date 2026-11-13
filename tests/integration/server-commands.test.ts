import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RespError, TestClient } from '../helpers/resp-client.js';
import type { RespValue } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer;
let c: TestClient;

beforeAll(async () => {
  t = await startServer();
  c = await TestClient.connect(t.port);
});

afterAll(async () => {
  c.socket.destroy();
  await t.close();
});

describe('COMMAND', () => {
  it('COUNT is the size of the table, and COMMAND lists every entry', async () => {
    const count = await c.call('COMMAND', 'COUNT');
    expect(count).toBe(t.server.commands.size);
    const all = (await c.call('COMMAND')) as RespValue[][];
    expect(all).toHaveLength(count as number);
    expect(all.map((e) => e[0]).sort()).toEqual([...t.server.commands.keys()].sort());
  });

  it("INFO builds Redis 7's 10-item entries", async () => {
    expect(await c.call('COMMAND', 'INFO', 'get')).toEqual([
      [
        'get',
        2,
        ['readonly'],
        1,
        1,
        1,
        ['@read'],
        [],
        [
          [
            'flags',
            ['RO', 'access'],
            'begin_search',
            ['type', 'index', 'spec', ['index', 1]],
            'find_keys',
            ['type', 'range', 'spec', ['lastkey', 0, 'keystep', 1, 'limit', 0]],
          ],
        ],
        [],
      ],
    ]);
  });

  it('INFO covers multi-key commands, subcommands and unknown names', async () => {
    const [del, nosuch, configGet] = (await c.call(
      'COMMAND',
      'INFO',
      'DEL',
      'nosuch',
      'config|get',
    )) as RespValue[][];
    expect(del!.slice(0, 7)).toEqual(['del', -2, ['write'], 1, -1, 1, ['@write']]);
    const findKeys = (del![8] as RespValue[][])[0]![5] as RespValue[];
    expect(findKeys[3]).toEqual(['lastkey', -1, 'keystep', 1, 'limit', 0]);
    expect(nosuch).toBeNull();
    expect(configGet!.slice(0, 3)).toEqual(['config|get', -3, ['admin', 'stale']]);
    const config = ((await c.call('COMMAND', 'INFO', 'config')) as RespValue[][])[0]!;
    expect((config[9] as RespValue[][]).map((s) => s[0])).toEqual([
      'config|get',
      'config|set',
      'config|resetstat',
      'config|help',
    ]);
  });

  it('DOCS is an error, so redis-cli falls back to its built-in help', async () => {
    expect(await c.raw('COMMAND', 'DOCS')).toBe(
      "-ERR unknown subcommand 'DOCS'. Try COMMAND HELP.\r\n",
    );
    expect(await c.raw('COMMAND', 'COUNT', 'x')).toBe(
      "-ERR wrong number of arguments for 'command|count' command\r\n",
    );
  });
});

describe('CONFIG', () => {
  it('GET replies with a flat array of pairs in RESP2', async () => {
    expect(await c.raw('CONFIG', 'GET', 'PORT')).toBe(`*2\r\n$4\r\nPORT\r\n$1\r\n0\r\n`);
    expect(await c.call('CONFIG', 'GET', 'maxmemory-p*', 'nosuch')).toEqual([
      'maxmemory-policy',
      'noeviction',
    ]);
    expect(await c.raw('CONFIG', 'GET', 'nosuch')).toBe('*0\r\n');
  });

  it('SET changes values and reports Redis errors', async () => {
    expect(await c.raw('CONFIG', 'SET', 'maxmemory', '1kb', 'timeout', '7')).toBe('+OK\r\n');
    expect(await c.call('CONFIG', 'GET', 'maxmemory', 'timeout')).toEqual([
      'maxmemory',
      '1024',
      'timeout',
      '7',
    ]);
    expect(await c.raw('CONFIG', 'SET', 'port', '1')).toBe(
      "-ERR CONFIG SET failed (possibly related to argument 'port') - can't set immutable config\r\n",
    );
    expect(await c.raw('CONFIG', 'SET', 'hz')).toBe(
      "-ERR wrong number of arguments for 'config|set' command\r\n",
    );
    await c.call('CONFIG', 'SET', 'maxmemory', '0', 'timeout', '0');
  });

  it('SET hz re-arms serverCron at the new rate', async () => {
    const before = t.server.cron.ticks;
    await c.call('CONFIG', 'SET', 'hz', '100');
    expect(t.server.cron.interval).toBe(10);
    await new Promise((r) => setTimeout(r, 150));
    expect(t.server.cron.ticks - before).toBeGreaterThan(5);
    await c.call('CONFIG', 'SET', 'hz', '10');
  });

  it('RESETSTAT clears the stats', async () => {
    await c.call('PING');
    expect(t.server.stats.totalCommandsProcessed).toBeGreaterThan(0);
    expect(await c.raw('CONFIG', 'RESETSTAT')).toBe('+OK\r\n');
    // RESETSTAT itself is counted after the reset, as in Redis.
    expect(t.server.stats.totalCommandsProcessed).toBe(1);
  });

  it('HELP and unknown subcommands', async () => {
    const help = (await c.call('CONFIG', 'HELP')) as string[];
    expect(help[0]).toBe('CONFIG <subcommand> [<arg> [value] [opt] ...]. Subcommands are:');
    expect(help).toContain('RESETSTAT');
    expect(await c.raw('CONFIG', 'nope')).toBe(
      "-ERR unknown subcommand 'nope'. Try CONFIG HELP.\r\n",
    );
    expect(await c.raw('CONFIG')).toBe("-ERR wrong number of arguments for 'config' command\r\n");
  });
});

describe('TIME', () => {
  it('replies with seconds and microseconds as bulk strings', async () => {
    const before = Date.now();
    const [sec, usec] = (await c.call('TIME')) as [string, string];
    expect(sec).toMatch(/^\d+$/);
    expect(usec).toMatch(/^\d{1,6}$/);
    const ms = Number(sec) * 1000 + Number(usec) / 1000;
    expect(Math.abs(ms - before)).toBeLessThan(1000);
    expect(await c.raw('TIME', 'x')).toBe("-ERR wrong number of arguments for 'time' command\r\n");
  });
});

describe('INFO', () => {
  it('has the step 5 fields, in Redis format', async () => {
    const info = (await c.call('INFO')) as string;
    expect(info).toMatch(/^# Server\r\n/);
    expect(info).toContain('\r\nredis_version:7.4.0\r\n');
    expect(info).toContain('\r\nminiredis_version:0.1.0\r\n');
    expect(info).toContain(`\r\nrun_id:${t.server.runId}\r\n`);
    expect(info).toMatch(/\r\nrun_id:[0-9a-f]{40}\r\n/);
    expect(info).toContain(`\r\ntcp_port:${t.port}\r\n`);
    expect(info).toMatch(/\r\nuptime_in_seconds:\d+\r\n/);
    expect(info).toContain('\r\n\r\n# Persistence\r\nloading:0\r\n');
    expect(info.endsWith('loading:0\r\n')).toBe(true);
  });

  it('selects sections, case-insensitively, in Redis order', async () => {
    const persistence = (await c.call('INFO', 'PERSISTENCE')) as string;
    expect(persistence).toBe('# Persistence\r\nloading:0\r\n');
    const both = (await c.call('INFO', 'persistence', 'server')) as string;
    expect(both.indexOf('# Server')).toBeLessThan(both.indexOf('# Persistence'));
    expect(await c.raw('INFO', 'nosuch')).toBe('$0\r\n\r\n');
    expect(await c.call('INFO', 'everything')).toEqual(await c.call('INFO'));
  });

  it('works for a raw error check too', async () => {
    expect(await c.call('INFO', 'server', 'x')).not.toBeInstanceOf(RespError);
  });
});
