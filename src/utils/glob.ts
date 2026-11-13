/**
 * Redis glob matching: `*`, `?`, `[abc]`, `[^a-z]` and `\` escapes, over byte strings. Used by
 * CONFIG GET now, and by KEYS, SCAN MATCH and PSUBSCRIBE later.
 *
 * Key design choice: a faithful port of stringmatchlen(), including its quirks (an unclosed `[`
 * runs to the end of the pattern; ranges compare signed C chars) and its skipLongerMatches cut:
 * once the rest of a pattern has failed against every suffix after a `*`, no earlier `*` can
 * help, so `*a*a*a*a*a*a*b` against 10,000 `a`s is O(n²) instead of exponential.
 *
 * Mirrors Redis util.c (stringmatchlen_impl).
 */

const STAR = 0x2a;
const QUESTION = 0x3f;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const BACKSLASH = 0x5c;
const CARET = 0x5e;
const DASH = 0x2d;

/** C's tolower() in the C locale: only A–Z change. */
const lower = (c: number): number => (c >= 0x41 && c <= 0x5a ? c + 32 : c);
/** Redis reads pattern bytes as plain `char`, which is signed on x86 and ARM Linux builds. */
const signed = (c: number): number => (c >= 128 ? c - 256 : c);

/** Abusive nesting gives up instead of overflowing the stack, as in Redis. */
const MAX_NESTING = 1000;

export function stringMatch(pattern: string, s: string, nocase = false): boolean {
  return matchFrom(pattern, 0, s, 0, nocase, { skipLonger: false }, 0);
}

/**
 * True when CONFIG GET must treat the argument as a pattern rather than a plain name. Like
 * config.c's strpbrk(name, "[*?"), a backslash alone doesn't make a pattern.
 */
export const hasGlobChars = (s: string): boolean => /[*?[]/.test(s);

function matchFrom(
  pattern: string,
  p: number,
  s: string,
  i: number,
  nocase: boolean,
  state: { skipLonger: boolean },
  nesting: number,
): boolean {
  if (nesting > MAX_NESTING) return false;
  const pEnd = pattern.length;
  const sEnd = s.length;
  // Past the end reads as 0, like the NUL terminator the C code relies on.
  const pc = (j: number): number => (j < pEnd ? pattern.charCodeAt(j) : 0);

  while (p < pEnd && i < sEnd) {
    const c = pattern.charCodeAt(p);
    if (c === STAR) {
      while (p + 1 < pEnd && pattern.charCodeAt(p + 1) === STAR) p++;
      if (p + 1 === pEnd) return true;
      while (i < sEnd) {
        if (matchFrom(pattern, p + 1, s, i, nocase, state, nesting + 1)) return true;
        if (state.skipLonger) return false;
        i++;
      }
      state.skipLonger = true;
      return false;
    } else if (c === QUESTION) {
      i++;
    } else if (c === LBRACKET) {
      p++;
      const not = pc(p) === CARET;
      if (not) p++;
      let match = false;
      const sc = s.charCodeAt(i);
      for (;;) {
        if (pc(p) === BACKSLASH && pEnd - p >= 2) {
          p++;
          if (pattern.charCodeAt(p) === sc) match = true;
        } else if (pc(p) === RBRACKET && p < pEnd) {
          break;
        } else if (p >= pEnd) {
          p--; // the shared p++ below lands back on the end
          break;
        } else if (pEnd - p >= 3 && pattern.charCodeAt(p + 1) === DASH) {
          let start = signed(pattern.charCodeAt(p));
          let end = signed(pattern.charCodeAt(p + 2));
          let ch = signed(sc);
          if (start > end) [start, end] = [end, start];
          if (nocase) {
            start = lower(start);
            end = lower(end);
            ch = lower(ch);
          }
          p += 2;
          if (ch >= start && ch <= end) match = true;
        } else if (
          nocase ? lower(pattern.charCodeAt(p)) === lower(sc) : pattern.charCodeAt(p) === sc
        ) {
          match = true;
        }
        p++;
      }
      if (not) match = !match;
      if (!match) return false;
      i++;
    } else {
      if (c === BACKSLASH && pEnd - p >= 2) p++;
      const pch = pattern.charCodeAt(p);
      const sch = s.charCodeAt(i);
      if (nocase ? lower(pch) !== lower(sch) : pch !== sch) return false;
      i++;
    }
    p++;
    if (i === sEnd) {
      while (p < pEnd && pattern.charCodeAt(p) === STAR) p++;
      break;
    }
  }
  return p >= pEnd && i === sEnd;
}
