// The AOF sink and loader (spec 9.6, 11.1), driven on a server that never listens. Behaviour on
// truncated and malformed files follows Redis's loadSingleAppendOnlyFile (aof.c).
import fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../../src/config.js';
import { Aof, AofLoadError, encodeCommand, loadAof } from '../../src/persistence/aof.js';
import { Server } from '../../src/server/server.js';

let dir: string;
let path: string;
let logs: string[];

const newServer = (directives: Record<string, string> = {}): Server => {
  const config = Config.fromDirectives(
    Object.entries({ dir, ...directives }).map(([name, value]) => ({
      args: [name, value],
      where: 'in a test',
      line: `${name} ${value}`,
    })),
  );
  return new Server({ config, log: (line) => logs.push(line), seed: 1 });
};

const cmd = (...argv: string[]) => encodeCommand(argv);
const get = (server: Server, db: number, key: string) => {
  const obj = server.dbs[db]!.peek(key);
  return obj === null ? null : obj.value;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'miniredis-aof-'));
  path = join(dir, 'appendonly.aof');
  logs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('encoding (spec 11.1)', () => {
  it('writes a RESP array of bulk strings, byte for byte', () => {
    expect(cmd('SET', 'user:1', 'alice')).toBe(
      '*3\r\n$3\r\nSET\r\n$6\r\nuser:1\r\n$5\r\nalice\r\n',
    );
    expect(cmd('SET', '', '\xff\x00\r\n')).toBe(
      '*3\r\n$3\r\nSET\r\n$0\r\n\r\n$4\r\n\xff\x00\r\n\r\n',
    );
  });
});

describe('the sink', () => {
  it('starts with SELECT, adds one whenever the db changes, and skips replicas-only records', () => {
    const server = newServer();
    const aof = new Aof(server, path);
    aof.append({ db: 0, argv: ['SET', 'a', '1'] });
    aof.append({ db: 0, argv: ['PUBLISH', 'ch', 'm'], replicasOnly: true });
    aof.append({ db: 0, argv: ['SET', 'b', '2'] });
    aof.append({ db: 2, argv: ['DEL', 'a'] });
    aof.append({ db: 0, argv: ['DEL', 'b'] });
    expect(readFileSync(path, 'latin1')).toBe('');
    aof.flush();
    expect(readFileSync(path, 'latin1')).toBe(
      cmd('SELECT', '0') +
        cmd('SET', 'a', '1') +
        cmd('SET', 'b', '2') +
        cmd('SELECT', '2') +
        cmd('DEL', 'a') +
        cmd('SELECT', '0') +
        cmd('DEL', 'b'),
    );
    expect(aof.size).toBe(readFileSync(path).length);
    aof.close();
  });

  it('appends to an existing file and counts its size', () => {
    writeFileSync(path, cmd('SELECT', '0') + cmd('SET', 'a', '1'), 'latin1');
    const aof = new Aof(newServer(), path);
    const before = aof.size;
    aof.append({ db: 1, argv: ['SET', 'b', '2'] });
    aof.flush();
    expect(readFileSync(path, 'latin1')).toBe(
      cmd('SELECT', '0') + cmd('SET', 'a', '1') + cmd('SELECT', '1') + cmd('SET', 'b', '2'),
    );
    expect(aof.size).toBe(before + (cmd('SELECT', '1') + cmd('SET', 'b', '2')).length);
    aof.close();
  });

  it('fsyncs once per flush under always, never under everysec or no', () => {
    for (const [policy, expected] of [
      ['always', 1],
      ['everysec', 0],
      ['no', 0],
    ] as const) {
      const server = newServer({ appendfsync: policy });
      const aof = new Aof(server, path);
      const fsync = vi.spyOn(fs, 'fsyncSync');
      aof.append({ db: 0, argv: ['SET', 'a', '1'] });
      aof.append({ db: 0, argv: ['SET', 'b', '1'] });
      aof.flush();
      aof.flush(); // nothing new: no second fsync
      expect(fsync, policy).toHaveBeenCalledTimes(expected);
      fsync.mockRestore();
      aof.close();
    }
  });

  it('everysec fsyncs from cron in the background, at most once a second', async () => {
    const server = newServer({ appendfsync: 'everysec' });
    const aof = new Aof(server, path);
    const fsync = vi.spyOn(fs, 'fsync');
    aof.cron(10_000);
    expect(fsync).not.toHaveBeenCalled(); // nothing written yet
    aof.append({ db: 0, argv: ['SET', 'a', '1'] });
    aof.flush();
    aof.cron(10_000);
    expect(fsync).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(aof.fsyncInFlight).toBe(false));
    aof.append({ db: 0, argv: ['SET', 'b', '1'] });
    aof.flush();
    aof.cron(10_500); // under a second since the last one
    expect(fsync).toHaveBeenCalledTimes(1);
    aof.cron(11_000);
    expect(fsync).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(aof.fsyncInFlight).toBe(false));
    aof.close();
  });

  it('a failed write keeps the buffer, reports the error, and a later flush recovers', () => {
    const server = newServer({ appendfsync: 'everysec' });
    const aof = new Aof(server, path);
    aof.append({ db: 0, argv: ['SET', 'a', '1'] });
    const write = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });
    aof.flush();
    expect(aof.error).toBe('No space left on device');
    expect(readFileSync(path, 'latin1')).toBe('');
    expect(logs.some((l) => l.includes(' # ') && l.includes('No space left on device'))).toBe(true);
    write.mockRestore();
    aof.flush();
    expect(aof.error).toBeNull();
    expect(readFileSync(path, 'latin1')).toBe(cmd('SELECT', '0') + cmd('SET', 'a', '1'));
    aof.close();
  });

  it('a short write is truncated away, so the file never holds half a command', () => {
    const server = newServer({ appendfsync: 'everysec' });
    const aof = new Aof(server, path);
    aof.append({ db: 0, argv: ['SET', 'a', '1'] });
    aof.flush();
    const good = readFileSync(path, 'latin1');
    aof.append({ db: 0, argv: ['SET', 'b', '2'] });
    const real = fs.writeSync.bind(fs) as (fd: number, buf: Buffer, offset: number) => number;
    const write = vi
      .spyOn(fs, 'writeSync')
      .mockImplementationOnce(((fd: number, buf: Buffer, offset: number) =>
        real(fd, buf.subarray(0, offset + 5), offset)) as typeof fs.writeSync)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
      });
    aof.flush();
    expect(aof.error).toBe('Input/output error');
    expect(readFileSync(path, 'latin1')).toBe(good);
    write.mockRestore();
    aof.flush();
    expect(readFileSync(path, 'latin1')).toBe(good + cmd('SET', 'b', '2'));
    aof.close();
  });

  it('under always, a failed write is fatal', () => {
    const fatal = vi.fn();
    const config = Config.fromDirectives([
      { args: ['dir', dir], where: 'test', line: '' },
      { args: ['appendfsync', 'always'], where: 'test', line: '' },
    ]);
    const server = new Server({ config, log: (l) => logs.push(l), fatal });
    const aof = new Aof(server, path);
    aof.append({ db: 0, argv: ['SET', 'a', '1'] });
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    });
    aof.flush();
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("fsync policy is 'always'"))).toBe(true);
    aof.close();
  });
});

describe('loading (spec 9.6)', () => {
  it('replays commands, honours SELECT, runs transactions, and never propagates', () => {
    writeFileSync(
      path,
      cmd('SELECT', '0') +
        cmd('SET', 'a', '1') +
        cmd('SELECT', '3') +
        cmd('MULTI') +
        cmd('RPUSH', 'l', 'x', 'y') +
        cmd('INCR', 'n') +
        cmd('EXEC') +
        cmd('SET', 'gone', 'v', 'PXAT', '1'),
      'latin1',
    );
    const server = newServer();
    const records: unknown[] = [];
    server.propagator.attach({ append: (r) => records.push(r) });
    const result = loadAof(server, path);
    expect(result).toEqual({ exists: true, commands: 8, truncated: false });
    expect(get(server, 0, 'a')).toBe('1');
    expect(get(server, 3, 'n')).toBe('1');
    expect(server.dbs[3]!.peek('l')?.type).toBe('list');
    // Not expired while loading: it goes later, through expiry, with a propagated DEL.
    expect(server.dbs[3]!.hasEntry('gone')).toBe(true);
    expect(records).toEqual([]);
    expect(server.dirty).toBe(0);
    expect(server.stats.totalCommandsProcessed).toBe(0);
    expect(server.loading).toBe(false);
  });

  it('reports a missing file, and loads an empty one as empty', () => {
    expect(loadAof(newServer(), path)).toEqual({ exists: false, commands: 0, truncated: false });
    writeFileSync(path, '');
    expect(loadAof(newServer(), path)).toEqual({ exists: true, commands: 0, truncated: false });
  });

  it('a blocking pop in the file never waits', () => {
    writeFileSync(path, cmd('BLPOP', 'empty', '0') + cmd('SET', 'after', '1'), 'latin1');
    const server = newServer();
    loadAof(server, path);
    expect(server.waiters.blockedCount).toBe(0);
    expect(get(server, 0, 'after')).toBe('1');
  });

  it('a file cut off mid-command is truncated at the last complete command, with a warning', () => {
    const good = cmd('SELECT', '0') + cmd('SET', 'a', '1');
    writeFileSync(path, good + cmd('SET', 'b', '2').slice(0, 12), 'latin1');
    const server = newServer();
    expect(loadAof(server, path)).toEqual({ exists: true, commands: 2, truncated: true });
    expect(readFileSync(path, 'latin1')).toBe(good);
    expect(get(server, 0, 'a')).toBe('1');
    expect(get(server, 0, 'b')).toBeNull();
    expect(
      logs.some((l) => l.includes(`Truncating the AOF ${path} at offset ${good.length}`)),
    ).toBe(true);
  });

  it('a MULTI with no EXEC is truncated away from before the MULTI', () => {
    const good = cmd('SELECT', '0') + cmd('SET', 'a', '1');
    writeFileSync(
      path,
      good + cmd('MULTI') + cmd('SET', 'b', '2') + cmd('SET', 'c', '3'),
      'latin1',
    );
    const server = newServer();
    expect(loadAof(server, path).truncated).toBe(true);
    expect(readFileSync(path, 'latin1')).toBe(good);
    expect(get(server, 0, 'b')).toBeNull();
    expect(logs.some((l) => l.includes('Revert incomplete MULTI/EXEC transaction'))).toBe(true);
  });

  it('a truncated tail refuses to load with aof-load-truncated no', () => {
    const content = cmd('SET', 'a', '1') + '*3\r\n$3\r\nSET';
    writeFileSync(path, content, 'latin1');
    const server = newServer({ 'aof-load-truncated': 'no' });
    expect(() => loadAof(server, path)).toThrow(AofLoadError);
    expect(readFileSync(path, 'latin1')).toBe(content);
    expect(logs.some((l) => l.includes('Unexpected end of file'))).toBe(true);
  });

  it.each([
    ['bad framing', 'garbage\r\n'],
    ['a zero-length array', '*0\r\n'],
    ['a bad bulk header', '*1\r\n:3\r\n'],
  ])('%s mid-file refuses to load and names its byte offset', (_, bad) => {
    const good = cmd('SELECT', '0') + cmd('SET', 'a', '1');
    writeFileSync(path, good + bad + cmd('SET', 'b', '2'), 'latin1');
    const server = newServer();
    expect(() => loadAof(server, path)).toThrow(`offset ${good.length}`);
    expect(
      logs.some((l) => l.includes('Bad file format') && l.includes(`offset ${good.length}`)),
    ).toBe(true);
    expect(server.loading).toBe(false);
  });

  it('an unknown command or a wrong argument count refuses to load', () => {
    const good = cmd('SET', 'a', '1');
    writeFileSync(path, good + cmd('NOSUCH', 'x'), 'latin1');
    expect(() => loadAof(newServer(), path)).toThrow(`Unknown command 'NOSUCH'`);
    writeFileSync(path, good + cmd('GET'), 'latin1');
    expect(() => loadAof(newServer(), path)).toThrow(`offset ${good.length}`);
  });

  it('reads a file larger than one chunk', () => {
    let content = cmd('SELECT', '0');
    const big = 'v'.repeat(100_000);
    for (let i = 0; i < 30; i++) content += cmd('SET', `k${i}`, big);
    writeFileSync(path, content, 'latin1');
    const server = newServer();
    expect(loadAof(server, path).commands).toBe(31);
    expect(get(server, 0, 'k29')).toBe(big);
  });
});
