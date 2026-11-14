/**
 * MONITOR (spec 13.3): every command another client runs, as one line, sent to each monitor.
 *
 * Key design choice: the line is built once per command and only when a monitor exists, from the
 * argv exactly as the client typed it, after the command ran (so a SELECT shows the db it
 * selected and an EXEC's commands appear before the EXEC, as in Redis 7). Admin commands are
 * never shown, and AUTH and HELLO ... AUTH credentials are replaced by "(redacted)" before
 * anything is formatted: the same redacted argv feeds SLOWLOG, so no log shows a password
 * (spec 12).
 *
 * Mirrors Redis replication.c (replicationFeedMonitors) and networking.c
 * (redactClientCommandArgument); sdscatrepr for the quoting.
 */
import type { CommandSpec } from '../commands/command.js';
import type { Client } from '../server/client.js';
import type { Server } from '../server/server.js';

const REDACTED = '(redacted)';

/** The argv with credentials replaced: AUTH's arguments, and HELLO's after its AUTH option. */
export function redactArgv(spec: CommandSpec, argv: readonly string[]): readonly string[] {
  if (spec.name === 'auth') return [argv[0]!, ...argv.slice(1).map(() => REDACTED)];
  if (spec.name === 'hello') {
    for (let i = 2; i < argv.length; i++) {
      if (argv[i]!.toLowerCase() === 'auth' && i + 2 < argv.length) {
        const out = [...argv];
        out[i + 1] = REDACTED;
        out[i + 2] = REDACTED;
        return out;
      }
    }
  }
  return argv;
}

/** Redis's sdscatrepr: double quotes, with escapes for everything but printable ASCII. */
export function repr(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x5c:
        out += '\\\\';
        break;
      case 0x22:
        out += '\\"';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0d:
        out += '\\r';
        break;
      case 0x09:
        out += '\\t';
        break;
      case 0x07:
        out += '\\a';
        break;
      case 0x08:
        out += '\\b';
        break;
      default:
        out += c >= 0x20 && c <= 0x7e ? s[i] : `\\x${c.toString(16).padStart(2, '0')}`;
    }
  }
  return out + '"';
}

/** Sends the command to every monitor. Call after the command ran, only for one that ran. */
export function feedMonitors(
  server: Server,
  client: Client,
  spec: CommandSpec,
  argv: readonly string[],
): void {
  if (server.monitors.size === 0 || spec.flags.includes('admin')) return;
  // Microsecond precision, from the monotonic clock anchored at process start.
  const when = Math.round((performance.timeOrigin + performance.now()) * 1000);
  const seconds = Math.floor(when / 1_000_000);
  const micros = String(when % 1_000_000).padStart(6, '0');
  const origin = client.addr;
  const line =
    `${seconds}.${micros} [${client.db} ${origin}] ` + redactArgv(spec, argv).map(repr).join(' ');
  for (const monitor of server.monitors) {
    if (monitor.closed) continue;
    monitor.reply.simple(line);
    server.queueReply(monitor);
  }
}
