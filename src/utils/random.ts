/**
 * Seedable pseudo-random numbers. Every random choice the server makes (dict sampling, skip list
 * levels, SPOP, eviction) goes through one of these, so a test can pin the seed and replay a run.
 *
 * Key design choice: xoshiro128** in plain 32-bit integer math (Math.imul, >>>). It's fast, has a
 * 2^128 - 1 period and needs no BigInt. The state lives on an instance, never in the module,
 * because tests run several servers in one process (spec 4).
 *
 * Mirrors Redis's mt19937-64.c and its use of random(): Redis also has one process-wide generator.
 * Ours belongs to the Server object instead.
 */
import { randomBytes } from 'node:crypto';

const TWO_32 = 0x1_0000_0000;
const TWO_53 = 9007199254740992;

const rotl = (x: number, k: number): number => (x << k) | (x >>> (32 - k));

export class Random {
  /** The 32-bit seed this generator started from, printed by tests so a run can be replayed. */
  readonly seed: number;
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed: number = Random.entropySeed()) {
    this.seed = seed >>> 0;
    // splitmix32 spreads one 32-bit seed over the 128-bit state. Its outputs are never all zero,
    // which is the one state xoshiro can't leave.
    let x = this.seed;
    const mix = (): number => {
      x = (x + 0x9e3779b9) | 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
    this.s0 = mix();
    this.s1 = mix();
    this.s2 = mix();
    this.s3 = mix();
  }

  /** A generator with its raw state set, for checking xoshiro128**'s published test vectors. */
  static fromState(state: readonly [number, number, number, number]): Random {
    const r = new Random(0);
    [r.s0, r.s1, r.s2, r.s3] = state;
    return r;
  }

  /** A fresh seed from the OS, for servers that weren't given one. */
  static entropySeed(): number {
    return randomBytes(4).readUInt32LE(0);
  }

  /** A uniform unsigned 32-bit integer. */
  uint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** A uniform double in [0, 1), with all 53 bits of the mantissa random. */
  next(): number {
    return ((this.uint32() >>> 5) * 67108864 + (this.uint32() >>> 6)) / TWO_53;
  }

  /** A uniform integer in [0, n). `n` must be a positive safe integer. */
  int(n: number): number {
    if (n <= TWO_32) {
      // Rejection sampling: `uint32() % n` alone would favour small results whenever n doesn't
      // divide 2^32.
      const limit = TWO_32 - (TWO_32 % n);
      let x: number;
      do x = this.uint32();
      while (x >= limit);
      return x % n;
    }
    return Math.floor(this.next() * n);
  }
}
