// The differential harness's own logic (spec 15.3), tested without Docker: replay from a seed,
// the two comparison exceptions, and that a real difference is caught.
import { describe, expect, it } from 'vitest';
import { buildCommandTable } from '../../src/commands/registry.js';
import { repliesMatch } from '../differential/compare.js';
import { Generator } from '../differential/generator.js';
import type { Exchange } from '../helpers/resp-client.js';

const registered = new Set(buildCommandTable().keys());
const run = (seed: number, n: number): string[][] => {
  const g = new Generator(seed, registered);
  return Array.from({ length: n }, () => g.next());
};
const bulk = (s: string): Exchange => ({ raw: `$${s.length}\r\n${s}\r\n`, value: s });
const int = (n: number): Exchange => ({ raw: `:${n}\r\n`, value: n });
const list = (items: string[]): Exchange => ({
  raw: `*${items.length}\r\n` + items.map((s) => `$${s.length}\r\n${s}\r\n`).join(''),
  value: items,
});

describe('generator', () => {
  it('replays the same commands from the same seed, and different ones from another', () => {
    expect(run(81723, 500)).toEqual(run(81723, 500));
    expect(run(81724, 500)).not.toEqual(run(81723, 500));
  });

  it('draws only registered commands, and uses every database', () => {
    const cmds = run(7, 5000);
    const names = new Set(cmds.map((c) => c[0]!.toLowerCase()));
    for (const n of names) expect(registered.has(n) || n === 'select').toBe(true);
    expect(names.has('set') && names.has('incrbyfloat') && names.has('expire')).toBe(true);
    expect(new Set(cmds.filter((c) => c[0] === 'SELECT').map((c) => c[1])).size).toBe(3);
  });

  it('never draws the commands spec 15.3 excludes', () => {
    const names = new Set(run(9, 5000).map((c) => c[0]!.toLowerCase()));
    for (const n of ['randomkey', 'scan', 'object', 'debug', 'config', 'client', 'info', 'spop'])
      expect(names.has(n)).toBe(false);
  });

  it('only draws commands that exist, so a missing command is skipped, not sent', () => {
    const only = new Generator(3, new Set(['get']));
    for (let i = 0; i < 200; i++) {
      const name = only.next()[0]!.toLowerCase();
      expect(name === 'get' || name === 'select').toBe(true);
    }
  });
});

describe('repliesMatch', () => {
  it('requires identical bytes by default', () => {
    expect(repliesMatch(['GET', 'a'], bulk('x'), bulk('x'))).toBe(true);
    expect(repliesMatch(['GET', 'a'], bulk('x'), bulk('y'))).toBe(false);
    expect(repliesMatch(['INCR', 'a'], int(1), int(2))).toBe(false);
  });

  it('accepts KEYS in a different order, but not different members', () => {
    expect(repliesMatch(['KEYS', '*'], list(['a', 'b']), list(['b', 'a']))).toBe(true);
    expect(repliesMatch(['KEYS', '*'], list(['a', 'b']), list(['a', 'c']))).toBe(false);
    expect(repliesMatch(['GET', '*'], list(['a', 'b']), list(['b', 'a']))).toBe(false);
  });

  it('lets positive TTL differ by 1 s and PTTL by 100 ms, but -1 and -2 only exactly', () => {
    expect(repliesMatch(['TTL', 'a'], int(100), int(99))).toBe(true);
    expect(repliesMatch(['TTL', 'a'], int(100), int(98))).toBe(false);
    expect(repliesMatch(['PTTL', 'a'], int(5000), int(4901))).toBe(true);
    expect(repliesMatch(['PTTL', 'a'], int(5000), int(4800))).toBe(false);
    expect(repliesMatch(['TTL', 'a'], int(-1), int(-2))).toBe(false);
    expect(repliesMatch(['TTL', 'a'], int(-1), int(5))).toBe(false);
  });
});
