import { describe, expect, it } from 'vitest';
import { Logger, formatLogLine } from '../../src/utils/logger.js';
import type { LogLevel } from '../../src/utils/logger.js';

describe('logger (spec 7.8)', () => {
  it("formats lines the way Redis's serverLog does", () => {
    const when = new Date(2026, 10, 12, 1, 5, 0, 123); // local time, as Redis prints it
    expect(formatLogLine(4120, 'M', when, 'notice', 'Ready to accept connections tcp')).toBe(
      '4120:M 12 Nov 2026 01:05:00.123 * Ready to accept connections tcp',
    );
    const early = new Date(2026, 0, 3, 9, 8, 7, 6);
    expect(formatLogLine(1, 'S', early, 'debug', 'x')).toBe('1:S 03 Jan 2026 09:08:07.006 . x');
    expect(formatLogLine(1, 'M', early, 'verbose', 'x')).toContain(' - x');
    expect(formatLogLine(1, 'M', early, 'warning', 'x')).toContain(' # x');
  });

  it('drops lines below the current level, read live', () => {
    const lines: string[] = [];
    let level: LogLevel = 'notice';
    const log = new Logger({
      level: () => level,
      role: () => 'M',
      write: (l) => lines.push(l),
    });
    log.debug('d');
    log.verbose('v');
    log.notice('n');
    log.warning('w');
    expect(lines.map((l) => l.slice(-1))).toEqual(['n', 'w']);
    level = 'debug';
    log.debug('d');
    expect(lines).toHaveLength(3);
  });
});
