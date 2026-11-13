import { describe, expect, it } from 'vitest';
import { Quicklist } from '../../src/datastructures/quicklist.js';

const fill = (q: Quicklist, n: number): void => {
  for (let i = 0; i < n; i++) q.pushTail(String(i));
};
const items = (q: Quicklist): string[] => q.range(0, q.length - 1);

describe('Quicklist (spec 10.4)', () => {
  it('pushes into the end node until it is full, then adds a node', () => {
    const q = new Quicklist(4);
    fill(q, 4);
    expect(q.nodeCount).toBe(1);
    q.pushTail('x');
    expect(q.nodeCount).toBe(2);
    q.pushHead('y');
    expect(q.nodeCount).toBe(3);
    expect(items(q)).toEqual(['y', '0', '1', '2', '3', 'x']);
    q.check();
  });

  it('pops from both ends and drops empty nodes', () => {
    const q = new Quicklist(2);
    fill(q, 5);
    expect(q.popHead()).toBe('0');
    expect(q.popTail()).toBe('4');
    expect(q.popTail()).toBe('3');
    // Pops never merge (only deletes inside the list do): [1] [2] stay two nodes.
    expect(q.nodeCount).toBe(2);
    expect(q.popHead()).toBe('1');
    expect(q.popHead()).toBe('2');
    expect(q.popHead()).toBeUndefined();
    expect(q.popTail()).toBeUndefined();
    expect(q.length).toBe(0);
    expect(q.nodeCount).toBe(0);
    q.check();
  });

  it('indexes from either end, including negative indexes', () => {
    const q = new Quicklist(3);
    fill(q, 10);
    for (let i = 0; i < 10; i++) {
      expect(q.index(i)).toBe(String(i));
      expect(q.index(i - 10)).toBe(String(i));
    }
    expect(q.index(10)).toBeUndefined();
    expect(q.index(-11)).toBeUndefined();
  });

  it('splits a full node on insert', () => {
    const q = new Quicklist(4);
    fill(q, 4);
    q.insert(2, 'm');
    expect(q.nodeCount).toBe(2);
    expect(items(q)).toEqual(['0', '1', 'm', '2', '3']);
    q.check();
  });

  it('merges neighbours after LREM once they fit in one node', () => {
    const q = new Quicklist(4);
    for (let i = 0; i < 12; i++) q.pushTail(i % 2 === 0 ? 'x' : String(i));
    expect(q.nodeCount).toBe(3);
    expect(q.remove('x', 0)).toBe(6);
    expect(q.nodeCount).toBe(2);
    expect(items(q)).toEqual(['1', '3', '5', '7', '9', '11']);
    q.check();
  });

  it('LREM honours the count and direction', () => {
    const q = new Quicklist(2);
    for (const v of ['a', 'b', 'a', 'c', 'a', 'a']) q.pushTail(v);
    expect(q.remove('a', 2)).toBe(2);
    expect(items(q)).toEqual(['b', 'c', 'a', 'a']);
    expect(q.remove('a', -1)).toBe(1);
    expect(items(q)).toEqual(['b', 'c', 'a']);
    expect(q.remove('zz', 0)).toBe(0);
    q.check();
  });

  it('trims whole nodes without walking them, and empties on an empty range', () => {
    const q = new Quicklist(3);
    fill(q, 20);
    q.trim(7, 12);
    expect(items(q)).toEqual(['7', '8', '9', '10', '11', '12']);
    q.check();
    q.trim(3, 1);
    expect(q.length).toBe(0);
    expect(q.nodeCount).toBe(0);
    q.check();
  });

  it('range copies only what was asked for', () => {
    const q = new Quicklist(5);
    fill(q, 100);
    expect(q.range(48, 52)).toEqual(['48', '49', '50', '51', '52']);
    expect(q.range(5, 4)).toEqual([]);
  });

  it('rejects a bad node size and an out-of-range insert', () => {
    expect(() => new Quicklist(0)).toThrow();
    const q = new Quicklist(4);
    expect(() => q.insert(1, 'x')).toThrow();
  });
});
