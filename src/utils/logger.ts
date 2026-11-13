/**
 * Redis-style log lines (spec 7.8): `<pid>:<role> <dd Mon yyyy HH:MM:SS.mmm> <level> <message>`.
 *
 * Key design choice: the level and role are read through callbacks on every line, so CONFIG SET
 * loglevel and a replica's promotion take effect at once without the logger holding server
 * state. Each server has its own Logger and output, so tests can capture or silence one server.
 *
 * Mirrors Redis server.c (serverLogRaw).
 */

export type LogLevel = 'debug' | 'verbose' | 'notice' | 'warning';
export type LogRole = 'M' | 'S';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'verbose', 'notice', 'warning'];

const MARKS: Record<LogLevel, string> = { debug: '.', verbose: '-', notice: '*', warning: '#' };
const RANK: Record<LogLevel, number> = { debug: 0, verbose: 1, notice: 2, warning: 3 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Local time, as Redis's strftime("%d %b %Y %H:%M:%S.") with milliseconds. */
export function formatLogLine(
  pid: number,
  role: LogRole,
  when: Date,
  level: LogLevel,
  message: string,
): string {
  const date =
    `${pad(when.getDate())} ${MONTHS[when.getMonth()]} ${when.getFullYear()} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}.` +
    pad(when.getMilliseconds(), 3);
  return `${pid}:${role} ${date} ${MARKS[level]} ${message}`;
}

export interface LoggerOptions {
  level: () => LogLevel;
  role: () => LogRole;
  /** Where finished lines go; stdout by default, as Redis with no logfile. */
  write?: (line: string) => void;
}

export class Logger {
  private readonly level: () => LogLevel;
  private readonly role: () => LogRole;
  private readonly write: (line: string) => void;

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.role = options.role;
    this.write = options.write ?? ((line) => process.stdout.write(line + '\n'));
  }

  log(level: LogLevel, message: string): void {
    if (RANK[level] < RANK[this.level()]) return;
    this.write(formatLogLine(process.pid, this.role(), new Date(), level, message));
  }

  debug(message: string): void {
    this.log('debug', message);
  }

  verbose(message: string): void {
    this.log('verbose', message);
  }

  notice(message: string): void {
    this.log('notice', message);
  }

  warning(message: string): void {
    this.log('warning', message);
  }
}
