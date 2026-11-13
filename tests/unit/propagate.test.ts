import { describe, expect, it } from 'vitest';
import { Propagator } from '../../src/server/propagate.js';
import type { PropagationRecord } from '../../src/server/propagate.js';

const setup = () => {
  const records: PropagationRecord[] = [];
  let wakes = 0;
  const p = new Propagator(() => wakes++);
  const detach = p.attach({ append: (r) => records.push(r) });
  return { p, records, detach, wakes: () => wakes };
};

describe('Propagator (spec 9.5)', () => {
  it('emits a changed write as it arrived, and wakes beforeSleep', () => {
    const { p, records, wakes } = setup();
    p.begin();
    p.end(0, ['SET', 'k', 'v'], true);
    expect(records).toEqual([{ db: 0, argv: ['SET', 'k', 'v'] }]);
    expect(wakes()).toBe(1);
  });

  it('emits nothing when nothing changed', () => {
    const { p, records, wakes } = setup();
    p.begin();
    p.end(0, ['DEL', 'missing'], false);
    expect(records).toEqual([]);
    expect(wakes()).toBe(0);
  });

  it('rewritePropagation replaces the record', () => {
    const { p, records } = setup();
    p.begin();
    p.rewrite(['SET', 'k', 'v', 'PXAT', '1794500000000']);
    p.end(3, ['SET', 'k', 'v', 'EX', '10'], true);
    expect(records).toEqual([{ db: 3, argv: ['SET', 'k', 'v', 'PXAT', '1794500000000'] }]);
  });

  it('alsoPropagate emits its records instead of the command', () => {
    const { p, records } = setup();
    p.begin();
    p.alsoPropagate(1, ['SREM', 's', 'a', 'b']);
    p.end(1, ['SPOP', 's', '2'], true);
    expect(records).toEqual([{ db: 1, argv: ['SREM', 's', 'a', 'b'] }]);
  });

  it('preventPropagation drops the record', () => {
    const { p, records } = setup();
    p.begin();
    p.prevent();
    p.end(0, ['SET', 'k', 'v'], true);
    expect(records).toEqual([]);
  });

  it('propagateNow goes ahead of the running command', () => {
    const { p, records } = setup();
    p.begin();
    p.propagateNow(0, ['DEL', 'expired']);
    p.end(0, ['SET', 'expired', 'v'], true);
    expect(records.map((r) => r.argv[0])).toEqual(['DEL', 'SET']);
  });

  it('forgets per-command state between commands', () => {
    const { p, records } = setup();
    p.begin();
    p.prevent();
    p.end(0, ['SET', 'a', '1'], true);
    p.begin();
    p.end(0, ['SET', 'b', '2'], true);
    expect(records).toEqual([{ db: 0, argv: ['SET', 'b', '2'] }]);
  });

  it('stops sending to a detached sink', () => {
    const { p, records, detach } = setup();
    detach();
    p.begin();
    p.end(0, ['SET', 'k', 'v'], true);
    expect(records).toEqual([]);
  });
});
