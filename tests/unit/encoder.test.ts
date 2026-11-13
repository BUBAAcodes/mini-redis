import { describe, expect, it } from 'vitest';
import { Reply, formatDouble, type RespVersion } from '../../src/protocol/encoder.js';

const encode = (resp: RespVersion, write: (r: Reply) => void): string => {
  const r = new Reply(resp);
  write(r);
  return r.take();
};

/** Asserts the RESP2 and RESP3 encodings (the same unless `resp3` is given). */
const both = (write: (r: Reply) => void, resp2: string, resp3: string = resp2): void => {
  expect(encode(2, write)).toBe(resp2);
  expect(encode(3, write)).toBe(resp3);
};

describe('Reply builders (spec 7.3)', () => {
  it('ok and simple', () => {
    both((r) => r.ok(), '+OK\r\n');
    both((r) => r.simple('PONG'), '+PONG\r\n');
    both((r) => r.simple('a\r\nb'), '+a  b\r\n');
  });

  it('error keeps a leading code and adds ERR otherwise', () => {
    both((r) => r.error('ERR syntax error'), '-ERR syntax error\r\n');
    both(
      (r) => r.error('WRONGTYPE Operation against a key holding the wrong kind of value'),
      '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n',
    );
    both((r) => r.error('something broke'), '-ERR something broke\r\n');
    both((r) => r.error('Protocol error: x'), '-ERR Protocol error: x\r\n');
  });

  it('error replaces CR and LF with spaces, as Redis does', () => {
    both((r) => r.error("ERR unknown command 'a\r\nb'"), "-ERR unknown command 'a  b'\r\n");
  });

  it('integer takes numbers and bigints', () => {
    both((r) => r.integer(0), ':0\r\n');
    both((r) => r.integer(-42), ':-42\r\n');
    both((r) => r.integer(9223372036854775807n), ':9223372036854775807\r\n');
    both((r) => r.integer(-9223372036854775808n), ':-9223372036854775808\r\n');
  });

  it('bulk counts bytes and passes every byte through', () => {
    both((r) => r.bulk('hello'), '$5\r\nhello\r\n');
    both((r) => r.bulk(''), '$0\r\n\r\n');
    const all = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
    both((r) => r.bulk(all), `$256\r\n${all}\r\n`);
  });

  it('nullBulk and nullArray', () => {
    both((r) => r.nullBulk(), '$-1\r\n', '_\r\n');
    both((r) => r.nullArray(), '*-1\r\n', '_\r\n');
  });

  it('array maps strings, numbers, null and nested arrays', () => {
    both((r) => r.array([]), '*0\r\n');
    both(
      (r) => r.array(['a', 1, null]),
      '*3\r\n$1\r\na\r\n:1\r\n$-1\r\n',
      '*3\r\n$1\r\na\r\n:1\r\n_\r\n',
    );
    both((r) => r.array([['x', 2n], []]), '*2\r\n*2\r\n$1\r\nx\r\n:2\r\n*0\r\n');
  });

  it('map is a flat array in RESP2 and %n in RESP3', () => {
    both(
      (r) =>
        r.map([
          ['a', '1'],
          ['b', 2],
        ]),
      '*4\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n:2\r\n',
      '%2\r\n$1\r\na\r\n$1\r\n1\r\n$1\r\nb\r\n:2\r\n',
    );
    both((r) => r.map([]), '*0\r\n', '%0\r\n');
  });

  it('set is an array in RESP2 and ~n in RESP3', () => {
    both((r) => r.set(['a', 'b']), '*2\r\n$1\r\na\r\n$1\r\nb\r\n', '~2\r\n$1\r\na\r\n$1\r\nb\r\n');
  });

  it('double is a bulk in RESP2 and ,x in RESP3', () => {
    both((r) => r.double(1.5), '$3\r\n1.5\r\n', ',1.5\r\n');
    both((r) => r.double(Infinity), '$3\r\ninf\r\n', ',inf\r\n');
    both((r) => r.double(-Infinity), '$4\r\n-inf\r\n', ',-inf\r\n');
    both((r) => r.double(NaN), '$3\r\nnan\r\n', ',nan\r\n');
    both((r) => r.double(1e20), '$5\r\n1e+20\r\n', ',1e+20\r\n');
  });

  it('bool is :1/:0 in RESP2 and #t/#f in RESP3', () => {
    both((r) => r.bool(true), ':1\r\n', '#t\r\n');
    both((r) => r.bool(false), ':0\r\n', '#f\r\n');
  });

  it('verbatim is a bulk in RESP2 and =len txt: in RESP3', () => {
    both((r) => r.verbatim('a:1\r\n'), '$5\r\na:1\r\n\r\n', '=9\r\ntxt:a:1\r\n\r\n');
  });

  it('push is an array in RESP2 and >n in RESP3', () => {
    both(
      (r) => r.push(['message', 'ch', 'hi']),
      '*3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$2\r\nhi\r\n',
      '>3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$2\r\nhi\r\n',
    );
  });

  it('headers let mixed or streamed replies be built element by element', () => {
    both(
      (r) => {
        r.arrayLen(2);
        r.bulk('m');
        r.double(2.5);
      },
      '*2\r\n$1\r\nm\r\n$3\r\n2.5\r\n',
      '*2\r\n$1\r\nm\r\n,2.5\r\n',
    );
    both((r) => r.mapLen(1), '*2\r\n', '%1\r\n');
    both((r) => r.setLen(3), '*3\r\n', '~3\r\n');
    both((r) => r.pushLen(3), '*3\r\n', '>3\r\n');
  });

  it('tracks pending bytes, take() drains, and resp can change mid-stream', () => {
    const r = new Reply(2);
    expect(r.pendingBytes).toBe(0);
    r.ok();
    r.bulk('\xff\xfe');
    expect(r.pendingBytes).toBe(5 + 8);
    expect(r.take()).toBe('+OK\r\n$2\r\n\xff\xfe\r\n');
    expect(r.pendingBytes).toBe(0);
    expect(r.take()).toBe('');
    r.resp = 3;
    r.nullBulk();
    expect(r.take()).toBe('_\r\n');
  });
});

describe('formatDouble (redis:7.4 d2string: exact integers within 2^62, else fpconv)', () => {
  // Every pair was read back from the reference with ZADD + ZSCORE, except -0: a small zset
  // stores integral scores as integers, which drops the sign, so -0 was read from a ZINCRBY reply.
  const cases: [number, string][] = [
    [0, '0'],
    [-0, '-0'],
    [0.1, '0.1'],
    [2.5, '2.5'],
    [-2.5, '-2.5'],
    [123.456, '123.456'],
    [123456.75, '123456.75'],
    [1.2345678, '1.2345678'],
    [1e7, '10000000'],
    [1e8, '100000000'],
    [-1e8, '-100000000'],
    [1.5e8, '150000000'],
    [99999999, '99999999'],
    [1e15, '1000000000000000'],
    [1e18, '1000000000000000000'],
    [1.25e18, '1250000000000000000'],
    [Number('-123456789012345678'), '-123456789012345680'],
    [4611686018427387904, '4611686018427387904'],
    [-4611686018427387904, '-4611686018427387904'],
    [Number('4611686018427388904'), '4611686018427389000'],
    [13835058055282164e3, '13835058055282164000'],
    [5e18, '5e+18'],
    [1e19, '1e+19'],
    [1.25e19, '1.25e+19'],
    [1.23e19, '1.23e+19'],
    [1e20, '1e+20'],
    [1.234567e20, '1.234567e+20'],
    [1e21, '1e+21'],
    [1e100, '1e+100'],
    [1.7976931348623157e308, '1.7976931348623157e+308'],
    [1e-5, '0.00001'],
    [1.5e-5, '0.000015'],
    [0.000123, '0.000123'],
    [1e-6, '0.000001'],
    [1.2345678e-3, '0.0012345678'],
    [1.234e-5, '1.234e-5'],
    [1.5e-6, '1.5e-6'],
    [1.2345e-6, '1.2345e-6'],
    [1.234567e-6, '1.234567e-6'],
    [1e-7, '1e-7'],
    [1.5e-7, '1.5e-7'],
    [-1.5e-7, '-1.5e-7'],
    [1e-300, '1e-300'],
    [5e-324, '5e-324'],
    [Infinity, 'inf'],
    [-Infinity, '-inf'],
    [NaN, 'nan'],
  ];
  it.each(cases)('%d → %s', (x, expected) => {
    expect(formatDouble(x)).toBe(expected);
  });

  it('round-trips', () => {
    for (const x of [0.1, 1 / 3, Math.PI, 1e-7 / 3, 2 ** 70 + 2 ** 20, -123.456e-200]) {
      expect(Number(formatDouble(x))).toBe(x);
    }
  });
});
