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

  it('marks a replicas-only record, and only that one', () => {
    const { p, records } = setup();
    p.begin();
    p.alsoPropagate(0, ['PUBLISH', 'c', 'm'], true);
    p.end(0, ['PUBLISH', 'c', 'm'], false);
    p.begin();
    p.end(0, ['SET', 'k', 'v'], true);
    expect(records).toEqual([
      { db: 0, argv: ['PUBLISH', 'c', 'm'], replicasOnly: true },
      { db: 0, argv: ['SET', 'k', 'v'] },
    ]);
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

  it('wraps the records of an EXEC in MULTI … EXEC, in the dbs they ran in', () => {
    const { p, records } = setup();
    p.multiStart();
    p.begin();
    p.end(2, ['SET', 'a', '1'], true);
    p.begin();
    p.propagateNow(2, ['DEL', 'expired']);
    p.end(2, ['GET', 'expired'], false);
    p.begin();
    p.end(5, ['INCR', 'b'], true);
    expect(records).toEqual([]);
    p.multiEnd();
    expect(records).toEqual([
      { db: 2, argv: ['MULTI'] },
      { db: 2, argv: ['SET', 'a', '1'] },
      { db: 2, argv: ['DEL', 'expired'] },
      { db: 5, argv: ['INCR', 'b'] },
      { db: 5, argv: ['EXEC'] },
    ]);
  });

  it('emits nothing for an EXEC that wrote nothing', () => {
    const { p, records, wakes } = setup();
    p.multiStart();
    p.begin();
    p.end(0, ['GET', 'a'], false);
    p.multiEnd();
    expect(records).toEqual([]);
    expect(wakes()).toBe(0);
  });

  it('wraps even a single write, as spec 9.5 says', () => {
    const { p, records } = setup();
    p.multiStart();
    p.begin();
    p.end(0, ['SET', 'a', '1'], true);
    p.multiEnd();
    expect(records.map((r) => r.argv[0])).toEqual(['MULTI', 'SET', 'EXEC']);
  });

  it('stops sending to a detached sink', () => {
    const { p, records, detach } = setup();
    detach();
    p.begin();
    p.end(0, ['SET', 'k', 'v'], true);
    expect(records).toEqual([]);
  });
});
