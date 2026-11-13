// The real entry point in a child process: startup logging, a bad config, and SIGTERM.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestClient } from '../helpers/resp-client.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'miniredis-proc-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = (args: string[]) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const waitFor = async (re: RegExp): Promise<RegExpMatchArray> => {
    for (let i = 0; i < 200; i++) {
      const m = re.exec(out);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${re}; output:\n${out}`);
  };
  return { child, exited, waitFor, output: () => out };
};

describe('the miniredis process', () => {
  it('serves, then shuts down gracefully on SIGTERM', async () => {
    const conf = join(dir, 'test.conf');
    await writeFile(conf, '# port is overridden by the flag\nport 1\nhz 20\n');
    const p = run([conf, '--port', '0', '--dir', dir]);
    const [, port] = await p.waitFor(/Running mode=standalone, port=(\d+)\./);
    await p.waitFor(/Ready to accept connections tcp/);
    const c = await TestClient.connect(Number(port));
    expect(await c.call('SET', 'a', '1')).toBe('OK');
    expect(await c.call('CONFIG', 'GET', 'hz')).toEqual(['hz', '20']);
    p.child.kill('SIGTERM');
    expect(await p.exited).toBe(0);
    await c.closed;
    expect(p.output()).toMatch(
      /\d+:M \d\d \w{3} \d{4} [\d:.]+ # Received SIGTERM scheduling shutdown/,
    );
    expect(p.output()).toContain('MiniRedis is now ready to exit, bye bye...');
  });

  it('refuses to start with a bad directive, naming the line', async () => {
    const conf = join(dir, 'bad.conf');
    await writeFile(conf, 'port 0\nmaxmemory lots\n');
    const p = run([conf]);
    expect(await p.exited).toBe(1);
    expect(p.output()).toContain('*** FATAL CONFIG FILE ERROR');
    expect(p.output()).toContain('at line 2');
    expect(p.output()).toContain(">>> 'maxmemory lots'");
    expect(p.output()).toContain('argument must be a memory value');
  });
});
