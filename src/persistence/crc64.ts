/**
 * CRC-64/Jones (spec 11.3): the checksum at the end of every snapshot, as in Redis's crc64.c
 * (polynomial 0xad93d23594c935a9, reflected in and out, initial value 0, no final xor).
 *
 * Key design choice: the 64-bit register is kept as two uint32 halves, and the byte table is
 * split into two Uint32Arrays (high and low halves), so the hot loop is plain 32-bit integer
 * math. BigInt appears only when the tables are built once at load time and when a caller asks
 * for the final value. A table lookup per byte is slower than Redis's slice-by-16 but needs no
 * 64-bit integers, which JS doesn't have outside BigInt.
 *
 * Mirrors Redis crc64.c (crc64, _crc64) and crcspeed.c (the table-driven form).
 */

/** The Jones polynomial, bit-reversed for the reflected (LSB-first) algorithm. */
const POLY_REFLECTED = 0x95ac9329ac4bc9b5n;

const TABLE_HI = new Uint32Array(256);
const TABLE_LO = new Uint32Array(256);

for (let i = 0; i < 256; i++) {
  let crc = BigInt(i);
  for (let k = 0; k < 8; k++) crc = crc & 1n ? (crc >> 1n) ^ POLY_REFLECTED : crc >> 1n;
  TABLE_HI[i] = Number(crc >> 32n);
  TABLE_LO[i] = Number(crc & 0xffffffffn);
}

/** An incremental CRC-64: feed bytes in any number of pieces, then read `value`. */
export class Crc64 {
  private hi = 0;
  private lo = 0;

  update(data: Uint8Array): void {
    let hi = this.hi;
    let lo = this.lo;
    for (let i = 0; i < data.length; i++) {
      const t = (lo ^ data[i]!) & 0xff;
      // crc = table[(crc ^ byte) & 0xff] ^ (crc >> 8), on the two halves.
      lo = (((lo >>> 8) | (hi << 24)) ^ TABLE_LO[t]!) >>> 0;
      hi = ((hi >>> 8) ^ TABLE_HI[t]!) >>> 0;
    }
    this.hi = hi;
    this.lo = lo;
  }

  get value(): bigint {
    return (BigInt(this.hi) << 32n) | BigInt(this.lo);
  }

  /** Writes the 8-byte checksum little-endian at `offset`, as the snapshot stores it. */
  writeLE(out: Buffer, offset: number): void {
    out.writeUInt32LE(this.lo, offset);
    out.writeUInt32LE(this.hi, offset + 4);
  }

  /** True if the 8 bytes at `offset` hold this checksum, little-endian. */
  matchesLE(data: Buffer, offset: number): boolean {
    return data.readUInt32LE(offset) === this.lo && data.readUInt32LE(offset + 4) === this.hi;
  }
}

/** The CRC-64 of `data` in one call. */
export function crc64(data: Uint8Array): bigint {
  const crc = new Crc64();
  crc.update(data);
  return crc.value;
}
