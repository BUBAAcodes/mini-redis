import { describe, expect, it } from 'vitest';
import {
  INT64_MAX,
  INT64_MIN,
  clampToSafe,
  formatDouble,
  parseDouble,
  parseInt64,
} from '../../src/utils/numbers.js';

describe('parseInt64 (Redis string2ll)', () => {
  it('accepts plain integers and the int64 edges', () => {
    expect(parseInt64('0')).toBe(0n);
    expect(parseInt64('42')).toBe(42n);
    expect(parseInt64('-7')).toBe(-7n);
    expect(parseInt64('9223372036854775807')).toBe(INT64_MAX);
    expect(parseInt64('-9223372036854775808')).toBe(INT64_MIN);
  });

  it('rejects everything Redis rejects', () => {
    for (const bad of [
      '',
      '-',
      '+1',
      ' 1',
      '1 ',
      '-0',
      '007',
      '00',
      '1.0',
      '1e3',
      '0x10',
      'abc',
      '9223372036854775808',
      '-9223372036854775809',
      '99999999999999999999',
    ]) {
      expect(parseInt64(bad), bad).toBeNull();
    }
  });
});

describe('parseDouble (Redis string2d)', () => {
  it('accepts decimals, exponents and any-case infinities', () => {
    expect(parseDouble('1.5')).toBe(1.5);
    expect(parseDouble('-2')).toBe(-2);
    expect(parseDouble('+3')).toBe(3);
    expect(parseDouble('1e3')).toBe(1000);
    expect(parseDouble('.5')).toBe(0.5);
    expect(parseDouble('inf')).toBe(Infinity);
    expect(parseDouble('+INF')).toBe(Infinity);
    expect(parseDouble('-Inf')).toBe(-Infinity);
  });

  it('rejects nan, empty, spaces and junk', () => {
    for (const bad of ['', 'nan', 'NaN', ' 1', '1 ', '1x', '0x10', 'infinity', '--1', '1e', '.']) {
      expect(parseDouble(bad), bad).toBeNull();
    }
  });
});

describe('formatDouble', () => {
  it('prints the shortest round-trip form without exponents', () => {
    expect(formatDouble(1)).toBe('1');
    expect(formatDouble(-0.25)).toBe('-0.25');
    expect(formatDouble(3.5)).toBe('3.5');
    expect(formatDouble(1e21)).toBe('1000000000000000000000');
    expect(formatDouble(1e-7)).toBe('0.0000001');
    expect(formatDouble(Infinity)).toBe('inf');
    expect(formatDouble(-Infinity)).toBe('-inf');
  });
});

describe('clampToSafe', () => {
  it('clamps any int64 into the safe JS integer range', () => {
    expect(clampToSafe(5n)).toBe(5);
    expect(clampToSafe(-5n)).toBe(-5);
    expect(clampToSafe(INT64_MAX)).toBe(Number.MAX_SAFE_INTEGER);
    expect(clampToSafe(INT64_MIN)).toBe(Number.MIN_SAFE_INTEGER);
  });
});
