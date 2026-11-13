/**
 * Skip list: the ordered index of a sorted set (spec 10.3), sorted by score, then member bytes.
 *
 * Key design choice: Redis's variant of Pugh's skip list. Each forward link carries a span (how
 * many level-0 steps it jumps), so the rank of a node is the sum of spans along the search path
 * and ZRANK, ZRANGE by index and ZREMRANGEBYRANK are O(log n) rather than O(n). A backward
 * pointer on level 0 gives cheap reverse walks (ZREVRANGE). Levels are drawn with p = 1/4 from
 * the seedable Random, so a test can replay a run. Ranges come in as plain structs; parsing
 * `(1.5` or `[a` belongs to the commands, which keeps this module free of protocol imports.
 *
 * Mirrors Redis t_zset.c (zslCreate, zslRandomLevel, zslInsert, zslDeleteNode, zslDelete,
 * zslUpdateScore, zslGetRank, zslGetElementByRank, zslFirstInRange, zslLastInRange,
 * zslFirstInLexRange, zslLastInLexRange, zslDeleteRangeByScore, zslDeleteRangeByRank,
 * zslDeleteRangeByLex).
 */
import type { Random } from '../utils/random.js';

export const SKIPLIST_MAXLEVEL = 32;
const SKIPLIST_P = 0.25;

/** A score range: `(1.5` sets `minex`, `-inf` is `min: -Infinity`. */
export interface ScoreRange {
  min: number;
  max: number;
  minex: boolean;
  maxex: boolean;
}

/** `-` and `+` in a lex range: below and above every member. */
export const LEX_MIN: unique symbol = Symbol('-');
export const LEX_MAX: unique symbol = Symbol('+');
export type LexBound = string | typeof LEX_MIN | typeof LEX_MAX;

/** A lex range: `[a` is inclusive, `(a` exclusive; the flags are ignored for `-` and `+`. */
export interface LexRange {
  min: LexBound;
  max: LexBound;
  minex: boolean;
  maxex: boolean;
}

interface Level {
  forward: SkiplistNode | null;
  span: number;
}

export class SkiplistNode {
  backward: SkiplistNode | null = null;
  readonly levels: Level[];

  constructor(
    readonly member: string,
    public score: number,
    level: number,
  ) {
    this.levels = Array.from({ length: level }, () => ({ forward: null, span: 0 }));
  }

  get next(): SkiplistNode | null {
    return this.levels[0]!.forward;
  }
}

/** True if (score, member) sorts before (s2, m2). */
const before = (score: number, member: string, s2: number, m2: string): boolean =>
  score < s2 || (score === s2 && member < m2);

export const scoreGteMin = (score: number, r: ScoreRange): boolean =>
  r.minex ? score > r.min : score >= r.min;
export const scoreLteMax = (score: number, r: ScoreRange): boolean =>
  r.maxex ? score < r.max : score <= r.max;

export function lexGteMin(member: string, r: LexRange): boolean {
  if (r.min === LEX_MIN) return true;
  if (r.min === LEX_MAX) return false;
  return r.minex ? member > r.min : member >= r.min;
}

export function lexLteMax(member: string, r: LexRange): boolean {
  if (r.max === LEX_MAX) return true;
  if (r.max === LEX_MIN) return false;
  return r.maxex ? member < r.max : member <= r.max;
}

/** min > max, or an empty exclusive range: nothing can be inside (zslIsInRange's first test). */
const scoreRangeEmpty = (r: ScoreRange): boolean =>
  r.min > r.max || (r.min === r.max && (r.minex || r.maxex));

function lexRangeEmpty(r: LexRange): boolean {
  if (r.min === LEX_MAX || r.max === LEX_MIN) return true;
  if (r.min === LEX_MIN || r.max === LEX_MAX) return false;
  return r.min > r.max || (r.min === r.max && (r.minex || r.maxex));
}

export class Skiplist {
  private readonly header = new SkiplistNode('', 0, SKIPLIST_MAXLEVEL);
  private tailNode: SkiplistNode | null = null;
  private len = 0;
  private maxLevel = 1;

  constructor(private readonly rng: Random) {}

  get length(): number {
    return this.len;
  }

  /** The highest level in use, for tests. */
  get level(): number {
    return this.maxLevel;
  }

  /** The first (lowest) node, or null. */
  get first(): SkiplistNode | null {
    return this.header.levels[0]!.forward;
  }

  get last(): SkiplistNode | null {
    return this.tailNode;
  }

  /** 1, then +1 with probability 1/4 each time, capped at 32 (zslRandomLevel). */
  private randomLevel(): number {
    let level = 1;
    while (level < SKIPLIST_MAXLEVEL && this.rng.next() < SKIPLIST_P) level++;
    return level;
  }

  /** Inserts a member that must not already be in the list. */
  insert(score: number, member: string): SkiplistNode {
    const update: SkiplistNode[] = new Array<SkiplistNode>(SKIPLIST_MAXLEVEL);
    const rank: number[] = new Array<number>(SKIPLIST_MAXLEVEL).fill(0);
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      rank[i] = i === this.maxLevel - 1 ? 0 : rank[i + 1]!;
      for (let f = x.levels[i]!.forward; f !== null && before(f.score, f.member, score, member);) {
        rank[i]! += x.levels[i]!.span;
        x = f;
        f = x.levels[i]!.forward;
      }
      update[i] = x;
    }
    const level = this.randomLevel();
    if (level > this.maxLevel) {
      for (let i = this.maxLevel; i < level; i++) {
        rank[i] = 0;
        update[i] = this.header;
        this.header.levels[i]!.span = this.len;
      }
      this.maxLevel = level;
    }
    const node = new SkiplistNode(member, score, level);
    for (let i = 0; i < level; i++) {
      const u = update[i]!;
      node.levels[i]!.forward = u.levels[i]!.forward;
      u.levels[i]!.forward = node;
      // The node lands rank[0] - rank[i] steps past update[i].
      node.levels[i]!.span = u.levels[i]!.span - (rank[0]! - rank[i]!);
      u.levels[i]!.span = rank[0]! - rank[i]! + 1;
    }
    // Levels above the node's height now jump over one more node.
    for (let i = level; i < this.maxLevel; i++) update[i]!.levels[i]!.span++;
    node.backward = update[0] === this.header ? null : update[0]!;
    if (node.levels[0]!.forward !== null) node.levels[0]!.forward.backward = node;
    else this.tailNode = node;
    this.len++;
    return node;
  }

  /** Removes (score, member); false if it isn't there. */
  delete(score: number, member: string): boolean {
    const update = this.searchUpdate(score, member);
    const x = update[0]!.levels[0]!.forward;
    if (x === null || x.score !== score || x.member !== member) return false;
    this.deleteNode(x, update);
    return true;
  }

  /**
   * Changes a member's score. When the node stays between its neighbours it is updated in
   * place, with no relinking; otherwise it is removed and inserted again (zslUpdateScore).
   */
  updateScore(curScore: number, member: string, newScore: number): SkiplistNode {
    const update = this.searchUpdate(curScore, member);
    const x = update[0]!.levels[0]!.forward;
    if (x === null || x.score !== curScore || x.member !== member) {
      throw new Error('Skiplist.updateScore: member not found');
    }
    const prev = x.backward;
    const next = x.levels[0]!.forward;
    if (
      (prev === null || before(prev.score, prev.member, newScore, member)) &&
      (next === null || before(newScore, member, next.score, next.member))
    ) {
      x.score = newScore;
      return x;
    }
    this.deleteNode(x, update);
    return this.insert(newScore, member);
  }

  /** 1-based rank of (score, member), or 0 if absent. */
  rank(score: number, member: string): number {
    let rank = 0;
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      for (let f = x.levels[i]!.forward; f !== null; f = x.levels[i]!.forward) {
        if (!(
          before(f.score, f.member, score, member) ||
          (f.score === score && f.member === member)
        )) {
          break;
        }
        rank += x.levels[i]!.span;
        x = f;
      }
      if (x !== this.header && x.score === score && x.member === member) return rank;
    }
    return 0;
  }

  /**
   * Benchmark helper: how many links `rank(score, member)` follows, including the failed
   * look-ahead at each level. That count is what grows with log n; wall time also includes
   * cache misses, which grow much faster once the list outgrows the CPU caches.
   */
  searchSteps(score: number, member: string): number {
    let steps = 0;
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      for (let f = x.levels[i]!.forward; f !== null; f = x.levels[i]!.forward) {
        steps++;
        if (!(
          before(f.score, f.member, score, member) ||
          (f.score === score && f.member === member)
        )) {
          break;
        }
        x = f;
      }
    }
    return steps;
  }

  /** The node at 1-based `rank`, or null. */
  byRank(rank: number): SkiplistNode | null {
    if (rank < 1 || rank > this.len) return null;
    let traversed = 0;
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      while (x.levels[i]!.forward !== null && traversed + x.levels[i]!.span <= rank) {
        traversed += x.levels[i]!.span;
        x = x.levels[i]!.forward!;
      }
      if (traversed === rank) return x;
    }
    return null;
  }

  /** The lowest node inside the score range, or null. */
  firstInRange(r: ScoreRange): SkiplistNode | null {
    if (!this.mayIntersect(r)) return null;
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      while (x.levels[i]!.forward !== null && !scoreGteMin(x.levels[i]!.forward!.score, r)) {
        x = x.levels[i]!.forward!;
      }
    }
    const n = x.levels[0]!.forward;
    return n !== null && scoreLteMax(n.score, r) ? n : null;
  }

  /** The highest node inside the score range, or null. */
  lastInRange(r: ScoreRange): SkiplistNode | null {
    if (!this.mayIntersect(r)) return null;
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      while (x.levels[i]!.forward !== null && scoreLteMax(x.levels[i]!.forward!.score, r)) {
        x = x.levels[i]!.forward!;
      }
    }
    return x !== this.header && scoreGteMin(x.score, r) ? x : null;
  }

  /**
   * The first node at or past the lex range's start. Lex ranges assume every score is equal,
   * as in Redis; with mixed scores the answer is whatever the same search gives in Redis.
   */
  firstInLexRange(r: LexRange): SkiplistNode | null {
    if (!this.mayIntersectLex(r)) return null;
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      while (x.levels[i]!.forward !== null && !lexGteMin(x.levels[i]!.forward!.member, r)) {
        x = x.levels[i]!.forward!;
      }
    }
    const n = x.levels[0]!.forward;
    return n !== null && lexLteMax(n.member, r) ? n : null;
  }

  lastInLexRange(r: LexRange): SkiplistNode | null {
    if (!this.mayIntersectLex(r)) return null;
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      while (x.levels[i]!.forward !== null && lexLteMax(x.levels[i]!.forward!.member, r)) {
        x = x.levels[i]!.forward!;
      }
    }
    return x !== this.header && lexGteMin(x.member, r) ? x : null;
  }

  /** Deletes every node in the score range; `onDelete` gets each member, so the dict can follow. */
  deleteRangeByScore(r: ScoreRange, onDelete: (member: string) => void): number {
    const update: SkiplistNode[] = new Array<SkiplistNode>(SKIPLIST_MAXLEVEL);
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      while (x.levels[i]!.forward !== null && !scoreGteMin(x.levels[i]!.forward!.score, r)) {
        x = x.levels[i]!.forward!;
      }
      update[i] = x;
    }
    let removed = 0;
    for (let n = x.levels[0]!.forward; n !== null && scoreLteMax(n.score, r);) {
      const next = n.levels[0]!.forward;
      this.deleteNode(n, update);
      onDelete(n.member);
      removed++;
      n = next;
    }
    return removed;
  }

  deleteRangeByLex(r: LexRange, onDelete: (member: string) => void): number {
    const update: SkiplistNode[] = new Array<SkiplistNode>(SKIPLIST_MAXLEVEL);
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      while (x.levels[i]!.forward !== null && !lexGteMin(x.levels[i]!.forward!.member, r)) {
        x = x.levels[i]!.forward!;
      }
      update[i] = x;
    }
    let removed = 0;
    for (let n = x.levels[0]!.forward; n !== null && lexLteMax(n.member, r);) {
      const next = n.levels[0]!.forward;
      this.deleteNode(n, update);
      onDelete(n.member);
      removed++;
      n = next;
    }
    return removed;
  }

  /** Deletes ranks `start` to `end`, 1-based and inclusive. */
  deleteRangeByRank(start: number, end: number, onDelete: (member: string) => void): number {
    const update: SkiplistNode[] = new Array<SkiplistNode>(SKIPLIST_MAXLEVEL);
    let traversed = 0;
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      while (x.levels[i]!.forward !== null && traversed + x.levels[i]!.span < start) {
        traversed += x.levels[i]!.span;
        x = x.levels[i]!.forward!;
      }
      update[i] = x;
    }
    traversed++;
    let removed = 0;
    for (let n = x.levels[0]!.forward; n !== null && traversed <= end; traversed++) {
      const next = n.levels[0]!.forward;
      this.deleteNode(n, update);
      onDelete(n.member);
      removed++;
      n = next;
    }
    return removed;
  }

  /**
   * Test helper: level-0 order, backward links, the tail, the length and every span agree
   * (each span equals the number of level-0 steps it covers). O(n × levels).
   */
  check(): void {
    const index = new Map<SkiplistNode, number>();
    let count = 0;
    let prev: SkiplistNode | null = null;
    for (let n = this.first; n !== null; n = n.next) {
      if (n.backward !== prev) throw new Error('skiplist: broken backward link');
      if (prev !== null && !before(prev.score, prev.member, n.score, n.member)) {
        throw new Error('skiplist: out of order');
      }
      if (n.levels.length > this.maxLevel) throw new Error('skiplist: node above list level');
      index.set(n, ++count);
      prev = n;
    }
    if (prev !== this.tailNode) throw new Error('skiplist: tail mismatch');
    if (count !== this.len) throw new Error(`skiplist: length ${this.len} != ${count}`);
    const rankOf = (n: SkiplistNode | null): number => (n === null ? this.len + 1 : index.get(n)!);
    for (let i = 0; i < this.maxLevel; i++) {
      let x: SkiplistNode = this.header;
      let at = 0;
      for (;;) {
        const f = x.levels[i]!.forward;
        const want = f === null ? 0 : rankOf(f) - at;
        // The last link on a level may carry any span; Redis never reads it.
        if (f !== null && x.levels[i]!.span !== want) {
          throw new Error(`skiplist: span ${x.levels[i]!.span} != ${want} at level ${i}`);
        }
        if (f === null) break;
        at = rankOf(f);
        x = f;
      }
    }
  }

  /** The update vector for (score, member): at each level, the last node before it. */
  private searchUpdate(score: number, member: string): SkiplistNode[] {
    const update: SkiplistNode[] = new Array<SkiplistNode>(SKIPLIST_MAXLEVEL);
    let x = this.header;
    for (let i = this.maxLevel - 1; i >= 0; i--) {
      for (let f = x.levels[i]!.forward; f !== null && before(f.score, f.member, score, member);) {
        x = f;
        f = x.levels[i]!.forward;
      }
      update[i] = x;
    }
    return update;
  }

  private deleteNode(x: SkiplistNode, update: SkiplistNode[]): void {
    for (let i = 0; i < this.maxLevel; i++) {
      const u = update[i]!;
      if (u.levels[i]!.forward === x) {
        u.levels[i]!.span += x.levels[i]!.span - 1;
        u.levels[i]!.forward = x.levels[i]!.forward;
      } else {
        u.levels[i]!.span -= 1;
      }
    }
    if (x.levels[0]!.forward !== null) x.levels[0]!.forward.backward = x.backward;
    else this.tailNode = x.backward;
    while (this.maxLevel > 1 && this.header.levels[this.maxLevel - 1]!.forward === null) {
      this.maxLevel--;
    }
    this.len--;
  }

  /** zslIsInRange: false if the range is empty or misses the list entirely. */
  private mayIntersect(r: ScoreRange): boolean {
    if (scoreRangeEmpty(r)) return false;
    const last = this.tailNode;
    if (last === null || !scoreGteMin(last.score, r)) return false;
    const first = this.first;
    return first !== null && scoreLteMax(first.score, r);
  }

  private mayIntersectLex(r: LexRange): boolean {
    if (lexRangeEmpty(r)) return false;
    const last = this.tailNode;
    if (last === null || !lexGteMin(last.member, r)) return false;
    const first = this.first;
    return first !== null && lexLteMax(first.member, r);
  }
}
