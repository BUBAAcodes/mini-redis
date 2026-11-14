// CRC-64/Jones (spec 11.3), checked against the vector from Redis's crc64.c and a slow
// bit-at-a-time BigInt reference.
import { describe, expect, it } from 'vitest';
import { Crc64, crc64 } from '../../src/persistence/crc64.js';
import { Random } from '../../src/utils/random.js';

/** Bit-at-a-time, reflected, poly 0xad93d23594c935a9: the textbook definition. */
function reference(data: Uint8Array): bigint {
  const POLY = 0x95ac9329ac4bc9b5n; // 0xad93d23594c935a9, bit-reversed
  let crc = 0n;
  for (const byte of data) {
    crc ^= BigInt(byte);
    for (let k = 0; k < 8; k++) crc = crc & 1n ? (crc >> 1n) ^ POLY : crc >> 1n;
  }
  return crc;
}

describe('crc64', () => {
  it('matches the test vector from Redis crc64.c', () => {
    expect(crc64(Buffer.from('123456789'))).toBe(0xe9c6d914c4b8d9can);
  });

  it('is 0 for no bytes', () => {
    expect(crc64(Buffer.alloc(0))).toBe(0n);
  });

  it('matches the bit-at-a-time definition on random data', () => {
    const rng = new Random(7);
    for (let n = 1; n < 300; n += 37) {
      const data = Buffer.alloc(n);
      for (let i = 0; i < n; i++) data[i] = rng.int(256);
      expect(crc64(data)).toBe(reference(data));
    }
  });

  it('gives the same result fed in pieces as in one go', () => {
    const data = Buffer.from('The quick brown fox jumps over the lazy dog, 0123456789 times.');
    const crc = new Crc64();
    crc.update(data.subarray(0, 1));
    crc.update(data.subarray(1, 20));
    crc.update(data.subarray(20, 20));
    crc.update(data.subarray(20));
    expect(crc.value).toBe(crc64(data));
  });

  it('writes its 8 bytes little-endian', () => {
    const crc = new Crc64();
    crc.update(Buffer.from('123456789'));
    const out = Buffer.alloc(8);
    crc.writeLE(out, 0);
    expect(out.readBigUInt64LE(0)).toBe(0xe9c6d914c4b8d9can);
  });
});
