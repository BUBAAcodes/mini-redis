import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ReplicationBacklog } from '../../src/replication/backlog.js';

const text = (b: Buffer): string => b.toString('latin1');

describe('ReplicationBacklog (spec 9.13)', () => {
  it('starts empty, its first byte one past the offset it was created at', () => {
    const b = new ReplicationBacklog(16, 100);
    expect(b.size).toBe(16);
    expect(b.histlen).toBe(0);
    expect(b.endOffset).toBe(100);
    expect(b.firstByteOffset).toBe(101);
    expect(text(b.readFrom(101))).toBe('');
  });

  it('holds what was appended, with offsets counting every byte', () => {
    const b = new ReplicationBacklog(16, 0);
    b.append('hello');
    b.append(' world');
    expect(b.histlen).toBe(11);
    expect(b.endOffset).toBe(11);
    expect(b.firstByteOffset).toBe(1);
    expect(text(b.readFrom(1))).toBe('hello world');
    expect(text(b.readFrom(7))).toBe('world');
    expect(text(b.readFrom(12))).toBe('');
  });

  it('keeps only the newest `size` bytes once it wraps', () => {
    const b = new ReplicationBacklog(10, 0);
    b.append('abcdefgh');
    b.append('ijklmn');
    expect(b.histlen).toBe(10);
    expect(b.endOffset).toBe(14);
    expect(b.firstByteOffset).toBe(5);
    expect(text(b.readFrom(5))).toBe('efghijklmn');
    expect(text(b.readFrom(7))).toBe('ghijklmn');
  });

  it('takes a record bigger than itself, keeping its tail', () => {
    const b = new ReplicationBacklog(10, 0);
    b.append('x');
    b.append('0123456789abcdefghijklmno');
    expect(b.endOffset).toBe(26);
    expect(b.firstByteOffset).toBe(17);
    expect(text(b.readFrom(17))).toBe('fghijklmno');
  });

  it('keeps every byte value (spec 7.1)', () => {
    const all = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
    const b = new ReplicationBacklog(300, 0);
    b.append(all);
    expect([...b.readFrom(1)]).toEqual(Array.from({ length: 256 }, (_, i) => i));
  });

  it('refuses an offset it does not hold', () => {
    const b = new ReplicationBacklog(10, 0);
    b.append('0123456789abc');
    expect(b.contains(4)).toBe(true);
    expect(b.contains(14)).toBe(true);
    expect(b.contains(3)).toBe(false);
    expect(b.contains(15)).toBe(false);
    expect(() => b.readFrom(3)).toThrow();
    expect(() => b.readFrom(15)).toThrow();
  });

  it('resizes, keeping the newest bytes that fit', () => {
    const b = new ReplicationBacklog(10, 0);
    b.append('abcdefghijklmn'); // holds efghijklmn
    b.resize(4);
    expect(b.size).toBe(4);
    expect(b.firstByteOffset).toBe(11);
    expect(text(b.readFrom(11))).toBe('klmn');
    b.resize(8);
    expect(text(b.readFrom(11))).toBe('klmn');
    b.append('opqrstu');
    expect(text(b.readFrom(b.firstByteOffset))).toBe('nopqrstu');
    expect(b.endOffset).toBe(21);
  });

  it('matches a plain string under random appends, reads and resizes', () => {
    const op = fc.oneof(
      fc.record({ append: fc.string({ unit: 'binary-ascii', maxLength: 40 }) }),
      fc.record({ resize: fc.integer({ min: 1, max: 64 }) }),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.nat(1000),
        fc.array(op),
        (size, start, ops) => {
          const b = new ReplicationBacklog(size, start);
          let all = '';
          let cap = size;
          let heldLen = 0;
          for (const o of ops) {
            if ('append' in o) {
              all += o.append;
              heldLen = Math.min(cap, heldLen + o.append.length);
              b.append(o.append);
            } else {
              cap = o.resize;
              heldLen = Math.min(cap, heldLen);
              b.resize(cap);
            }
            const held = all.slice(all.length - heldLen);
            expect(b.histlen).toBe(heldLen);
            expect(b.endOffset).toBe(start + all.length);
            expect(b.firstByteOffset).toBe(start + all.length - held.length + 1);
            expect(text(b.readFrom(b.firstByteOffset))).toBe(held);
            // Any offset inside reads the same suffix.
            if (held.length > 0) {
              const mid = b.firstByteOffset + Math.floor(held.length / 2);
              expect(text(b.readFrom(mid))).toBe(held.slice(mid - b.firstByteOffset));
            }
          }
        },
      ),
    );
  });
});
