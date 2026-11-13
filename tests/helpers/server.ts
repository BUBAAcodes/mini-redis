// Starts a MiniRedis server in this process on port 0 with a fresh temp dir, and captures its
// log lines instead of printing them.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Config } from '../../src/config.js';
import { Server } from '../../src/server/server.js';

export interface TestServer {
  server: Server;
  port: number;
  dir: string;
  logs: string[];
  close(): Promise<void>;
}

/** `directives` override the defaults, written as in a config file: `{ hz: '50' }`. */
export async function startServer(
  directives: Record<string, string> = {},
  seed?: number,
): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), 'miniredis-test-'));
  const config = Config.fromDirectives(
    Object.entries({ port: '0', dir, ...directives }).map(([name, value]) => ({
      args: [name, value],
      where: 'in a test',
      line: `${name} ${value}`,
    })),
  );
  const logs: string[] = [];
  const server = new Server({ config, log: (line) => logs.push(line), seed });
  await server.start();
  return {
    server,
    port: server.port,
    dir,
    logs,
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
