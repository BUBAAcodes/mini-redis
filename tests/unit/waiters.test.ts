// Step 18: the pure parts of blocking/waiters.ts. Timeout parsing follows Redis's
// getTimeoutFromObjectOrReply (timeout.c); expected errors were checked against redis:7.4.
import { describe, expect, it } from 'vitest';
import { MAX_TIMER_MS, parseTimeout, timerDelay } from '../../src/blocking/waiters.js';
import { ReplyError } from '../../src/protocol/errors.js';

const NOW = 1_700_000_000_000;

function timeoutError(s: string): string {
  try {
    parseTimeout(s, NOW);
  } catch (e) {
    if (e instanceof ReplyError) return e.message;
    throw e;
  }
  throw new Error(`parseTimeout(${JSON.stringify(s)}) did not throw`);
}

describe('parseTimeout', () => {
  it('reads seconds, fractional or whole, as milliseconds', () => {
    expect(parseTimeout('1', NOW)).toBe(1000);
    expect(parseTimeout('0.1', NOW)).toBe(100);
    expect(parseTimeout('1.5', NOW)).toBe(1500);
    expect(parseTimeout('1e-3', NOW)).toBe(1);
    expect(parseTimeout('1e10', NOW)).toBe(1e13);
  });

  it('rounds up, so a tiny timeout still waits a millisecond', () => {
    expect(parseTimeout('0.0001', NOW)).toBe(1);
    expect(parseTimeout('0.0015', NOW)).toBe(2);
  });

  it('treats 0, -0 and a negative fraction that rounds up to 0 as forever', () => {
    expect(parseTimeout('0', NOW)).toBe(0);
    expect(parseTimeout('-0', NOW)).toBe(0);
    expect(parseTimeout('-0.0001', NOW)).toBe(0);
  });

  it('rejects text that is not a float', () => {
    for (const s of ['abc', '', ' 1', 'nan', '1x']) {
      expect(timeoutError(s)).toBe('ERR timeout is not a float or out of range');
    }
  });

  it('rejects negative timeouts', () => {
    expect(timeoutError('-1')).toBe('ERR timeout is negative');
    expect(timeoutError('-0.001')).toBe('ERR timeout is negative');
    expect(timeoutError('-inf')).toBe('ERR timeout is negative');
  });

  it('rejects timeouts whose milliseconds, or deadline, pass int64', () => {
    for (const s of ['inf', '1e20', '9223372036854775807', '9223372036854775.807']) {
      expect(timeoutError(s)).toBe('ERR timeout is out of range');
    }
  });
});

describe('timerDelay', () => {
  it('waits until the deadline', () => {
    expect(timerDelay(NOW + 100, NOW)).toBe(100);
  });

  it('never goes below 0 for a deadline already passed', () => {
    expect(timerDelay(NOW - 5, NOW)).toBe(0);
  });

  it("caps the wait at Node's largest timer, so a long timeout re-arms instead of firing at once", () => {
    expect(MAX_TIMER_MS).toBe(2 ** 31 - 1);
    expect(timerDelay(NOW + 2 ** 40, NOW)).toBe(MAX_TIMER_MS);
  });
});
