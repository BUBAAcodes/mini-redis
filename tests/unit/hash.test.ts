import { describe, expect, it } from 'vitest';
import { murmur3_32 } from '../../src/utils/hash.js';

const latin1 = (bytes: number[]): string => Buffer.from(bytes).toString('latin1');

describe('murmur3_32', () => {
  // The widely used reference vectors for MurmurHash3_x86_32.
  const vectors: Array<[string, string, number, number]> = [
    ['empty, seed 0', '', 0, 0],
    ['empty, seed 1', '', 1, 0x514e28b7],
    ['empty, seed 0xffffffff', '', 0xffffffff, 0x81f16f39],
    ['four zero bytes', latin1([0, 0, 0, 0]), 0, 0x2362f9de],
    ['three zero bytes', latin1([0, 0, 0]), 0, 0x85f0b427],
    ['two zero bytes', latin1([0, 0]), 0, 0x30f4c306],
    ['one zero byte', latin1([0]), 0, 0x514e28b7],
    ['four 0xff bytes', latin1([0xff, 0xff, 0xff, 0xff]), 0, 0x76293b50],
    ['21 43 65 87', latin1([0x21, 0x43, 0x65, 0x87]), 0, 0xf55b516b],
    ['21 43 65 87, seed 0x5082edee', latin1([0x21, 0x43, 0x65, 0x87]), 0x5082edee, 0x2362f9de],
    ['21 43 65', latin1([0x21, 0x43, 0x65]), 0, 0x7e4a8634],
    ['21 43', latin1([0x21, 0x43]), 0, 0xa0f7b07a],
    ['21', latin1([0x21]), 0, 0x72661cf4],
    ['aaaa', 'aaaa', 0x9747b28c, 0x5a97808a],
    ['aaa', 'aaa', 0x9747b28c, 0x283e0130],
    ['aa', 'aa', 0x9747b28c, 0x5d211726],
    ['a', 'a', 0x9747b28c, 0x7fa09ea6],
    ['abcd', 'abcd', 0x9747b28c, 0xf0478627],
    ['abc', 'abc', 0x9747b28c, 0xc84a62dd],
    ['ab', 'ab', 0x9747b28c, 0x74875592],
    ['abc, seed 0', 'abc', 0, 0xb3dd93fa],
    ['Hello, world!', 'Hello, world!', 0x9747b28c, 0x24884cba],
    ['quick brown fox', 'The quick brown fox jumps over the lazy dog', 0x9747b28c, 0x2fa826cd],
    ['abcdbcde…', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', 0, 0xee925b90],
    // Multi-byte UTF-8, hashed as its raw bytes: what a client's key becomes after the parser.
    [
      'ππππππππ as UTF-8 bytes',
      Buffer.from('ππππππππ', 'utf8').toString('latin1'),
      0x9747b28c,
      0xd58063c1,
    ],
  ];

  for (const [name, input, seed, expected] of vectors) {
    it(name, () => expect(murmur3_32(input, seed)).toBe(expected));
  }

  it('changes with the seed, so bucket layouts differ between servers', () => {
    expect(murmur3_32('user:1', 1)).not.toBe(murmur3_32('user:1', 2));
  });
});
