import { describe, expect, it } from 'vitest';
import { INT64_MAX, INT64_MIN, parseInt64 } from '../../src/utils/numbers.js';

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
