import { describe, expect, it } from 'vitest';
import { hasGlobChars, stringMatch } from '../../src/utils/glob.js';

describe('stringMatch (Redis stringmatchlen)', () => {
  it('matches literals, ? and *', () => {
    expect(stringMatch('hello', 'hello')).toBe(true);
    expect(stringMatch('hello', 'hellO')).toBe(false);
    expect(stringMatch('h?llo', 'hallo')).toBe(true);
    expect(stringMatch('h?llo', 'hllo')).toBe(false);
    expect(stringMatch('h*llo', 'hllo')).toBe(true);
    expect(stringMatch('h*llo', 'heeeello')).toBe(true);
    // stringmatchlen's loop never runs on an empty string, so even `*` fails; KEYS and SCAN
    // special-case a lone `*` before matching (checked on redis:7.4: KEYS ** skips the key "").
    expect(stringMatch('*', '')).toBe(false);
    expect(stringMatch('a**', 'a')).toBe(true);
    expect(stringMatch('', '')).toBe(true);
    expect(stringMatch('', 'a')).toBe(false);
    expect(stringMatch('a*b', 'ab')).toBe(true);
    expect(stringMatch('a*b', 'acbd')).toBe(false);
  });

  it('matches classes, negation and ranges', () => {
    expect(stringMatch('h[ae]llo', 'hello')).toBe(true);
    expect(stringMatch('h[ae]llo', 'hillo')).toBe(false);
    expect(stringMatch('h[^e]llo', 'hallo')).toBe(true);
    expect(stringMatch('h[^e]llo', 'hello')).toBe(false);
    expect(stringMatch('h[a-b]llo', 'hbllo')).toBe(true);
    expect(stringMatch('h[b-a]llo', 'hallo')).toBe(true); // reversed ranges are swapped
    expect(stringMatch('h[a-b]llo', 'hcllo')).toBe(false);
    expect(stringMatch('[\\]]', ']')).toBe(true);
    expect(stringMatch('[abc', 'c')).toBe(true); // an unclosed class ends at the pattern's end
  });

  it('handles escapes', () => {
    expect(stringMatch('h\\*llo', 'h*llo')).toBe(true);
    expect(stringMatch('h\\*llo', 'hello')).toBe(false);
    expect(stringMatch('\\?', '?')).toBe(true);
    expect(stringMatch('a\\', 'a\\')).toBe(true); // a trailing backslash is literal
  });

  it('ignores case on request (CONFIG GET)', () => {
    expect(stringMatch('MAX*', 'maxmemory', true)).toBe(true);
    expect(stringMatch('[M]ax?emory', 'maxmemory', true)).toBe(true);
    expect(stringMatch('[A-Z]', 'q', true)).toBe(true);
    expect(stringMatch('MAX*', 'maxmemory')).toBe(false);
  });

  it('compares bytes the way C compares signed chars in ranges', () => {
    // Redis's range uses plain (signed) char, so 0xff is -1 and [\x00-\xff] means [-1, 0].
    expect(stringMatch('[\x00-\xff]', 'A')).toBe(false);
    expect(stringMatch('[\x00-\xff]', '\x00')).toBe(true);
    expect(stringMatch('\xfe?', '\xfe\xff')).toBe(true);
  });

  it('gives up fast on a pathological pattern', () => {
    const s = 'a'.repeat(10_000);
    const start = performance.now();
    expect(stringMatch('*a*a*a*a*a*a*b', s)).toBe(false);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('knows which patterns are plain names', () => {
    expect(hasGlobChars('maxmemory')).toBe(false);
    expect(hasGlobChars('max*')).toBe(true);
    expect(hasGlobChars('p?rt')).toBe(true);
    expect(hasGlobChars('[p]ort')).toBe(true);
    expect(hasGlobChars('a\\b')).toBe(false); // config.c checks strpbrk(name, "[*?") only
  });
});
