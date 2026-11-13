/**
 * Quicklist: a list as a doubly linked list of small arrays (spec 10.4).
 *
 * Key design choice: each node holds a plain JS array of at most `maxItems` byte strings. Pushes
 * and pops at either end touch only the end node, and positional access skips whole nodes by
 * their counts, starting from the nearer end. That gives O(1) ends like a linked list and cheap
 * middle access like a chunked array, without the O(n) copies a single array would need for
 * LPUSH. Inserting into a full node splits it; deleting merges a node with a neighbour once both
 * fit in one node, so the node count stays near `length / maxItems`. Redis packs each node into
 * a listpack (and can compress it); we keep arrays, because V8 already stores strings compactly.
 *
 * Mirrors Redis quicklist.c (quicklistPush, quicklistPop, quicklistGetIteratorAtIdx,
 * quicklistReplaceAtIndex, _quicklistInsert, _quicklistSplitNode, _quicklistMergeNodes,
 * quicklistDelRange).
 */

export const QUICKLIST_DEFAULT_MAX_ITEMS = 128;

class QuicklistNode {
  prev: QuicklistNode | null = null;
  next: QuicklistNode | null = null;
  constructor(public items: string[]) {}
}

export class Quicklist {
  private head: QuicklistNode | null = null;
  private tail: QuicklistNode | null = null;
  private len = 0;
  private nodes = 0;

  constructor(readonly maxItems: number = QUICKLIST_DEFAULT_MAX_ITEMS) {
    if (!Number.isInteger(maxItems) || maxItems < 1) {
      throw new Error('Quicklist: maxItems must be a positive integer');
    }
  }

  get length(): number {
    return this.len;
  }

  get nodeCount(): number {
    return this.nodes;
  }

  pushHead(value: string): void {
    const h = this.head;
    if (h !== null && h.items.length < this.maxItems) h.items.unshift(value);
    else this.linkBefore(new QuicklistNode([value]), h);
    this.len++;
  }

  pushTail(value: string): void {
    const t = this.tail;
    if (t !== null && t.items.length < this.maxItems) t.items.push(value);
    else this.linkAfter(new QuicklistNode([value]), t);
    this.len++;
  }

  popHead(): string | undefined {
    const h = this.head;
    if (h === null) return undefined;
    const value = h.items.shift()!;
    this.len--;
    if (h.items.length === 0) this.unlink(h);
    return value;
  }

  popTail(): string | undefined {
    const t = this.tail;
    if (t === null) return undefined;
    const value = t.items.pop()!;
    this.len--;
    if (t.items.length === 0) this.unlink(t);
    return value;
  }

  /** The item at `index` (0-based, negative counts from the tail), or undefined. */
  index(index: number): string | undefined {
    const at = this.locate(index);
    return at === null ? undefined : at[0].items[at[1]];
  }

  /** Replaces the item at `index`; false if out of range. */
  set(index: number, value: string): boolean {
    const at = this.locate(index);
    if (at === null) return false;
    at[0].items[at[1]] = value;
    return true;
  }

  /** The position of the first item equal to `value`, from the head, or -1. */
  indexOf(value: string): number {
    let base = 0;
    for (let n = this.head; n !== null; n = n.next) {
      const i = n.items.indexOf(value);
      if (i !== -1) return base + i;
      base += n.items.length;
    }
    return -1;
  }

  /**
   * Inserts `value` so it ends up at position `index` (0 ≤ index ≤ length): before the item that
   * is there now, or at the tail when `index === length`. A full node is split in two first.
   */
  insert(index: number, value: string): void {
    if (!Number.isInteger(index) || index < 0 || index > this.len) {
      throw new Error('Quicklist.insert: index out of range');
    }
    if (index === 0) return this.pushHead(value);
    if (index === this.len) return this.pushTail(value);
    let [node, offset] = this.locate(index)!;
    if (node.items.length >= this.maxItems && offset === 0) {
      // Going in front of a full node: a node of its own, so a split never leaves an empty half.
      this.linkBefore(new QuicklistNode([value]), node);
      this.len++;
      return;
    }
    if (node.items.length >= this.maxItems) {
      const half = node.items.length >> 1;
      const right = new QuicklistNode(node.items.slice(half));
      node.items.length = half;
      this.linkAfter(right, node);
      if (offset >= half) {
        node = right;
        offset -= half;
      }
    }
    node.items.splice(offset, 0, value);
    this.len++;
  }

  /**
   * The items from `start` to `end`, both inclusive and already within 0 … length-1. Walks node
   * by node from `start`, so only the requested items are copied.
   */
  range(start: number, end: number): string[] {
    const out: string[] = [];
    if (start > end || start < 0 || end >= this.len) return out;
    const at = this.locate(start)!;
    let offset = at[1];
    let left = end - start + 1;
    for (let n: QuicklistNode | null = at[0]; n !== null && left > 0; n = n.next, offset = 0) {
      const take = Math.min(left, n.items.length - offset);
      for (let i = 0; i < take; i++) out.push(n.items[offset + i]!);
      left -= take;
    }
    return out;
  }

  /** Calls `fn` on every item from head to tail. `fn` must not change the list. */
  forEach(fn: (value: string) => void): void {
    for (let n = this.head; n !== null; n = n.next) for (const v of n.items) fn(v);
  }

  /**
   * Keeps only the items from `start` to `end` (inclusive, already within 0 … length-1); an
   * empty range (`start > end`) empties the list. Whole nodes are dropped without being walked.
   */
  trim(start: number, end: number): void {
    if (start > end || start >= this.len || end < 0) {
      this.clear();
      return;
    }
    let fromHead = start;
    let fromTail = this.len - 1 - end;
    while (fromHead > 0) {
      const h = this.head!;
      if (h.items.length <= fromHead) {
        fromHead -= h.items.length;
        this.len -= h.items.length;
        this.unlink(h);
      } else {
        h.items.splice(0, fromHead);
        this.len -= fromHead;
        fromHead = 0;
      }
    }
    while (fromTail > 0) {
      const t = this.tail!;
      if (t.items.length <= fromTail) {
        fromTail -= t.items.length;
        this.len -= t.items.length;
        this.unlink(t);
      } else {
        t.items.length -= fromTail;
        this.len -= fromTail;
        fromTail = 0;
      }
    }
    if (this.head !== null) this.mergeAround(this.head);
    if (this.tail !== null) this.mergeAround(this.tail);
  }

  /**
   * LREM: removes items equal to `value`, at most `count` of them from the head when count > 0,
   * at most -count from the tail when count < 0, and all of them when count is 0. Returns how
   * many it removed.
   */
  remove(value: string, count: number): number {
    const limit = count === 0 ? Infinity : Math.abs(count);
    const fromTail = count < 0;
    let removed = 0;
    let n = fromTail ? this.tail : this.head;
    while (n !== null && removed < limit) {
      const next = fromTail ? n.prev : n.next;
      const items = n.items;
      if (fromTail) {
        for (let i = items.length - 1; i >= 0 && removed < limit; i--) {
          if (items[i] === value) {
            items.splice(i, 1);
            removed++;
          }
        }
      } else {
        for (let i = 0; i < items.length && removed < limit;) {
          if (items[i] === value) {
            items.splice(i, 1);
            removed++;
          } else {
            i++;
          }
        }
      }
      if (items.length === 0) this.unlink(n);
      n = next;
    }
    this.len -= removed;
    // LREM is O(n) anyway, so one merge pass afterwards is simpler than merging mid-walk.
    if (removed > 0) this.compact();
    return removed;
  }

  clear(): void {
    this.head = null;
    this.tail = null;
    this.len = 0;
    this.nodes = 0;
  }

  /**
   * Test helper: links run both ways, no node is empty or over `maxItems`, and the cached
   * length and node count match the nodes.
   */
  check(): void {
    let count = 0;
    let items = 0;
    let prev: QuicklistNode | null = null;
    for (let n = this.head; n !== null; n = n.next) {
      if (n.prev !== prev) throw new Error('quicklist: broken prev link');
      if (n.items.length === 0) throw new Error('quicklist: empty node');
      if (n.items.length > this.maxItems) throw new Error('quicklist: node over maxItems');
      count++;
      items += n.items.length;
      prev = n;
    }
    if (prev !== this.tail) throw new Error('quicklist: tail mismatch');
    if (count !== this.nodes) throw new Error(`quicklist: nodeCount ${this.nodes} != ${count}`);
    if (items !== this.len) throw new Error(`quicklist: length ${this.len} != ${items}`);
  }

  /** The node and offset of `index` (negative from the tail), walking from the nearer end. */
  private locate(index: number): [QuicklistNode, number] | null {
    if (index < 0) index += this.len;
    if (!Number.isInteger(index) || index < 0 || index >= this.len) return null;
    if (index < this.len / 2) {
      let n = this.head!;
      while (index >= n.items.length) {
        index -= n.items.length;
        n = n.next!;
      }
      return [n, index];
    }
    let fromEnd = this.len - 1 - index;
    let n = this.tail!;
    while (fromEnd >= n.items.length) {
      fromEnd -= n.items.length;
      n = n.prev!;
    }
    return [n, n.items.length - 1 - fromEnd];
  }

  /** Folds `node` into a neighbour when both fit in one node (prev first, as Redis does). */
  private mergeAround(node: QuicklistNode): void {
    const p = node.prev;
    if (p !== null && p.items.length + node.items.length <= this.maxItems) {
      for (const v of node.items) p.items.push(v);
      this.unlink(node);
      node = p;
    }
    const nx = node.next;
    if (nx !== null && node.items.length + nx.items.length <= this.maxItems) {
      for (const v of nx.items) node.items.push(v);
      this.unlink(nx);
    }
  }

  /** Merges every pair of neighbours that fits in one node, head to tail. */
  private compact(): void {
    for (let n = this.head; n !== null && n.next !== null;) {
      const nx = n.next;
      if (n.items.length + nx.items.length <= this.maxItems) {
        for (const v of nx.items) n.items.push(v);
        this.unlink(nx);
      } else {
        n = nx;
      }
    }
  }

  private linkBefore(node: QuicklistNode, before: QuicklistNode | null): void {
    if (before === null) {
      this.head = this.tail = node;
    } else {
      node.next = before;
      node.prev = before.prev;
      if (before.prev !== null) before.prev.next = node;
      else this.head = node;
      before.prev = node;
    }
    this.nodes++;
  }

  private linkAfter(node: QuicklistNode, after: QuicklistNode | null): void {
    if (after === null) {
      this.head = this.tail = node;
    } else {
      node.prev = after;
      node.next = after.next;
      if (after.next !== null) after.next.prev = node;
      else this.tail = node;
      after.next = node;
    }
    this.nodes++;
  }

  private unlink(node: QuicklistNode): void {
    if (node.prev !== null) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next !== null) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = node.next = null;
    this.nodes--;
  }
}
