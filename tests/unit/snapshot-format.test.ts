// The snapshot file format (spec 11.2): a round trip for every type, binary data and TTLs, and
// a loader that rejects any damage with its byte offset instead of guessing.
import { describe, expect, it } from 'vitest';
import { datasetDigest } from '../../src/commands/debug.js';
import { crc64 } from '../../src/persistence/crc64.js';
import {
  SnapshotLoadError,
  SnapshotWriter,
  encodeDataset,
  installSnapshot,
  readSnapshot,
} from '../../src/persistence/snapshot-format.js';
import { Server } from '../../src/server/server.js';
import type { Db } from '../../src/storage/database.js';
import {
  createHashObject,
  createListObject,
  createSetObject,
  createStringObject,
  createZsetObject,
} from '../../src/storage/redis-object.js';

const ALL_BYTES = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
const FAR = Date.now() + 3_600_000;

const newServer = (seed = 1) => new Server({ log: () => {}, seed });

/** Every type, all 256 byte values, TTLs, three dbs, and a list over several quicklist nodes. */
function fill(server: Server): void {
  const [db0, db1, , db3] = server.dbs as [Db, Db, Db, Db];
  db0.add('plain', createStringObject('hello'));
  db0.add(ALL_BYTES, createStringObject(ALL_BYTES));
  db0.add('\xff\xfe', createStringObject('\xff\xfe invalid utf-8'));
  db0.add('empty', createStringObject(''));
  db0.add('big', createStringObject('x'.repeat(100_000)));
  db0.add('ttl', createStringObject('soon gone'));
  db0.setExpire('ttl', FAR);

  const list = createListObject(server.config.get('list-max-node-items'));
  for (let i = 0; i < 1000; i++) list.value.pushTail(`item:${i}`);
  list.value.pushHead(ALL_BYTES);
  db1.add('list', list);
  db1.setExpire('list', FAR + 1);

  const hash = createHashObject(server.dictOptions);
  for (let i = 0; i < 300; i++) hash.value.set(`f${i}`, `v${i}`);
  hash.value.set(ALL_BYTES, '');
  db1.add('hash', hash);

  const set = createSetObject(server.dictOptions);
  for (let i = 0; i < 300; i++) set.value.set(`m${i}`, true);
  set.value.set(ALL_BYTES, true);
  db3.add('set', set);

  const zset = createZsetObject(server.dictOptions, server.rng);
  const scores = [0, -0, 1.5, -2.25, 1e300, -1e-300, Infinity, -Infinity, 0.1, 3];
  scores.forEach((s, i) => zset.value.add(`z${i}`, s));
  zset.value.add(ALL_BYTES, 42);
  db3.add('zset', zset);
  db3.setExpire('zset', FAR + 2);
}

function encode(server: Server): Buffer {
  return Buffer.concat(encodeDataset(server));
}

function load(data: Buffer, now: number | null = Date.now()): Server {
  const target = newServer(2);
  installSnapshot(target, readSnapshot(target, data, { now }));
  return target;
}

function expectLoadError(data: Buffer): SnapshotLoadError {
  try {
    readSnapshot(newServer(3), data, { now: null });
  } catch (e) {
    expect(e).toBeInstanceOf(SnapshotLoadError);
    const err = e as SnapshotLoadError;
    expect(err.offset).toBeGreaterThanOrEqual(0);
    expect(err.offset).toBeLessThanOrEqual(data.length);
    expect(err.message).toContain(`offset ${err.offset}`);
    return err;
  }
  throw new Error('the damaged snapshot loaded');
}

/** A file holding exactly `body` between the header and the end marker, with a valid CRC. */
function craft(body: number[] | Buffer): Buffer {
  const head = Buffer.from('MINIREDIS0001', 'latin1');
  const upToEnd = Buffer.concat([head, Buffer.from(body), Buffer.from([0xff])]);
  const crc = Buffer.alloc(8);
  crc.writeBigUInt64LE(crc64(upToEnd));
  return Buffer.concat([upToEnd, crc]);
}

describe('snapshot format', () => {
  it('round-trips every type, binary data and TTLs', () => {
    const server = newServer();
    fill(server);
    const loaded = load(encode(server));
    expect(datasetDigest(loaded)).toBe(datasetDigest(server));
    expect(loaded.dbs[0]!.peek(ALL_BYTES)!.value).toBe(ALL_BYTES);
    expect(loaded.dbs[1]!.getExpire('list')).toBe(FAR + 1);
    expect(loaded.dbs[0]!.getExpire('plain')).toBe(-1);
    expect(loaded.dbs[2]!.size).toBe(0);
  });

  it('writes the magic, the version, the aux fields, the end marker and the CRC', () => {
    const server = newServer();
    server.dbs[0]!.add('k', createStringObject('v'));
    const data = encode(server);
    expect(data.toString('latin1', 0, 13)).toBe('MINIREDIS0001');
    const text = data.toString('latin1');
    for (const aux of ['miniredis-ver', 'ctime', 'used-mem']) expect(text).toContain(aux);
    expect(data[data.length - 9]).toBe(0xff);
    expect(data.readBigUInt64LE(data.length - 8)).toBe(crc64(data.subarray(0, data.length - 8)));
    const loaded = readSnapshot(newServer(), data, { now: null });
    expect(Number(loaded.aux.get('ctime'))).toBeCloseTo(Date.now() / 1000, -1);
  });

  it('writes an empty dataset as just the header, the end and the CRC', () => {
    const loaded = load(encode(newServer()));
    expect(loaded.dbs.every((db) => db.size === 0)).toBe(true);
  });

  it('gives the same bytes in pieces as in one go', () => {
    const server = newServer();
    fill(server);
    const whole = encode(server);
    const writer = new SnapshotWriter([['ctime', '0']]);
    const pieces: Buffer[] = [];
    for (const db of server.dbs) {
      db.forEachKey((key, obj, expireAt) => {
        writer.writeKey(db.id, key, obj, expireAt);
        pieces.push(...writer.take());
      });
    }
    writer.end();
    pieces.push(...writer.take());
    const loaded = load(Buffer.concat(pieces));
    expect(datasetDigest(loaded)).toBe(datasetDigest(server));
    expect(whole.length).toBeGreaterThan(100_000);
  });

  it('writes SELECT whenever the db changes, even out of order', () => {
    const server = newServer();
    const a = createStringObject('a');
    const writer = new SnapshotWriter([]);
    writer.writeKey(3, 'k3', a, -1);
    writer.writeKey(0, 'k0', a, -1);
    writer.writeKey(3, 'k3b', a, -1);
    writer.end();
    const loaded = readSnapshot(server, Buffer.concat(writer.take()), { now: null });
    expect(loaded.dbs[3]!.size).toBe(2);
    expect(loaded.dbs[0]!.size).toBe(1);
  });

  it('skips keys that have already expired, and counts them', () => {
    const server = newServer();
    server.dbs[0]!.add('dead', createStringObject('x'));
    server.dbs[0]!.setExpire('dead', 1000);
    server.dbs[0]!.add('alive', createStringObject('y'));
    const data = encode(server);
    const loaded = readSnapshot(newServer(), data, { now: Date.now() });
    expect(loaded.keys).toBe(1);
    expect(loaded.expired).toBe(1);
    expect(loaded.dbs[0]!.hasEntry('dead')).toBe(false);
    // Asked to keep everything (a replica's full sync), it keeps the expired key too.
    expect(readSnapshot(newServer(), data, { now: null }).keys).toBe(2);
  });

  it('rejects every single flipped byte with an offset', () => {
    const server = newServer();
    const db = server.dbs[0]!;
    db.add('s', createStringObject('value'));
    db.setExpire('s', FAR);
    const list = createListObject(4);
    for (const v of ['a', 'b', 'c', 'd', 'e']) list.value.pushTail(v);
    server.dbs[2]!.add('l', list);
    const zset = createZsetObject(server.dictOptions, server.rng);
    zset.value.add('m', 1.5);
    db.add('z', zset);
    const data = encode(server);
    for (let i = 0; i < data.length; i++) {
      for (const mask of [0x01, 0x80, 0xff]) {
        const bad = Buffer.from(data);
        bad[i]! ^= mask;
        expectLoadError(bad);
      }
    }
  });

  it('rejects a file cut off at any length', () => {
    const server = newServer();
    server.dbs[0]!.add('k', createStringObject('v'));
    const data = encode(server);
    for (let n = 0; n < data.length; n++) expectLoadError(data.subarray(0, n));
    expectLoadError(Buffer.concat([data, Buffer.from([0])]));
  });

  it('names the offset of a bad magic, a bad version and an unknown record', () => {
    const good = encode(newServer());
    const magic = Buffer.from(good);
    magic.write('REDIS', 0, 'latin1');
    expect(expectLoadError(magic).offset).toBe(0);
    const version = Buffer.from(good);
    version.write('0002', 9, 'latin1');
    expect(expectLoadError(version).offset).toBe(9);
    const err = expectLoadError(craft([0x07]));
    expect(err.offset).toBe(13);
    expect(err.message).toMatch(/unknown record type 7/);
  });

  it('checks a length against the bytes left before allocating anything', () => {
    // A string key whose length varint claims 2^49 bytes.
    const err = expectLoadError(craft([0x00, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]));
    expect(err.offset).toBe(14);
    // A list claiming a billion items in a few bytes.
    expectLoadError(craft([0x01, 0x01, 0x6b, 0x80, 0x94, 0xeb, 0xdc, 0x03]));
  });

  it('rejects a db index past the configured databases', () => {
    const err = expectLoadError(craft([0xfe, 16, 0x00, 1, 0x6b, 1, 0x76]));
    expect(err.offset).toBe(13);
    expect(err.message).toMatch(/db index 16/);
  });

  it('rejects duplicates, empty collections, NaN scores and a dangling expiry', () => {
    const key = (type: number) => [type, 1, 0x6b];
    const str = (s: string) => [s.length, ...Buffer.from(s, 'latin1')];
    const nan = Buffer.alloc(8);
    nan.writeDoubleLE(NaN);
    expect(
      expectLoadError(craft([...key(0), ...str('a'), ...key(0), ...str('b')])).message,
    ).toMatch(/duplicate key/);
    expect(expectLoadError(craft([...key(2), 2, ...str('m'), ...str('m')])).message).toMatch(
      /duplicate/,
    );
    expect(expectLoadError(craft([...key(1), 0])).message).toMatch(/empty/);
    expect(expectLoadError(craft([...key(3), 1, ...str('m'), ...nan])).message).toMatch(/NaN/);
    expect(expectLoadError(craft([0xfc, 1, 2, 3, 4, 5, 6, 7, 8])).message).toMatch(/expiry/);
  });
});
