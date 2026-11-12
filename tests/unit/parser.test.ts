import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROTOCOL, ProtocolError, expectedDollar } from '../../src/protocol/errors.js';
import {
  BIG_ARG,
  MAX_INLINE_LEN,
  RespParser,
  type ParsedCommand,
  type ParserLimits,
} from '../../src/protocol/parser.js';

const bytes = (s: string): Buffer => Buffer.from(s, 'latin1');

/** A RESP multibulk frame, built the way clients build them. */
const frame = (...args: string[]): string =>
  `*${args.length}\r\n` + args.map((a) => `$${a.length}\r\n${a}\r\n`).join('');

const drain = (p: RespParser): ParsedCommand[] => {
  const out: ParsedCommand[] = [];
  for (let cmd = p.next(); cmd !== null; cmd = p.next()) out.push(cmd);
  return out;
};

const parseAll = (input: string, limits?: ParserLimits): ParsedCommand[] => {
  const p = new RespParser(limits);
  p.feed(bytes(input));
  return drain(p);
};

/** Feeds `input` in pieces of `size` bytes, calling next() after each, as a socket would. */
const parseInPieces = (input: Buffer, size: number, limits?: ParserLimits): ParsedCommand[] => {
  const p = new RespParser(limits);
  const out: ParsedCommand[] = [];
  for (let i = 0; i < input.length; i += size) {
    p.feed(input.subarray(i, i + size));
    out.push(...drain(p));
  }
  return out;
};

const argvs = (input: string, limits?: ParserLimits): string[][] =>
  parseAll(input, limits).map((c) => c.argv);

const protocolError = (input: string, limits?: ParserLimits): string => {
  const p = new RespParser(limits);
  p.feed(bytes(input));
  try {
    drain(p);
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolError);
    return (e as Error).message;
  }
  throw new Error(`no protocol error for ${JSON.stringify(input.slice(0, 40))}`);
};

const unauthenticated: ParserLimits = {
  maxBulkLen: () => 64 * 1024 * 1024,
  authRequired: () => true,
};

describe('RespParser: multibulk', () => {
  it('parses a command and reports the bytes it used', () => {
    const input = frame('SET', 'user:1', 'alice');
    expect(parseAll(input)).toEqual([{ argv: ['SET', 'user:1', 'alice'], bytes: input.length }]);
  });

  it('parses empty bulks and every byte value', () => {
    const all = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
    expect(argvs(frame('ECHO', '') + frame('SET', all, '\xff\xfe'))).toEqual([
      ['ECHO', ''],
      ['SET', all, '\xff\xfe'],
    ]);
  });

  it('round-trips invalid UTF-8 byte for byte', () => {
    const [cmd] = parseInPieces(
      Buffer.from([42, 49, 13, 10, 36, 50, 13, 10, 0xff, 0xfe, 13, 10]),
      1,
    );
    expect(Buffer.from(cmd!.argv[0]!, 'latin1')).toEqual(Buffer.from([0xff, 0xfe]));
  });

  it('skips *0 and negative counts like empty lines, counting their bytes toward the next command', () => {
    const input = '*0\r\n*-1\r\n*-5\r\n' + frame('PING');
    expect(parseAll(input)).toEqual([{ argv: ['PING'], bytes: input.length }]);
  });

  it('waits for the rest of a frame', () => {
    const input = frame('GET', 'k');
    for (const cut of [1, 3, 4, 8, 12, input.length - 1]) {
      const q = new RespParser();
      q.feed(bytes(input.slice(0, cut)));
      expect(q.next()).toBeNull();
      q.feed(bytes(input.slice(cut)));
      expect(q.next()).toEqual({ argv: ['GET', 'k'], bytes: input.length });
      expect(q.next()).toBeNull();
    }
  });

  it('accepts any byte after the CR of a header, as Redis does', () => {
    // redis:7.4 replies +PONG to this; it only looks for '\r' and skips one more byte.
    expect(argvs('*1\rX$4\rXPING\r\n')).toEqual([['PING']]);
  });

  it('accepts the largest lengths allowed', () => {
    const p = new RespParser({ maxBulkLen: () => 100, authRequired: () => false });
    p.feed(bytes('*1048576\r\n$100\r\n'));
    expect(p.next()).toBeNull();
    expect(argvs(`*10\r\n${'$1\r\na\r\n'.repeat(10)}`, unauthenticated)).toHaveLength(1);
    expect(argvs(frame('a'.repeat(16384)), unauthenticated)).toHaveLength(1);
  });

  it('handles bulks of BIG_ARG bytes and more, split anywhere', () => {
    const big = 'x'.repeat(BIG_ARG) + '\x00\xff';
    const input = bytes(frame('SET', 'k', big) + frame('GET', 'k'));
    for (const size of [1000, 4096, 7, input.length]) {
      expect(parseInPieces(input, size).map((c) => c.argv)).toEqual([
        ['SET', 'k', big],
        ['GET', 'k'],
      ]);
    }
  });

  it('counts a bulk being filled in bufferedBytes', () => {
    const p = new RespParser();
    p.feed(bytes(`*1\r\n$${BIG_ARG}\r\n`));
    expect(p.next()).toBeNull();
    expect(p.bufferedBytes).toBe(BIG_ARG + 2);
    p.feed(bytes('x'.repeat(BIG_ARG) + '\r\n'));
    expect(p.next()!.argv[0]).toHaveLength(BIG_ARG);
    expect(p.bufferedBytes).toBe(0);
  });
});

describe('RespParser: inline', () => {
  it('splits on spaces and accepts LF or CRLF', () => {
    expect(argvs('PING\r\nSET a  b\nECHO\thi\r\n')).toEqual([
      ['PING'],
      ['SET', 'a', 'b'],
      ['ECHO', 'hi'],
    ]);
  });

  it('skips empty and blank lines, counting their bytes toward the next command', () => {
    const input = '\r\n\n   \r\nPING\r\n';
    expect(parseAll(input)).toEqual([{ argv: ['PING'], bytes: input.length }]);
  });

  it('follows sdssplitargs quoting (outputs read from redis:7.4)', () => {
    expect(argvs('ECHO "a\\x41\\n\\t\\"\\\\z"\r\n')).toEqual([['ECHO', 'aA\n\t"\\z']]);
    expect(argvs('ECHO "\\a\\b\\q"\r\n')).toEqual([['ECHO', '\x07\bq']]);
    expect(argvs('ECHO "\\xFF\\x0a"\r\n')).toEqual([['ECHO', '\xff\n']]);
    expect(argvs('ECHO "\\xZZ"\r\n')).toEqual([['ECHO', 'xZZ']]);
    expect(argvs("ECHO 'a\\'b\\n'\r\n")).toEqual([['ECHO', "a'b\\n"]]);
    expect(argvs('ECHO ""\r\n')).toEqual([['ECHO', '']]);
    expect(argvs('ECHO a"b"\r\n')).toEqual([['ECHO', 'ab']]);
    expect(argvs('ECHO "a b" c\r\n')).toEqual([['ECHO', 'a b', 'c']]);
  });

  it('treats CR, tab and NUL as separators the way C does', () => {
    expect(argvs('ECHO a\rb\r\n')).toEqual([['ECHO', 'a', 'b']]);
    expect(argvs('ECHO a\x00b c\r\n')).toEqual([['ECHO', 'a']]);
    expect(argvs('ECHO a\x0bb\r\n')).toEqual([['ECHO', 'a\x0bb']]);
  });

  it('parses an inline line longer than 64 KB when its newline has already arrived', () => {
    const long = 'a'.repeat(70_000);
    expect(argvs(`ECHO ${long}\n`)).toEqual([['ECHO', long]]);
  });
});

describe('RespParser: protocol errors (spec 7.4)', () => {
  it.each([
    '*abc\r\n',
    '*01\r\n',
    '*-0\r\n',
    '*+1\r\n',
    '* 1\r\n',
    '*\r\n',
    '*1048577\r\n',
    '*99999999999999999999\r\n',
    '*-99999999999999999999\r\n',
    `*${'1'.repeat(70_000)}\r\n`,
  ])('invalid multibulk length: %j', (input) => {
    expect(protocolError(input)).toBe(PROTOCOL.INVALID_MULTIBULK);
  });

  it.each(['$-1\r\n', '$x\r\n', '$04\r\n', '$+4\r\n', '$-0\r\n', '$4 \r\n', '$\r\n', '$101\r\n'])(
    'invalid bulk length: %j',
    (header) => {
      const limits = { maxBulkLen: () => 100, authRequired: () => false };
      expect(protocolError(`*1\r\n${header}`, limits)).toBe(PROTOCOL.INVALID_BULK);
    },
  );

  it("expected '$'", () => {
    expect(protocolError('*1\r\n:4\r\nPING\r\n')).toBe(expectedDollar(':'));
    expect(protocolError('*2\r\n$3\r\nGET\r\nk\r\n')).toBe(expectedDollar('k'));
  });

  it.each([
    'ECHO "abc\r\n',
    "ECHO 'abc\r\n",
    'ECHO "abc"def\r\n',
    "ECHO 'ab'c\r\n",
    'ECHO "a\x00"\r\n',
  ])('unbalanced quotes: %j', (input) => {
    expect(protocolError(input)).toBe(PROTOCOL.UNBALANCED_QUOTES);
  });

  it('too big inline request, mbulk count and bulk count', () => {
    expect(protocolError('a'.repeat(MAX_INLINE_LEN + 1))).toBe(PROTOCOL.TOO_BIG_INLINE);
    expect(protocolError('*' + '1'.repeat(MAX_INLINE_LEN))).toBe(PROTOCOL.TOO_BIG_MBULK);
    expect(protocolError('*1\r\n$' + '1'.repeat(MAX_INLINE_LEN))).toBe(PROTOCOL.TOO_BIG_BULK);
    // Exactly at the limit, it still waits for the newline.
    const p = new RespParser();
    p.feed(bytes('a'.repeat(MAX_INLINE_LEN)));
    expect(p.next()).toBeNull();
  });

  it('enforces the line limit when the line arrives in tiny pieces', () => {
    const p = new RespParser();
    expect(() => {
      for (let i = 0; i <= MAX_INLINE_LEN; i++) {
        p.feed(bytes('a'));
        p.next();
      }
    }).toThrow(PROTOCOL.TOO_BIG_INLINE);
  });

  it('unauthenticated multibulk and bulk lengths', () => {
    expect(protocolError('*11\r\n', unauthenticated)).toBe(PROTOCOL.UNAUTH_MULTIBULK);
    expect(protocolError('*1\r\n$16385\r\n', unauthenticated)).toBe(PROTOCOL.UNAUTH_BULK);
    // The general checks come first, as in Redis.
    expect(protocolError('*1\r\n$-1\r\n', unauthenticated)).toBe(PROTOCOL.INVALID_BULK);
  });

  it('a bulk not followed by CRLF (stricter than Redis; see DIFFERENCES.md)', () => {
    expect(protocolError('*1\r\n$4\r\nPINGxx')).toBe(PROTOCOL.MISSING_CRLF);
    expect(protocolError('*1\r\n$4\r\nPING\rx')).toBe(PROTOCOL.MISSING_CRLF);
    const big = 'y'.repeat(BIG_ARG);
    expect(protocolError(`*1\r\n$${big.length}\r\n${big}\n\r`)).toBe(PROTOCOL.MISSING_CRLF);
  });

  it('stays failed after a protocol error', () => {
    const p = new RespParser();
    p.feed(bytes('*x\r\n'));
    expect(() => p.next()).toThrow(PROTOCOL.INVALID_MULTIBULK);
    p.feed(bytes(frame('PING')));
    expect(() => p.next()).toThrow(PROTOCOL.INVALID_MULTIBULK);
  });
});

describe('RespParser: chunking', () => {
  /** A small seeded PRNG (mulberry32), so the pipeline is the same on every run. */
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const pipeline = (n: number): { input: Buffer; expected: ParsedCommand[] } => {
    const rand = prng(1234);
    const parts: string[] = [];
    const expected: ParsedCommand[] = [];
    for (let i = 0; i < n; i++) {
      let text: string;
      let argv: string[];
      const kind = rand();
      if (kind < 0.1) {
        text = `\r\nSET key:${i} "\\"quoted ${i}\\""\r\n`; // a blank line, then an inline command
        argv = ['SET', `key:${i}`, `"quoted ${i}"`];
      } else {
        const len = Math.floor(rand() * 40);
        const value = Array.from({ length: len }, () =>
          String.fromCharCode(Math.floor(rand() * 256)),
        ).join('');
        argv = ['SET', `key:${i}`, value];
        text = (kind < 0.15 ? '*0\r\n' : '') + frame(...argv);
      }
      parts.push(text);
      expected.push({ argv, bytes: text.length });
    }
    const big = 'z'.repeat(BIG_ARG + 5);
    parts.push(frame('SET', 'big', big));
    expected.push({ argv: ['SET', 'big', big], bytes: parts.at(-1)!.length });
    return { input: bytes(parts.join('')), expected };
  };

  it('a 1,000-command pipeline fed one byte at a time parses exactly like one chunk', () => {
    const { input, expected } = pipeline(1000);
    const whole = parseInPieces(input, input.length);
    expect(whole).toEqual(expected);
    expect(parseInPieces(input, 1)).toEqual(whole);
    expect(whole.reduce((sum, c) => sum + c.bytes, 0)).toBe(input.length);
  });

  it('any split of the input gives the same commands', () => {
    const { input, expected } = pipeline(60);
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: input.length - 1 }), { maxLength: 50 }),
        (cuts) => {
          const p = new RespParser();
          const out: ParsedCommand[] = [];
          let start = 0;
          for (const cut of [...cuts].sort((a, b) => a - b).concat(input.length)) {
            p.feed(input.subarray(start, cut));
            start = cut;
            out.push(...drain(p));
          }
          expect(out).toEqual(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a 64 MB bulk sent in 1 KB chunks parses in under 2 seconds', () => {
    const size = 64 * 1024 * 1024;
    const header = bytes(`*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$${size}\r\n`);
    const input = Buffer.concat([header, Buffer.alloc(size, 0x61), bytes('\r\n')]);
    const started = performance.now();
    const cmds = parseInPieces(input, 1024);
    const elapsed = performance.now() - started;
    console.log(`64 MB bulk in 1 KB chunks: ${elapsed.toFixed(0)} ms`);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.bytes).toBe(input.length);
    expect(cmds[0]!.argv[2]!.length).toBe(size);
    expect(elapsed).toBeLessThan(2000);
  });
});
