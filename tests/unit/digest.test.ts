import { describe, expect, it } from 'vitest';
import { datasetDigest, valueDigest } from '../../src/commands/debug.js';
import { Server } from '../../src/server/server.js';
import { createStringObject } from '../../src/storage/redis-object.js';

const ZERO = '0'.repeat(40);
const newServer = () => new Server({ log: () => {}, seed: 3 });

describe('DEBUG DIGEST (spec 8.9)', () => {
  it('is all zeros for an empty dataset', () => {
    expect(datasetDigest(newServer())).toBe(ZERO);
  });

  it('does not depend on insertion order or dict layout', () => {
    const a = newServer();
    const b = newServer();
    const keys = Array.from({ length: 500 }, (_, i) => `key:${i}`);
    for (const k of keys) a.dbs[0]!.add(k, createStringObject(`v${k}`));
    for (const k of [...keys].reverse()) b.dbs[0]!.add(k, createStringObject(`v${k}`));
    expect(datasetDigest(a)).toMatch(/^[0-9a-f]{40}$/);
    expect(datasetDigest(a)).toBe(datasetDigest(b));
  });

  it('changes with the db, the key, the value and the expiry', () => {
    const base = () => {
      const s = newServer();
      s.dbs[0]!.add('k', createStringObject('v'));
      return s;
    };
    const ref = datasetDigest(base());
    const otherDb = newServer();
    otherDb.dbs[1]!.add('k', createStringObject('v'));
    const otherKey = newServer();
    otherKey.dbs[0]!.add('k2', createStringObject('v'));
    const otherValue = newServer();
    otherValue.dbs[0]!.add('k', createStringObject('v2'));
    const withTtl = base();
    withTtl.dbs[0]!.setExpire('k', Date.now() + 100_000);
    for (const s of [otherDb, otherKey, otherValue, withTtl]) {
      expect(datasetDigest(s)).not.toBe(ref);
    }
  });

  it('length-prefixes fields, so moving bytes between key and value changes it', () => {
    const a = newServer();
    a.dbs[0]!.add('ab', createStringObject('c'));
    const b = newServer();
    b.dbs[0]!.add('a', createStringObject('bc'));
    expect(datasetDigest(a)).not.toBe(datasetDigest(b));
  });

  it('skips keys that are already logically expired', () => {
    const s = newServer();
    s.dbs[0]!.add('dead', createStringObject('v'));
    s.dbs[0]!.setExpire('dead', 1);
    expect(datasetDigest(s)).toBe(ZERO);
    expect(s.dbs[0]!.size).toBe(1);
  });

  it('valueDigest depends on the value only', () => {
    expect(valueDigest(null)).toBe(ZERO);
    expect(valueDigest(createStringObject('x'))).toBe(valueDigest(createStringObject('x')));
    expect(valueDigest(createStringObject('x'))).not.toBe(valueDigest(createStringObject('y')));
  });
});
