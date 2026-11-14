/**
 * Entry point: `node dist/index.js [miniredis.conf] [--name value ...]`, like redis-server.
 * Reads the config file, applies flags on top, starts the server, and shuts down gracefully
 * on SIGTERM and SIGINT.
 *
 * Key design choice: everything that can fail before listening (an unreadable file, a bad
 * directive) is reported the way Redis reports it, as a FATAL CONFIG FILE ERROR naming the
 * line, and the process exits with code 1 instead of starting with a half-applied config.
 *
 * Mirrors Redis server.c (main) and config.c (loadServerConfig).
 */
import { readFileSync } from 'node:fs';
import { Config, ConfigError, parseArgv, parseConfigFile } from './config.js';
import type { DirectiveLine } from './config.js';
import { AofLoadError } from './persistence/aof.js';
import { SnapshotLoadError } from './persistence/snapshot-format.js';
import { Server } from './server/server.js';
import { MINIREDIS_VERSION } from './server/version.js';

function loadConfig(argv: readonly string[]): Config {
  const { configFile, directives } = parseArgv(argv);
  let lines: DirectiveLine[] = [];
  if (configFile !== null) {
    let text: string;
    try {
      text = readFileSync(configFile, 'latin1');
    } catch (e) {
      throw new ConfigError('opening the configuration file', configFile, (e as Error).message);
    }
    lines = parseConfigFile(text);
  }
  const config = Config.fromDirectives([...lines, ...directives]);
  config.file = configFile ?? '';
  return config;
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(
      `\n*** FATAL CONFIG FILE ERROR (MiniRedis ${MINIREDIS_VERSION}) ***\n` +
        `Reading the configuration file, ${e.where}\n>>> '${e.line}'\n${e.reason}\n`,
    );
    process.exit(1);
  }

  const server = new Server({ config });
  server.log.notice('oO0OoO0OoO0Oo MiniRedis is starting oO0OoO0OoO0Oo');
  server.log.notice(`MiniRedis version=${MINIREDIS_VERSION}, pid=${process.pid}, just started`);
  server.log.notice(
    config.file === ''
      ? 'Configuration loaded (no config file given; using the defaults and flags)'
      : 'Configuration loaded',
  );

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    server.log.warning(`Received ${signal} scheduling shutdown...`);
    server.log.warning('User requested shutdown...');
    server.close().then(
      () => {
        server.log.warning('MiniRedis is now ready to exit, bye bye...');
        process.exit(0);
      },
      (e: unknown) => {
        server.log.warning(`Error during shutdown: ${(e as Error).message}`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    await server.start();
  } catch (e) {
    // A damaged AOF or snapshot was already logged with its offset; never start empty over it
    // (spec 9.9).
    if (!(e instanceof AofLoadError || e instanceof SnapshotLoadError)) {
      const what =
        (e as NodeJS.ErrnoException).syscall === 'listen'
          ? `Failed listening on port ${config.get('port')}`
          : 'Fatal error at startup';
      server.log.warning(`${what}: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

await main();
