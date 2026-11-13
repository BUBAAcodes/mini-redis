// Step 12: the AOF end to end (spec 9.6, 9.9, 11.1): writes reach the file before their
// replies, a restart or DEBUG LOADAOF rebuilds the same dataset, and damaged files are handled
// as Redis 7.4 handles them. DEBUG LOADAOF's replies were checked against the reference.
import fs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../../src/config.js';
import { AofLoadError, encodeCommand } from '../../src/persistence/aof.js';
import { Server } from '../../src/server/server.js';
import { Generator } from '../differential/generator.js';
import { TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let dir: string;
const open: Array<TestServer | TestClient> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'miniredis-aof-it-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const thing of open.splice(0).reverse()) {
    if (thing instanceof TestClient) thing.socket.destroy();
    else await thing.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const aofPath = () => join(dir, 'appendonly.aof');

async function boot(directives: Record<string, string> = {}): Promise<[TestServer, TestClient]> {
  const t = await startServer({ dir, appendonly: 'yes', ...directives });
  open.push(t);
  const c = await TestClient.connect(t.port);
  open.push(c);
  return [t, c];
}

/** Closes a server started by boot() (and its client), keeping the dir for the next one. */
async function stop(t: TestServer, c: TestClient): Promise<void> {
  c.socket.destroy();
  await t.close();
  open.splice(open.indexOf(c), 1);
  open.splice(open.indexOf(t), 1);
}

describe('writing', () => {
  it('appends each write as the propagated record, with SELECT, and nothing for reads', async () => {
    const [, c] = await boot();
    await c.call('SET', 'a', '1');
    await c.call('GET', 'a');
    await c.call('SELECT', '2');
    await c.call('SET', 'b', '2', 'EX', '100');
    await c.call('DEL', 'missing');
    const text = readFileSync(aofPath(), 'latin1');
    expect(text.startsWith(encodeCommand(['SELECT', '0']) + encodeCommand(['SET', 'a', '1']))).toBe(
      true,
    );
    expect(text).toContain(encodeCommand(['SELECT', '2']));
    expect(text).toMatch(/\$4\r\nPXAT\r\n\$13\r\n\d{13}\r\n$/);
    expect(text).not.toContain('GET');
    expect(text).not.toContain('missing');
  });

  it('with appendonly no, writes no file', async () => {
    const t = await startServer({ dir, appendonly: 'no' });
    open.push(t);
    const c = await TestClient.connect(t.port);
    open.push(c);
    await c.call('SET', 'a', '1');
    expect(existsSync(aofPath())).toBe(false);
  });

  it('with appendfsync always, the fsync comes before the reply is written', async () => {
    const [t, c] = await boot({ appendfsync: 'always' });
    const fsync = vi.spyOn(fs, 'fsyncSync');
    const write = vi.spyOn(net.Socket.prototype, 'write');
    await c.call('SET', 'a', '1');
    const replyCall = write.mock.contexts.findIndex(
      (socket, i) =>
        (socket as net.Socket).localPort === t.port &&
        String(write.mock.calls[i]![0]).includes('+OK'),
    );
    expect(replyCall).toBeGreaterThanOrEqual(0);
    expect(fsync).toHaveBeenCalledTimes(1);
    expect(fsync.mock.invocationCallOrder[0]!).toBeLessThan(
      write.mock.invocationCallOrder[replyCall]!,
    );
    // Reads write nothing, so they fsync nothing.
    await c.call('GET', 'a');
    expect(fsync).toHaveBeenCalledTimes(1);
  });

  it('a failing write rejects writes and PING with -MISCONF until a write succeeds', async () => {
    const [, c] = await boot({ appendfsync: 'everysec', hz: '50' });
    const write = vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });
    // The command already ran when its AOF write failed: it keeps its reply, as in Redis.
    expect(await c.call('SET', 'a', '1')).toBe('OK');
    const misconf = '-MISCONF Errors writing to the AOF file: No space left on device\r\n';
    expect(await c.raw('SET', 'b', '2')).toBe(misconf);
    expect(await c.raw('PING')).toBe(misconf);
    expect(await c.call('GET', 'a')).toBe('1');
    // Queued inside MULTI, a write is refused at once and dooms the transaction.
    await c.call('MULTI');
    expect(await c.raw('SET', 'c', '3')).toBe(misconf);
    expect(await c.raw('EXEC')).toBe(
      '-EXECABORT Transaction discarded because of previous errors.\r\n',
    );
    write.mockRestore();
    // serverCron retries the buffered write even with no traffic.
    await vi.waitFor(async () => expect(await c.call('PING')).toBe('PONG'));
    expect(await c.call('SET', 'b', '2')).toBe('OK');
    expect(readFileSync(aofPath(), 'latin1')).toBe(
      encodeCommand(['SELECT', '0']) +
        encodeCommand(['SET', 'a', '1']) +
        encodeCommand(['SET', 'b', '2']),
    );
  });
});

describe('restart and DEBUG LOADAOF', () => {
  it('a restart keeps every type, TTLs and binary data', async () => {
    let [t, c] = await boot();
    const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
    await c.call('SET', binary, binary);
    await c.call('RPUSH', 'l', 'a', 'b');
    await c.call('HSET', 'h', 'f', 'v');
    await c.call('SADD', 's', 'm');
    await c.call('ZADD', 'z', '1.5', 'm');
    await c.call('SELECT', '5');
    await c.call('SET', 'ttl', 'v', 'EX', '1000');
    const digest = await c.call('DEBUG', 'DIGEST');
    await stop(t, c);
    [t, c] = await boot();
    expect(await c.call('DEBUG', 'DIGEST')).toBe(digest);
    expect(await c.call('GET', binary)).toBe(binary);
    await c.call('SELECT', '5');
    expect(Number(await c.call('TTL', 'ttl'))).toBeGreaterThan(990);
    expect(t.logs.some((l) => l.includes('DB loaded from append only file'))).toBe(true);
  });

  it('a random mix with transactions and served BLPOPs reloads to the same digest', async () => {
    const [t, c] = await boot();
    const gen = new Generator(1234, new Set(t.server.commands.keys()));
    for (let round = 0; round < 10; round++) {
      const batch: string[][] = [];
      for (let i = 0; i < 300; i++) batch.push(gen.next());
      batch.push(...gen.drain());
      for (const argv of batch) c.send(...argv);
      for (let i = 0; i < batch.length; i++) await c.read();
    }
    // Served blocking pops propagate as plain pops after the push that fed them.
    await c.call('SELECT', '0');
    const waiter = await TestClient.connect(t.port);
    open.push(waiter);
    for (const cmd of [
      ['BLPOP', 'bl', '0'],
      ['BRPOP', 'bl', '0'],
      ['BLMOVE', 'bl', 'dst', 'LEFT', 'RIGHT', '0'],
    ]) {
      waiter.send(...cmd);
      await vi.waitFor(() => expect(t.server.waiters.blockedCount).toBe(1));
      await c.call('RPUSH', 'bl', 'x');
      await waiter.read();
    }
    expect(Number(await c.call('DBSIZE'))).toBeGreaterThan(0);
    const digest = await c.call('DEBUG', 'DIGEST');
    expect(digest).not.toBe('0'.repeat(40));
    expect(await c.call('DEBUG', 'LOADAOF')).toBe('OK');
    expect(await c.call('DEBUG', 'DIGEST')).toBe(digest);
  });

  it('a relative TTL keeps counting down across a reload', async () => {
    const [, c] = await boot();
    await c.call('SET', 'k', 'v');
    await c.call('EXPIRE', 'k', '100');
    await sleep(2000);
    expect(await c.call('DEBUG', 'LOADAOF')).toBe('OK');
    const ttl = Number(await c.call('TTL', 'k'));
    expect(ttl).toBeGreaterThan(90);
    expect(ttl).toBeLessThanOrEqual(98);
  });

  it('DEBUG LOADAOF flushes pending writes first, and resets watches on reloaded keys', async () => {
    const [t, c] = await boot();
    const other = await TestClient.connect(t.port);
    open.push(other);
    await c.call('SET', 'w', '1');
    await other.call('WATCH', 'w');
    // Pipelined: SET is still in the AOF buffer when DEBUG LOADAOF runs in the same turn.
    c.send('SET', 'late', 'v');
    c.send('DEBUG', 'LOADAOF');
    expect(await c.read()).toBe('OK');
    expect(await c.read()).toBe('OK');
    expect(await c.call('GET', 'late')).toBe('v');
    await other.call('MULTI');
    await other.call('GET', 'w');
    expect(await other.call('EXEC')).toBeNull();
  });

  it('DEBUG LOADAOF with no AOF empties the data and replies an error, as Redis does', async () => {
    const t = await startServer({ dir, appendonly: 'no' });
    open.push(t);
    const c = await TestClient.connect(t.port);
    open.push(c);
    await c.call('SET', 'a', '1');
    expect(await c.raw('DEBUG', 'LOADAOF')).toBe(
      '-ERR Error trying to load the AOF files, check server logs.\r\n',
    );
    expect(await c.call('DBSIZE')).toBe(0);
  });

  it('a bad file at DEBUG LOADAOF keeps what loaded before it, replies an error, stays up', async () => {
    const [, c] = await boot();
    await c.call('SET', 'a', '1');
    fs.appendFileSync(aofPath(), 'garbage\r\n' + encodeCommand(['SET', 'b', '2']), 'latin1');
    expect(await c.raw('DEBUG', 'LOADAOF')).toBe(
      '-ERR Error trying to load the AOF files, check server logs.\r\n',
    );
    expect(await c.call('GET', 'a')).toBe('1');
    expect(await c.call('GET', 'b')).toBeNull();
    expect(await c.call('PING')).toBe('PONG');
  });
});

describe('startup with a damaged AOF (spec 9.6, 9.9)', () => {
  it('a file cut off mid-command loads with a warning and is truncated', async () => {
    const good = encodeCommand(['SELECT', '0']) + encodeCommand(['SET', 'a', '1']);
    writeFileSync(aofPath(), good + encodeCommand(['SET', 'b', '2']).slice(0, 15), 'latin1');
    const [t, c] = await boot();
    expect(await c.call('GET', 'a')).toBe('1');
    expect(await c.call('GET', 'b')).toBeNull();
    expect(t.logs.some((l) => l.includes('aof-load-truncated is enabled'))).toBe(true);
    // Appending carries on from the truncation point, so the next start reads a clean file;
    // the first record after startup always carries a SELECT (spec 9.5).
    await c.call('SET', 'c', '3');
    expect(readFileSync(aofPath(), 'latin1')).toBe(
      good + encodeCommand(['SELECT', '0']) + encodeCommand(['SET', 'c', '3']),
    );
  });

  it('garbage mid-file stops startup with its byte offset', async () => {
    const good = encodeCommand(['SELECT', '0']) + encodeCommand(['SET', 'a', '1']);
    writeFileSync(aofPath(), good + 'garbage\r\n' + encodeCommand(['SET', 'b', '2']), 'latin1');
    const config = Config.fromDirectives(
      Object.entries({ port: '0', dir, appendonly: 'yes' }).map(([name, value]) => ({
        args: [name, value],
        where: 'test',
        line: '',
      })),
    );
    const logs: string[] = [];
    const server = new Server({ config, log: (l) => logs.push(l) });
    const started = server.start();
    await expect(started).rejects.toThrow(AofLoadError);
    await expect(started).rejects.toThrow(`offset ${good.length}`);
    expect(logs.some((l) => l.includes(' # ') && l.includes(`offset ${good.length}`))).toBe(true);
    // Nothing was touched: the file is exactly as it was.
    expect(statSync(aofPath()).size).toBe(
      good.length + 9 + encodeCommand(['SET', 'b', '2']).length,
    );
    await server.close();
  });
});
