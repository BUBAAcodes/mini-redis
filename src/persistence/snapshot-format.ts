/**
 * The snapshot file, `dump.mrdb` (spec 11.2): the binary writer, the loader, and the
 * synchronous paths that use them (SAVE, loading at startup, DEBUG RELOAD).
 *
 * Key design choice: the writer is incremental. It turns one key at a time into bytes and
 * hands them out with take(), keeping a running CRC-64, so the same writer serves SAVE (all keys
 * at once), BGSAVE (a few keys per time slice, plus whatever the copy-on-write hook saves) and,
 * in step 20, a replica's full sync. Records carry their own SELECT, so keys may arrive in any
 * db order, as the hook delivers them.
 *
 * The loader never trusts the file: every length and count is checked against the bytes left
 * before anything is allocated (rule 11), everything goes into fresh databases, and those are
 * swapped in only once the checksum at the end matches. Any problem is a SnapshotLoadError with
 * the byte offset where it was found; MiniRedis never starts empty over a file it couldn't read
 * (spec 9.9).
 *
 * Mirrors Redis rdb.c (rdbSaveRio, rdbSaveKeyValuePair, rdbSaveObject, rdbSaveAuxField,
 * rdbLoadRio, rdbLoadObject, rdbSave, rdbLoad) and debug.c (DEBUG RELOAD).
 */
import fs from 'node:fs';
import { join } from 'node:path';
import type { Server } from '../server/server.js';
import { MINIREDIS_VERSION } from '../server/version.js';
import { Db } from '../storage/database.js';
import {
  createHashObject,
  createListObject,
  createSetObject,
  createStringObject,
  createZsetObject,
} from '../storage/redis-object.js';
import type { RObj } from '../storage/redis-object.js';
import { strerror } from '../utils/errno.js';
import { Crc64 } from './crc64.js';
import { tempSnapshotPath, writeFileAtomicSync } from './files.js';

const MAGIC = 'MINIREDIS';
const VERSION = '0001';
const HEADER = MAGIC + VERSION;

// The opcodes and type numbers mirror RDB's (rdb.h); the encodings don't.
const OP_AUX = 0xfa;
const OP_EXPIRETIME_MS = 0xfc;
const OP_SELECTDB = 0xfe;
const OP_EOF = 0xff;
const TYPE_STRING = 0;
const TYPE_LIST = 1;
const TYPE_SET = 2;
const TYPE_ZSET = 3;
const TYPE_HASH = 4;

const CRC_BYTES = 8;
const TWO_32 = 2 ** 32;

/** Size of the writer's scratch buffer: small fields collect here between take()s. */
const SCRATCH = 64 * 1024;
/** Strings at least this long go out as their own Buffer instead of through the scratch. */
const BIG_STRING = 16 * 1024;

/** Where the snapshot lives: `dir/dbfilename`. */
export const snapshotPath = (server: Server): string =>
  join(server.config.get('dir'), server.config.get('dbfilename'));

/** The aux fields every snapshot starts with (spec 11.2). */
export function snapshotAux(): Array<[string, string]> {
  return [
    ['miniredis-ver', MINIREDIS_VERSION],
    ['ctime', String(Math.floor(Date.now() / 1000))],
    // The heap until step 19 brings our own estimate (spec 10.5).
    ['used-mem', String(process.memoryUsage().heapUsed)],
  ];
}

/**
 * Builds a snapshot one record at a time. Bytes collect in a scratch buffer; take() hands out
 * what was produced since the last call, already counted in the CRC.
 */
export class SnapshotWriter {
  private buf = Buffer.allocUnsafe(SCRATCH);
  private pos = 0;
  private out: Buffer[] = [];
  private outBytes = 0;
  private readonly crc = new Crc64();
  /** The db the last key record ran in; -1 makes the next one carry a SELECT. */
  private lastDb = -1;
  private ended = false;

  constructor(aux: ReadonlyArray<readonly [string, string]>) {
    this.ensure(HEADER.length);
    this.pos += this.buf.write(HEADER, this.pos, 'latin1');
    for (const [name, value] of aux) {
      this.byte(OP_AUX);
      this.string(name);
      this.string(value);
    }
  }

  /** Bytes produced and not yet taken. */
  get pendingBytes(): number {
    return this.outBytes + this.pos;
  }

  /** One key: SELECT if its db differs from the last record's, its expiry, its value. */
  writeKey(db: number, key: string, obj: RObj, expireAt: number): void {
    if (this.ended) throw new Error('SnapshotWriter: write after end');
    if (db !== this.lastDb) {
      this.byte(OP_SELECTDB);
      this.varint(db);
      this.lastDb = db;
    }
    if (expireAt !== -1) {
      this.byte(OP_EXPIRETIME_MS);
      this.uint64(expireAt);
    }
    switch (obj.type) {
      case 'string':
        this.byte(TYPE_STRING);
        this.string(key);
        this.string(obj.value);
        break;
      case 'list':
        this.byte(TYPE_LIST);
        this.string(key);
        this.varint(obj.value.length);
        obj.value.forEach((item) => this.string(item));
        break;
      case 'set':
        this.byte(TYPE_SET);
        this.string(key);
        this.varint(obj.value.size);
        obj.value.forEach((member) => this.string(member));
        break;
      case 'zset':
        this.byte(TYPE_ZSET);
        this.string(key);
        this.varint(obj.value.size);
        // In score order, so the loader's skip-list inserts always append.
        for (let n = obj.value.zsl.first; n !== null; n = n.next) {
          this.string(n.member);
          this.double(n.score);
        }
        break;
      case 'hash':
        this.byte(TYPE_HASH);
        this.string(key);
        this.varint(obj.value.size);
        obj.value.forEach((field, value) => {
          this.string(field);
          this.string(value);
        });
        break;
      default: {
        const unknown: never = obj;
        throw new Error(`SnapshotWriter: no encoding for type ${(unknown as RObj).type}`);
      }
    }
  }

  /** The end marker, then the CRC-64 of every byte before it. */
  end(): void {
    if (this.ended) return;
    this.byte(OP_EOF);
    this.flushScratch();
    const crc = Buffer.alloc(CRC_BYTES);
    this.crc.writeLE(crc, 0);
    this.out.push(crc);
    this.outBytes += CRC_BYTES;
    this.ended = true;
  }

  /** The bytes produced since the last take(), in order. */
  take(): Buffer[] {
    this.flushScratch();
    const out = this.out;
    this.out = [];
    this.outBytes = 0;
    return out;
  }

  private flushScratch(): void {
    if (this.pos === 0) return;
    let chunk: Buffer;
    if (this.pos < SCRATCH / 4) {
      // A few bytes (a hook's single key): copy them and keep the scratch.
      chunk = Buffer.from(this.buf.subarray(0, this.pos));
    } else {
      chunk = this.buf.subarray(0, this.pos);
      this.buf = Buffer.allocUnsafe(SCRATCH);
    }
    this.pos = 0;
    this.push(chunk);
  }

  private push(chunk: Buffer): void {
    if (this.ended) throw new Error('SnapshotWriter: write after end');
    this.crc.update(chunk);
    this.out.push(chunk);
    this.outBytes += chunk.length;
  }

  private ensure(n: number): void {
    if (this.pos + n > this.buf.length) this.flushScratch();
  }

  private byte(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b;
  }

  /** Unsigned LEB128. Plain arithmetic, not bit ops, so values past 2^31 stay exact. */
  private varint(n: number): void {
    this.ensure(10);
    while (n >= 0x80) {
      this.buf[this.pos++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.pos++] = n;
  }

  private string(s: string): void {
    this.varint(s.length);
    if (s.length >= BIG_STRING) {
      this.flushScratch();
      this.push(Buffer.from(s, 'latin1'));
      return;
    }
    this.ensure(s.length);
    this.pos += this.buf.write(s, this.pos, 'latin1');
  }

  private double(x: number): void {
    this.ensure(8);
    this.pos = this.buf.writeDoubleLE(x, this.pos);
  }

  /** Unix ms, little-endian, as two halves (deadlines are below 2^53). */
  private uint64(n: number): void {
    this.ensure(8);
    this.buf.writeUInt32LE(n % TWO_32, this.pos);
    this.buf.writeUInt32LE(Math.floor(n / TWO_32), this.pos + 4);
    this.pos += 8;
  }
}

/** Every key of every db, encoded at once: SAVE and DEBUG RELOAD (spec 9.8). */
export function encodeDataset(server: Server): Buffer[] {
  const writer = new SnapshotWriter(snapshotAux());
  for (const db of server.dbs) {
    db.forEachKey((key, obj, expireAt) => writer.writeKey(db.id, key, obj, expireAt));
  }
  writer.end();
  return writer.take();
}

/** The file can't be loaded; `offset` is where the problem was found. */
export class SnapshotLoadError extends Error {
  override readonly name = 'SnapshotLoadError';

  constructor(
    readonly offset: number,
    readonly detail: string,
  ) {
    super(`${detail} at offset ${offset}`);
  }
}

export interface LoadOptions {
  /** Skip keys whose deadline is before this (a primary, spec 9.9 step 4); null keeps them all. */
  now: number | null;
}

export interface LoadedSnapshot {
  /** Fresh databases, one per configured db; installSnapshot() swaps them in. */
  dbs: Db[];
  keys: number;
  expired: number;
  aux: Map<string, string>;
}

/** A bounds-checked cursor over the file, stopping short of the CRC. */
class Reader {
  pos = 0;

  constructor(
    private readonly data: Buffer,
    /** Records end here; the CRC follows. */
    private readonly limit: number,
  ) {}

  fail(detail: string, at = this.pos): never {
    throw new SnapshotLoadError(at, detail);
  }

  /** Throws unless `n` more bytes are there. */
  need(n: number, at = this.pos): void {
    if (n > this.limit - this.pos) this.fail('unexpected end of file', at);
  }

  byte(): number {
    this.need(1);
    return this.data[this.pos++]!;
  }

  /** LEB128, at most 8 bytes (56 bits; anything longer is damage, not a real length). */
  varint(): number {
    const start = this.pos;
    let n = 0;
    let scale = 1;
    for (let i = 0; ; i++) {
      if (i === 8) this.fail('invalid length', start);
      const b = this.byte();
      n += (b & 0x7f) * scale;
      if ((b & 0x80) === 0) return n;
      scale *= 0x80;
    }
  }

  /** A count of items each at least `minBytes` long: it can't promise more than the file holds. */
  count(minBytes: number, what: string): number {
    const start = this.pos;
    const n = this.varint();
    if (n === 0) this.fail(`empty ${what}`, start);
    if (n > (this.limit - this.pos) / minBytes) this.fail(`${what} longer than the file`, start);
    return n;
  }

  string(): string {
    const start = this.pos;
    const len = this.varint();
    this.need(len, start);
    const s = this.data.toString('latin1', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  double(): number {
    this.need(8);
    const x = this.data.readDoubleLE(this.pos);
    this.pos += 8;
    return x;
  }

  uint64(): number {
    this.need(8);
    const n = this.data.readUInt32LE(this.pos) + this.data.readUInt32LE(this.pos + 4) * TWO_32;
    this.pos += 8;
    return n;
  }
}

/**
 * Parses a whole snapshot into fresh databases for `server` (spec 11.2). Throws
 * SnapshotLoadError, with its offset, on anything that isn't exactly a file the writer could
 * have produced.
 */
export function readSnapshot(server: Server, data: Buffer, options: LoadOptions): LoadedSnapshot {
  const limit = data.length - CRC_BYTES;
  const r = new Reader(data, Math.max(limit, 0));
  if (data.length < HEADER.length) r.fail('unexpected end of file', data.length);
  if (data.toString('latin1', 0, MAGIC.length) !== MAGIC) r.fail('wrong signature', 0);
  const version = data.toString('latin1', MAGIC.length, HEADER.length);
  if (version !== VERSION) r.fail(`unsupported version '${version}'`, MAGIC.length);
  r.pos = HEADER.length;

  const dbs = server.dbs.map((_, i) => new Db(i, server));
  const aux = new Map<string, string>();
  let db = dbs[0]!;
  let expireAt = -1;
  let expireOffset = 0;
  let keys = 0;
  let expired = 0;
  for (;;) {
    const at = r.pos;
    const op = r.byte();
    if (op === OP_EOF) break;
    if (expireAt !== -1 && op > TYPE_HASH) r.fail('expiry not followed by a key', expireOffset);
    if (op === OP_AUX) {
      const name = r.string();
      aux.set(name, r.string());
    } else if (op === OP_SELECTDB) {
      const n = r.varint();
      if (n >= dbs.length) r.fail(`db index ${n} out of range`, at);
      db = dbs[n]!;
    } else if (op === OP_EXPIRETIME_MS) {
      expireAt = r.uint64();
      expireOffset = at;
    } else if (op <= TYPE_HASH) {
      const key = r.string();
      const obj = readValue(server, r, op);
      const live = expireAt === -1 || options.now === null || options.now <= expireAt;
      if (db.hasEntry(key)) r.fail('duplicate key', at);
      if (live) {
        db.load(key, obj, expireAt);
        keys++;
      } else {
        expired++;
      }
      expireAt = -1;
    } else {
      r.fail(`unknown record type ${op}`, at);
    }
  }
  if (expireAt !== -1) r.fail('expiry not followed by a key', expireOffset);
  if (r.pos !== limit) r.fail('data after the end marker', r.pos);
  const crc = new Crc64();
  crc.update(data.subarray(0, limit));
  if (!crc.matchesLE(data, limit)) r.fail('checksum mismatch', limit);
  return { dbs, keys, expired, aux };
}

function readValue(server: Server, r: Reader, type: number): RObj {
  const at = r.pos;
  switch (type) {
    case TYPE_STRING:
      return createStringObject(r.string());
    case TYPE_LIST: {
      const n = r.count(1, 'list');
      const list = createListObject(server.config.get('list-max-node-items'));
      for (let i = 0; i < n; i++) list.value.pushTail(r.string());
      return list;
    }
    case TYPE_SET: {
      const n = r.count(1, 'set');
      const set = createSetObject(server.dictOptions);
      for (let i = 0; i < n; i++) {
        if (!set.value.set(r.string(), true)) r.fail('duplicate set member', at);
      }
      return set;
    }
    case TYPE_ZSET: {
      const n = r.count(9, 'sorted set');
      const zset = createZsetObject(server.dictOptions, server.rng);
      for (let i = 0; i < n; i++) {
        const member = r.string();
        const score = r.double();
        if (Number.isNaN(score)) r.fail('NaN score', r.pos - 8);
        if (zset.value.add(member, score).outcome !== 'added') r.fail('duplicate member', at);
      }
      return zset;
    }
    default: {
      const n = r.count(2, 'hash');
      const hash = createHashObject(server.dictOptions);
      for (let i = 0; i < n; i++) {
        const field = r.string();
        if (!hash.value.set(field, r.string())) r.fail('duplicate hash field', at);
      }
      return hash;
    }
  }
}

/** Swaps loaded databases in for the server's own (spec 11.2: only once all of it checked out). */
export function installSnapshot(server: Server, loaded: LoadedSnapshot): void {
  server.dbs.forEach((db, i) => db.replaceData(loaded.dbs[i]!));
}

/**
 * SAVE (spec 9.8): the whole dataset, synchronously, through a temp file (rule 8). Returns
 * false, after logging why, if the file couldn't be written; the old file is then untouched.
 */
export function saveSnapshot(server: Server): boolean {
  const path = snapshotPath(server);
  const temp = tempSnapshotPath(server.config.get('dir'), ++server.snapshotSeq);
  try {
    writeFileAtomicSync(path, temp, encodeDataset(server));
  } catch (e) {
    server.log.warning(`Failed saving the DB: ${strerror(e)}`);
    return false;
  }
  server.dirty = 0;
  server.lastSave = Math.floor(Date.now() / 1000);
  server.lastBgsaveStatus = 'ok';
  server.log.notice('DB saved on disk');
  return true;
}

export interface FileLoadResult {
  keys: number;
  expired: number;
}

/**
 * Loads `path` into the server, replacing its data. Returns null if there's no file. Throws
 * SnapshotLoadError, already logged, if the file is damaged or can't be read; the data is then
 * left as it was.
 */
export function loadSnapshotFile(server: Server, path: string): FileLoadResult | null {
  const started = Date.now();
  let data: Buffer;
  try {
    data = fs.readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const err = new SnapshotLoadError(0, `can't read the file: ${strerror(e)}`);
    server.log.warning(`Fatal error loading the DB ${path}: ${err.message}`);
    throw err;
  }
  let loaded: LoadedSnapshot;
  try {
    loaded = readSnapshot(server, data, { now: Date.now() });
  } catch (e) {
    if (e instanceof SnapshotLoadError) {
      server.log.warning(`Bad snapshot file ${path}: ${e.message}. Not loading it.`);
    }
    throw e;
  }
  installSnapshot(server, loaded);
  // What was just loaded is already on disk.
  server.dirty = 0;
  const seconds = ((Date.now() - started) / 1000).toFixed(3);
  server.log.notice(`DB loaded from disk: ${seconds} seconds`);
  server.log.notice(
    `Done loading snapshot, keys loaded: ${loaded.keys}, keys expired: ${loaded.expired}.`,
  );
  return { keys: loaded.keys, expired: loaded.expired };
}

export type ReloadResult = 'ok' | 'save-failed' | 'load-failed';

/**
 * DEBUG RELOAD (spec 9.8): SAVE, then load the file back into fresh databases and swap them in.
 * A running job is aborted first: its point in time is about to be replaced. Unlike Redis,
 * which empties the data before loading, a failed load leaves the data as it was.
 */
export function reloadSnapshot(server: Server): ReloadResult {
  server.snapshotJob?.abort('DEBUG RELOAD');
  if (!saveSnapshot(server)) return 'save-failed';
  try {
    loadSnapshotFile(server, snapshotPath(server));
  } catch (e) {
    if (e instanceof SnapshotLoadError) return 'load-failed';
    throw e;
  }
  server.log.notice('DB reloaded by DEBUG RELOAD');
  return 'ok';
}
