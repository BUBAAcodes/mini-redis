/**
 * SLOWLOG (spec 13.2): the most recent commands that took at least `slowlog-log-slower-than`
 * microseconds, newest first when read.
 *
 * Key design choice: an entry keeps a trimmed copy of the arguments (at most 32, each cut at
 * 128 bytes), made when the entry is pushed, so one huge SET can't pin its value in the log.
 * AUTH and HELLO arguments are already redacted by the caller. The id counts up for the life of
 * the process, so SLOWLOG RESET doesn't reuse ids.
 *
 * Mirrors Redis slowlog.c (slowlogCreateEntry, slowlogPushEntryIfNeeded, slowlogCommand).
 */

/** At most this many arguments are kept, the last of them being the "N more" note. */
const MAX_ARGS = 32;
/** Each argument is cut at this many bytes. */
const MAX_ARG_BYTES = 128;

export interface SlowLogEntry {
  readonly id: number;
  /** Unix seconds when the command started. */
  readonly time: number;
  /** How long it ran, in microseconds. */
  readonly usec: number;
  readonly argv: readonly string[];
  readonly addr: string;
  readonly name: string;
}

export function trimArgs(argv: readonly string[]): string[] {
  const kept = Math.min(argv.length, MAX_ARGS);
  const out: string[] = [];
  for (let i = 0; i < kept; i++) {
    if (kept !== argv.length && i === kept - 1) {
      out.push(`... (${argv.length - kept + 1} more arguments)`);
    } else {
      const arg = argv[i]!;
      out.push(
        arg.length > MAX_ARG_BYTES
          ? `${arg.slice(0, MAX_ARG_BYTES)}... (${arg.length - MAX_ARG_BYTES} more bytes)`
          : arg,
      );
    }
  }
  return out;
}

export class SlowLog {
  /** Oldest first, so a push is an append and trimming drops from the front. */
  private entries: SlowLogEntry[] = [];
  private nextId = 0;

  get length(): number {
    return this.entries.length;
  }

  /** Logs the command if it ran for `thresholdUsec` or more; a negative threshold logs nothing. */
  pushIfNeeded(
    thresholdUsec: number,
    maxLen: number,
    usec: number,
    startMs: number,
    argv: readonly string[],
    addr: string,
    name: string,
  ): void {
    if (thresholdUsec < 0 || usec < thresholdUsec) return;
    this.entries.push({
      id: this.nextId++,
      time: Math.floor(startMs / 1000),
      usec: Math.round(usec),
      argv: trimArgs(argv),
      addr,
      name,
    });
    if (this.entries.length > maxLen) this.entries.splice(0, this.entries.length - maxLen);
  }

  /** The newest `count` entries (all of them for count < 0), newest first. */
  newest(count: number): SlowLogEntry[] {
    const n = count < 0 ? this.entries.length : Math.min(count, this.entries.length);
    return this.entries.slice(this.entries.length - n).reverse();
  }

  reset(): void {
    this.entries = [];
  }
}
