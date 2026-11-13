/**
 * ZSet: a sorted set as a Dict of member → score plus a Skiplist ordered by (score, member)
 * (spec 10.3).
 *
 * Key design choice: two indexes that are always changed together, behind one small API. The
 * dict answers ZSCORE and membership in O(1); the skip list answers order, ranks and ranges in
 * O(log n). Nothing outside this class touches either one for writes, so they can't drift
 * apart. `add` implements ZADD's NX / XX / GT / LT / INCR rules in one place (Redis's zsetAdd),
 * so ZADD and ZINCRBY share them.
 *
 * Mirrors Redis t_zset.c (zsetAdd, zsetRemoveFromSkiplist, zsetScore, zsetRank, and the
 * skiplist half of zsetConvert).
 */
import { Dict } from './dict.js';
import type { DictOptions } from './dict.js';
import { Skiplist } from './skiplist.js';
import type { Random } from '../utils/random.js';

export interface ZAddFlags {
  nx?: boolean;
  xx?: boolean;
  gt?: boolean;
  lt?: boolean;
  incr?: boolean;
}

/** What `add` did: 'nan' means INCR produced NaN and nothing changed. */
export type ZAddOutcome = 'added' | 'updated' | 'unchanged' | 'skipped' | 'nan';

/**
 * The score as stored: -0 becomes 0. Redis keeps a small zset in a listpack, where an integral
 * score is stored as an integer, so the sign of zero is lost; the reply to the ZADD INCR or
 * ZINCRBY that computed it still says "-0". We always store like a listpack (DIFFERENCES.md).
 */
const stored = (score: number): number => (score === 0 ? 0 : score);

export class ZSet {
  readonly dict: Dict<number>;
  readonly zsl: Skiplist;

  constructor(options: DictOptions, rng: Random) {
    this.dict = new Dict<number>(options);
    this.zsl = new Skiplist(rng);
  }

  get size(): number {
    return this.dict.size;
  }

  score(member: string): number | undefined {
    return this.dict.get(member);
  }

  /**
   * ZADD for one member. `skipped` means NX, XX, GT or LT stopped it (ZADD INCR replies nil);
   * `unchanged` means it was processed but the score is the same. `score` is the member's score
   * afterwards (the new one for INCR), as computed: it can be -0, though -0 is stored as 0.
   */
  add(
    member: string,
    score: number,
    flags: ZAddFlags = {},
  ): { outcome: ZAddOutcome; score: number } {
    const cur = this.dict.get(member);
    if (cur !== undefined) {
      if (flags.nx) return { outcome: 'skipped', score: cur };
      let next = score;
      if (flags.incr) {
        next = cur + score;
        if (Number.isNaN(next)) return { outcome: 'nan', score: cur };
      }
      if ((flags.lt && next >= cur) || (flags.gt && next <= cur)) {
        return { outcome: 'skipped', score: cur };
      }
      // -0 === 0, so ZADD -0 on a 0 score changes nothing, as in Redis.
      if (next === cur) return { outcome: 'unchanged', score: next };
      this.zsl.updateScore(cur, member, stored(next));
      this.dict.set(member, stored(next));
      return { outcome: 'updated', score: next };
    }
    if (flags.xx) return { outcome: 'skipped', score };
    this.zsl.insert(stored(score), member);
    this.dict.set(member, stored(score));
    return { outcome: 'added', score };
  }

  remove(member: string): boolean {
    const cur = this.dict.get(member);
    if (cur === undefined) return false;
    this.zsl.delete(cur, member);
    this.dict.delete(member);
    return true;
  }

  /** 0-based rank, from the lowest score (or the highest with `reverse`), or null if absent. */
  rank(member: string, reverse = false): number | null {
    const cur = this.dict.get(member);
    if (cur === undefined) return null;
    const r = this.zsl.rank(cur, member);
    return reverse ? this.zsl.length - r : r - 1;
  }

  /** For the skip list's range deletes: drop the member from the dict as well. */
  readonly forget = (member: string): void => {
    this.dict.delete(member);
  };
}
