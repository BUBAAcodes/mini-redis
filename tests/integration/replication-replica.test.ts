// Step 21: the replica side of replication (spec 9.13), driven by a fake primary on a raw
// socket: the handshake, loading the full-sync payload, applying the stream with byte-exact
// offsets, ACKs, reconnecting with PSYNC, read-only mode, hiding expired keys, REPLICAOF and
// promotion. Replies were checked against the redis:7.4 reference.
import { afterEach, describe, expect, it } from 'vitest';
import { encodeDataset } from '../../src/persistence/snapshot-format.js';
import { FakePrimary, payloadFrame } from '../helpers/fake-primary.js';
import type { FakeLink } from '../helpers/fake-primary.js';
import { FakeReplica } from '../helpers/fake-replica.js';
import { RespError, TestClient, encodeCommand } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

const open: Array<TestServer | TestClient | FakePrimary | FakeReplica> = [];

afterEach(async () => {
  for (const thing of open.splice(0).reverse()) {
    if (thing instanceof TestClient) thing.socket.destroy();
    else await thing.close();
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cmd = (...argv: string[]): string => encodeCommand(argv);
const err = (message: string): RespError => new RespError(message);

const REPLID = 'a'.repeat(40);
const OTHER_ID = 'b'.repeat(40);

async function boot(directives: Record<string, string> = {}): Promise<[TestServer, TestClient]> {
  const t = await startServer(directives);
  open.push(t);
  const c = await TestClient.connect(t.port);
  open.push(c);
  return [t, c];
}

async function fakePrimary(): Promise<FakePrimary> {
  const p = await FakePrimary.start();
  open.push(p);
  return p;
}

async function info(c: TestClient, section: string): Promise<Record<string, string>> {
  const text = String(await c.call('INFO', section));
  const out: Record<string, string> = {};
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

const linkUp = async (c: TestClient): Promise<boolean> =>
  (await info(c, 'replication')).master_link_status === 'up';

/** A snapshot payload of whatever `fill` writes into a scratch server, and its digest. */
async function payloadOf(fill: (c: TestClient) => Promise<void>): Promise<[Buffer, string]> {
  const [t, c] = await boot();
  await fill(c);
  const digest = String(await c.call('DEBUG', 'DIGEST'));
  return [Buffer.concat(encodeDataset(t.server)), digest];
}

const emptyPayload = async (): Promise<Buffer> => (await payloadOf(async () => {}))[0];

/**
 * A replica of a fake primary, fully synced at `offset` with an empty dataset (or `payload`):
 * the link is up when this resolves.
 */
async function syncedReplica(
  directives: Record<string, string> = {},
  { offset = 1000, payload }: { offset?: number; payload?: Buffer } = {},
): Promise<{ t: TestServer; c: TestClient; primary: FakePrimary; link: FakeLink }> {
  const primary = await fakePrimary();
  const [t, c] = await boot(directives);
  expect(await c.call('REPLICAOF', '127.0.0.1', String(primary.port))).toBe('OK');
  const link = await primary.accept();
  await link.handshake();
  link.fullSync(REPLID, offset, payload ?? (await emptyPayload()));
  await until(() => linkUp(c));
  return { t, c, primary, link };
}

describe('the handshake (spec 9.13)', () => {
  it('sends PING, REPLCONF listening-port and capa psync2, then PSYNC ? -1 the first time', async () => {
    const primary = await fakePrimary();
    const [t, c] = await boot();
    expect(await c.call('REPLICAOF', '127.0.0.1', String(primary.port))).toBe('OK');
    const link = await primary.accept();
    expect(await link.handshake()).toEqual([
      ['PING'],
      ['REPLCONF', 'listening-port', String(t.port)],
      ['REPLCONF', 'capa', 'psync2'],
      ['PSYNC', '?', '-1'],
    ]);
    // Waiting for PSYNC's answer is still the handshake, and there is no offset yet.
    expect(await c.call('ROLE')).toEqual(['slave', '127.0.0.1', primary.port, 'handshake', -1]);
    const repl = await info(c, 'replication');
    expect(repl).toMatchObject({
      role: 'slave',
      master_host: '127.0.0.1',
      master_port: String(primary.port),
      master_link_status: 'down',
      master_sync_in_progress: '0',
      slave_read_only: '1',
    });
    expect(t.logs.some((l) => / \d+:S .*Connecting to MASTER 127\.0\.0\.1:\d+/.test(` ${l}`))).toBe(
      true,
    );
  });

  it('sends AUTH <masterauth> after PING, and takes -NOAUTH as an answer to the PING', async () => {
    const primary = await fakePrimary();
    const [, c] = await boot({ masterauth: 'sekret' });
    await c.call('REPLICAOF', '127.0.0.1', String(primary.port));
    const link = await primary.accept();
    expect(await link.next()).toEqual(['PING']);
    link.write('-NOAUTH Authentication required.\r\n');
    expect(await link.next()).toEqual(['AUTH', 'sekret']);
    link.write('+OK\r\n');
    expect((await link.next())[0]).toBe('REPLCONF');
  });

  it('gives up on a failed AUTH and tries again within a second or two', async () => {
    const primary = await fakePrimary();
    const [t, c] = await boot({ masterauth: 'wrong' });
    await c.call('REPLICAOF', '127.0.0.1', String(primary.port));
    const link = await primary.accept();
    expect(await link.next()).toEqual(['PING']);
    link.write('+PONG\r\n');
    expect(await link.next()).toEqual(['AUTH', 'wrong']);
    link.write('-WRONGPASS invalid username-password pair or user is disabled.\r\n');
    await link.closed;
    const again = await primary.accept(3000);
    expect(await again.next()).toEqual(['PING']);
    expect(t.logs.some((l) => l.includes('Unable to AUTH to MASTER'))).toBe(true);
  });

  it('carries on when the primary rejects the REPLCONFs, as they are not critical', async () => {
    const primary = await fakePrimary();
    const [, c] = await boot();
    await c.call('REPLICAOF', '127.0.0.1', String(primary.port));
    const link = await primary.accept();
    expect(await link.next()).toEqual(['PING']);
    link.write('+PONG\r\n');
    for (let i = 0; i < 2; i++) {
      expect((await link.next())[0]).toBe('REPLCONF');
      link.write("-ERR unknown command 'REPLCONF'\r\n");
    }
    expect(await link.next()).toEqual(['PSYNC', '?', '-1']);
  });

  it('opens the link at startup when replicaof is set', async () => {
    const primary = await fakePrimary();
    const [, c] = await boot({ replicaof: `127.0.0.1 ${primary.port}` });
    const link = await primary.accept();
    expect((await link.handshake()).at(-1)).toEqual(['PSYNC', '?', '-1']);
    expect((await info(c, 'replication')).role).toBe('slave');
    expect(await c.call('CONFIG', 'GET', 'replicaof')).toEqual([
      'replicaof',
      `127.0.0.1 ${primary.port}`,
    ]);
  });

  it('retries when the primary can not serve a PSYNC yet', async () => {
    const primary = await fakePrimary();
    const [, c] = await boot();
    await c.call('REPLICAOF', '127.0.0.1', String(primary.port));
    const link = await primary.accept();
    await link.handshake();
    link.write("-NOMASTERLINK Can't SYNC while not connected with my master\r\n");
    await link.closed;
    const again = await primary.accept(3000);
    expect((await again.handshake()).at(-1)).toEqual(['PSYNC', '?', '-1']);
  });
});

describe('full sync (spec 9.13)', () => {
  it('skips keepalive newlines, loads the payload, then applies the stream after it', async () => {
    const binary = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join('');
    const [payload, digest] = await payloadOf(async (s) => {
      await s.call('SET', binary, binary);
      await s.call('RPUSH', 'l', 'a', 'b');
      await s.call('HSET', 'h', 'f', 'v');
      await s.call('SADD', 's', 'm');
      await s.call('ZADD', 'z', '1.5', 'm');
      await s.call('SELECT', '3');
      await s.call('SET', 'ttl', 'v', 'EX', '1000');
    });
    const primary = await fakePrimary();
    const [t, c] = await boot();
    await c.call('SET', 'old', 'gone after the sync');
    await c.call('REPLICAOF', '127.0.0.1', String(primary.port));
    const link = await primary.accept();
    await link.handshake();
    // Keepalives come before the PSYNC answer and before the payload.
    link.write('\n\n');
    link.write(`+FULLRESYNC ${REPLID} 1000\r\n`);
    link.write('\n');
    await sleep(50);
    expect(await c.call('ROLE')).toEqual(['slave', '127.0.0.1', primary.port, 'sync', -1]);
    expect((await info(c, 'replication')).master_sync_in_progress).toBe('1');
    // The payload and the first stream bytes in one chunk.
    const stream = cmd('SELECT', '0') + cmd('SET', 'after', '1');
    link.write(Buffer.concat([payloadFrame(payload), Buffer.from(stream, 'latin1')]));
    await until(() => linkUp(c));
    await until(async () => (await c.call('GET', 'after')) === '1');
    expect(await c.call('GET', 'old')).toBeNull();
    const repl = await info(c, 'replication');
    expect(repl).toMatchObject({
      role: 'slave',
      master_link_status: 'up',
      master_sync_in_progress: '0',
      master_replid: REPLID,
      master_repl_offset: String(1000 + stream.length),
      slave_repl_offset: String(1000 + stream.length),
      repl_backlog_active: '1',
      repl_backlog_first_byte_offset: '1001',
      repl_backlog_histlen: String(stream.length),
    });
    expect(await c.call('ROLE')).toEqual([
      'slave',
      '127.0.0.1',
      primary.port,
      'connected',
      1000 + stream.length,
    ]);
    expect(await c.call('GET', binary)).toBe(binary);
    await c.call('SELECT', '3');
    expect(Number(await c.call('TTL', 'ttl'))).toBeGreaterThan(990);
    // Without the stream's key the dataset is exactly the payload's.
    link.write(cmd('DEL', 'after'));
    await until(async () => (await c.call('EXISTS', 'after')) === 0);
    expect(await c.call('DEBUG', 'DIGEST')).toBe(digest);
    expect(t.logs.some((l) => l.includes('MASTER <-> REPLICA sync: Finished with success'))).toBe(
      true,
    );
  });

  it('reads the reply, payload and stream in tiny chunks, with byte-exact offsets', async () => {
    const [payload] = await payloadOf(async (s) => {
      for (let i = 0; i < 50; i++) await s.call('SET', `k${i}`, 'v'.repeat(i));
    });
    const primary = await fakePrimary();
    const [, c] = await boot();
    await c.call('REPLICAOF', '127.0.0.1', String(primary.port));
    const link = await primary.accept();
    await link.handshake();
    link.socket.setNoDelay(true);
    let stream = cmd('SELECT', '0');
    for (let i = 0; i < 20; i++) stream += cmd('RPUSH', 'list', `item${i}`, '\r\n\x00\xff');
    stream += cmd('PING');
    const all = Buffer.concat([
      Buffer.from(`+FULLRESYNC ${REPLID} 7\r\n`, 'latin1'),
      payloadFrame(payload),
      Buffer.from(stream, 'latin1'),
    ]);
    for (let i = 0; i < all.length; i += 7) {
      link.write(all.subarray(i, i + 7));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await until(
      async () => (await info(c, 'replication')).slave_repl_offset === String(7 + stream.length),
    );
    expect(await c.call('LLEN', 'list')).toBe(40);
    expect(await c.call('LINDEX', 'list', '-1')).toBe('\r\n\x00\xff');
    expect(await c.call('DBSIZE')).toBe(51);
  });

  it('drops a payload with a bad checksum, keeps its data, and syncs again', async () => {
    const [payload] = await payloadOf(async (s) => {
      await s.call('SET', 'theirs', 'v');
    });
    const bad = Buffer.from(payload);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
    const primary = await fakePrimary();
    const [t, c] = await boot();
    await c.call('SET', 'mine', 'kept');
    await c.call('REPLICAOF', '127.0.0.1', String(primary.port));
    const link = await primary.accept();
    await link.handshake();
    link.fullSync(REPLID, 1000, bad);
    await link.closed;
    expect(await c.call('GET', 'mine')).toBe('kept');
    expect(await c.call('EXISTS', 'theirs')).toBe(0);
    expect(t.logs.some((l) => l.includes('Failed trying to load the MASTER synchronization'))).toBe(
      true,
    );
    // No history was taken from the bad sync, so it asks for a full one again.
    const again = await primary.accept(3000);
    expect((await again.handshake()).at(-1)).toEqual(['PSYNC', '?', '-1']);
    again.fullSync(REPLID, 1000, payload);
    await until(() => linkUp(c));
    expect(await c.call('GET', 'theirs')).toBe('v');
  });

  it('refuses a payload header that is not $<len>', async () => {
    const primary = await fakePrimary();
    const [, c] = await boot();
    await c.call('REPLICAOF', '127.0.0.1', String(primary.port));
    const link = await primary.accept();
    await link.handshake();
    link.write(`+FULLRESYNC ${REPLID} 1000\r\n$EOF:${'x'.repeat(40)}\r\n`);
    await link.closed;
    expect((await info(c, 'replication')).master_link_status).toBe('down');
  });

  it('rewrites its AOF after a full sync, and the stream reaches the AOF', async () => {
    const [payload] = await payloadOf(async (s) => {
      await s.call('HSET', 'h', 'a', '1', 'b', '2');
      await s.call('SET', 'n', '10');
    });
    const { c, link } = await syncedReplica({ appendonly: 'yes' }, { payload });
    await until(async () => (await info(c, 'persistence')).aof_rewrite_in_progress === '0');
    link.write(cmd('SELECT', '0') + cmd('INCRBY', 'n', '5'));
    await until(async () => (await c.call('GET', 'n')) === '15');
    const digest = await c.call('DEBUG', 'DIGEST');
    expect(await c.call('DEBUG', 'LOADAOF')).toBe('OK');
    expect(await c.call('DEBUG', 'DIGEST')).toBe(digest);
    expect(await c.call('HGET', 'h', 'b')).toBe('2');
  });
});

describe('the stream (spec 9.13, steady state)', () => {
  it('answers REPLCONF GETACK with its offset before it, then ACKs every second', async () => {
    const { link } = await syncedReplica();
    const getack = cmd('REPLCONF', 'GETACK', '*');
    link.write(getack);
    expect(await link.nextAck()).toBe(1000);
    // The periodic ACK counts the GETACK too.
    expect(await link.ackReaching(1000 + getack.length, 2500)).toBe(1000 + getack.length);
  });

  it('never replies to the primary, not even to an error', async () => {
    const { c, link } = await syncedReplica();
    link.write(cmd('SET', 'a', '1') + cmd('GET', 'a') + cmd('PING') + cmd('NOSUCHCOMMAND', 'x'));
    link.write(cmd('LPUSH', 'a', 'x')); // WRONGTYPE
    await until(async () => (await c.call('GET', 'a')) === '1');
    const seen: string[][] = [];
    const deadline = Date.now() + 1300;
    while (Date.now() < deadline) {
      try {
        seen.push(await link.next(deadline - Date.now()));
      } catch {
        break;
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const argv of seen) expect(argv.slice(0, 2)).toEqual(['REPLCONF', 'ACK']);
    // The raw socket got nothing but those ACKs: no '+OK', '$1', '-ERR'.
  });

  it('counts a transaction only at EXEC, so a link dropped mid-MULTI resumes at MULTI', async () => {
    const { c, primary, link, t } = await syncedReplica();
    const tx = cmd('MULTI') + cmd('SET', 'x', '1');
    link.write(tx);
    await sleep(100);
    expect((await info(c, 'replication')).slave_repl_offset).toBe('1000');
    await link.close();
    // A lost link is retried at once, from the first byte it doesn't have.
    const again = await primary.accept(3000);
    expect((await again.handshake()).at(-1)).toEqual(['PSYNC', REPLID, '1001']);
    expect(await c.call('EXISTS', 'x')).toBe(0);
    again.write(`+CONTINUE ${REPLID}\r\n`);
    const full = tx + cmd('EXEC');
    again.write(full);
    await until(async () => (await c.call('GET', 'x')) === '1');
    expect((await info(c, 'replication')).slave_repl_offset).toBe(String(1000 + full.length));
    expect(t.logs.some((l) => l.includes('Successful partial resynchronization with master'))).toBe(
      true,
    );
  });

  it('keeps the db the stream was in across a partial resync, as no SELECT is resent', async () => {
    const { c, primary, link } = await syncedReplica();
    const stream = cmd('SELECT', '3') + cmd('SET', 'a', '1');
    link.write(stream);
    await c.call('SELECT', '3');
    await until(async () => (await c.call('GET', 'a')) === '1');
    await link.close();
    const again = await primary.accept(3000);
    expect((await again.handshake()).at(-1)).toEqual([
      'PSYNC',
      REPLID,
      String(1001 + stream.length),
    ]);
    again.write(`+CONTINUE ${REPLID}\r\n` + cmd('SET', 'b', '2'));
    await until(async () => (await c.call('GET', 'b')) === '2');
    await c.call('SELECT', '0');
    expect(await c.call('EXISTS', 'b')).toBe(0);
  });

  it('keeps the old replication ID as replid2 when +CONTINUE names a new one', async () => {
    const { c, primary, link } = await syncedReplica();
    link.write(cmd('SET', 'a', '1'));
    await until(async () => (await c.call('GET', 'a')) === '1');
    const offset = 1000 + cmd('SET', 'a', '1').length;
    await link.close();
    const again = await primary.accept(3000);
    expect((await again.handshake()).at(-1)).toEqual(['PSYNC', REPLID, String(offset + 1)]);
    again.write(`+CONTINUE ${OTHER_ID}\r\n`);
    await until(() => linkUp(c));
    expect(await info(c, 'replication')).toMatchObject({
      master_replid: OTHER_ID,
      master_replid2: REPLID,
      second_repl_offset: String(offset + 1),
      master_repl_offset: String(offset),
    });
  });

  it('reconnects with PSYNC from its offset after CLIENT KILL TYPE master', async () => {
    const { c, primary } = await syncedReplica();
    expect(await c.call('CLIENT', 'KILL', 'TYPE', 'master')).toBe(1);
    const again = await primary.accept(3000);
    expect((await again.handshake()).at(-1)).toEqual(['PSYNC', REPLID, '1001']);
  });

  it('drops a link that stays silent for repl-timeout seconds, then reconnects', async () => {
    const { c, primary, link, t } = await syncedReplica();
    expect(await c.call('CONFIG', 'SET', 'repl-timeout', '1')).toBe('OK');
    await link.closed; // within about two seconds: nothing arrives from the primary
    expect(t.logs.some((l) => l.includes('MASTER timeout'))).toBe(true);
    await primary.accept(3000);
  });
});

describe('read-only and expiry on a replica (spec 9.3, rule 13)', () => {
  it('rejects writes from clients with -READONLY, in MULTI too, but serves reads', async () => {
    const primary = await fakePrimary();
    const [, c] = await boot();
    await c.call('REPLICAOF', '127.0.0.1', String(primary.port));
    const readonly = err("READONLY You can't write against a read only replica.");
    expect(await c.call('SET', 'a', '1')).toEqual(readonly);
    expect(await c.call('BLPOP', 'l', '0')).toEqual(readonly);
    expect(await c.call('MULTI')).toBe('OK');
    expect(await c.call('SET', 'a', '1')).toEqual(readonly);
    expect(await c.call('EXEC')).toEqual(
      err('EXECABORT Transaction discarded because of previous errors.'),
    );
    expect(await c.call('GET', 'a')).toBeNull();
    expect(await c.call('PUBLISH', 'ch', 'm')).toBe(0);
    expect(await c.call('CONFIG', 'SET', 'replica-read-only', 'no')).toBe('OK');
    expect(await c.call('SET', 'a', '1')).toBe('OK');
  });

  it("hides a key whose TTL passed until the primary's DEL arrives", async () => {
    const { c, link } = await syncedReplica();
    const at = String(Date.now() + 150);
    link.write(cmd('SELECT', '0') + cmd('SET', 'k', 'v', 'PXAT', at));
    link.write(cmd('RPUSH', 'l', 'a') + cmd('PEXPIREAT', 'l', at));
    await until(async () => (await c.call('DBSIZE')) === 2);
    await sleep(250);
    expect(await c.call('GET', 'k')).toBeNull();
    expect(await c.call('TTL', 'k')).toBe(-2);
    expect(await c.call('EXISTS', 'k', 'l')).toBe(0);
    expect(await c.call('TYPE', 'k')).toBe('none');
    expect(await c.call('LRANGE', 'l', '0', '-1')).toEqual([]);
    expect(await c.call('KEYS', '*')).toEqual([]);
    expect(await c.call('SCAN', '0')).toEqual(['0', []]);
    // Every key is hidden; RANDOMKEY still answers rather than spinning, as Redis does.
    expect(['k', 'l']).toContain(await c.call('RANDOMKEY'));
    // Still stored: the replica waits for its primary (rule 7).
    expect(await c.call('DBSIZE')).toBe(2);
    expect((await info(c, 'stats')).expired_keys).toBe('0');
    link.write(cmd('DEL', 'k') + cmd('DEL', 'l'));
    await until(async () => (await c.call('DBSIZE')) === 0);
  });

  it("applies the primary's commands to a key it hides from clients", async () => {
    const { c, link } = await syncedReplica();
    link.write(cmd('SELECT', '0') + cmd('SET', 'k', 'v', 'PXAT', String(Date.now() + 50)));
    await sleep(150);
    expect(await c.call('GET', 'k')).toBeNull();
    // For the primary the key is still there (its clock may be behind ours).
    link.write(cmd('APPEND', 'k', 'x') + cmd('PERSIST', 'k'));
    await until(async () => (await c.call('GET', 'k')) === 'vx');
    // A deadline that has already passed here is kept, not acted on: the DEL will follow.
    link.write(cmd('PEXPIREAT', 'k', String(Date.now() - 1000)));
    await until(async () => (await c.call('GET', 'k')) === null);
    expect(await c.call('DBSIZE')).toBe(1);
  });
});

describe('REPLICAOF, ROLE, WAIT and PSYNC on a replica (spec 8.10)', () => {
  it('replies to REPLICAOF and SLAVEOF as Redis 7.4 does', async () => {
    const primary = await fakePrimary();
    const [, c] = await boot();
    for (const port of ['abc', '70000', '-1']) {
      expect(await c.call('REPLICAOF', '127.0.0.1', port)).toEqual(err('ERR Invalid master port'));
    }
    expect(await c.call('REPLICAOF', 'no', 'two')).toEqual(err('ERR Invalid master port'));
    expect(await c.call('REPLICAOF', 'NO', 'ONE')).toBe('OK');
    expect(await c.call('SLAVEOF', '127.0.0.1', String(primary.port))).toBe('OK');
    expect(await c.call('REPLICAOF', '127.0.0.1', String(primary.port))).toBe(
      'OK Already connected to specified master',
    );
    expect(await c.call('REPLICAOF', 'a', 'b', 'c')).toEqual(
      err("ERR wrong number of arguments for 'replicaof' command"),
    );
  });

  it('refuses WAIT, and PSYNC while its own link is down', async () => {
    const primary = await fakePrimary();
    const [, c] = await boot();
    await c.call('REPLICAOF', '127.0.0.1', String(primary.port));
    expect(await c.call('WAIT', '1', '0')).toEqual(
      err(
        'ERR WAIT cannot be used with replica instances. Please also note that since Redis 4.0 if a replica is configured to be writable (which is not the default) writes to replicas are just local and are not propagated.',
      ),
    );
    expect(await c.call('PSYNC', '?', '-1')).toEqual(
      err("NOMASTERLINK Can't SYNC while not connected with my master"),
    );
  });

  it('refuses replicas of its own: no chained replication', async () => {
    const { t } = await syncedReplica();
    const r = await FakeReplica.handshake(t.port);
    open.push(r);
    expect(await r.command('PSYNC', '?', '-1')).toBe(
      '-ERR MiniRedis does not support chained replication: connect to the primary instead',
    );
  });

  it('REPLICAOF NO ONE promotes: keeps the data, shifts the replication ID, takes writes', async () => {
    const { c, link, t } = await syncedReplica();
    const stream = cmd('SELECT', '0') + cmd('SET', 'a', '1');
    link.write(stream);
    await until(async () => (await c.call('GET', 'a')) === '1');
    const offset = 1000 + stream.length;
    expect(await c.call('REPLICAOF', 'NO', 'ONE')).toBe('OK');
    await link.closed;
    const repl = await info(c, 'replication');
    expect(repl).toMatchObject({
      role: 'master',
      master_replid2: REPLID,
      second_repl_offset: String(offset + 1),
      master_repl_offset: String(offset),
    });
    expect(repl.master_replid).not.toBe(REPLID);
    expect(await c.call('ROLE')).toEqual(['master', offset, []]);
    expect(await c.call('SET', 'b', '2')).toBe('OK');
    expect(await c.call('GET', 'a')).toBe('1');
    expect(await c.call('CONFIG', 'GET', 'replicaof')).toEqual(['replicaof', '']);
    expect(t.logs.some((l) => l.includes('MASTER MODE enabled'))).toBe(true);
    expect(t.logs.at(-1)).toMatch(/^\d+:M /);
  });

  it('REPLICAOF on a primary disconnects its replicas and offers its own history', async () => {
    const [t, c] = await boot({ 'repl-ping-replica-period': '3600' });
    const r = await FakeReplica.synced(t.port);
    open.push(r);
    await c.call('SET', 'k', 'v');
    const repl = await info(c, 'replication');
    const primary = await fakePrimary();
    expect(await c.call('REPLICAOF', '127.0.0.1', String(primary.port))).toBe('OK');
    await r.closed;
    const link = await primary.accept();
    expect((await link.handshake()).at(-1)).toEqual([
      'PSYNC',
      repl.master_replid!,
      String(Number(repl.master_repl_offset) + 1),
    ]);
  });
});
