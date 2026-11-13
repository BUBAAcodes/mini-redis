import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { command } from '../../src/commands/command.js';
import { ReplyError } from '../../src/protocol/errors.js';
import { RespError, TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer;
const clients: TestClient[] = [];
const connect = async (): Promise<TestClient> => {
  const c = await TestClient.connect(t.port);
  clients.push(c);
  return c;
};

beforeAll(async () => {
  t = await startServer();
  // Test-only commands, on this server's own table.
  t.server.commands.set(
    'boom',
    command('boom', 1, [], [0, 0, 0], () => {
      throw new TypeError('kaboom');
    }),
  );
  t.server.commands.set(
    'replyerror',
    command('replyerror', 1, [], [0, 0, 0], () => {
      throw new ReplyError('WRONGTYPE Operation against a key holding the wrong kind of value');
    }),
  );
});

afterAll(async () => {
  for (const c of clients) c.socket.destroy();
  await t.close();
});

describe('PING, ECHO and errors from the dispatcher', () => {
  it('PING and ECHO', async () => {
    const c = await connect();
    expect(await c.raw('PING')).toBe('+PONG\r\n');
    expect(await c.raw('ping', 'hi')).toBe('$2\r\nhi\r\n');
    expect(await c.raw('PING', 'a', 'b')).toBe(
      "-ERR wrong number of arguments for 'ping' command\r\n",
    );
    expect(await c.raw('ECHO', 'x\x00\xff')).toBe('$3\r\nx\x00\xff\r\n');
    expect(await c.raw('echo')).toBe("-ERR wrong number of arguments for 'echo' command\r\n");
  });

  it('unknown commands, with Redis 7.4 quoting and the trailing space', async () => {
    const c = await connect();
    expect(await c.raw('foo', 'a', 'b')).toBe(
      "-ERR unknown command 'foo', with args beginning with: 'a' 'b' \r\n",
    );
    expect(await c.raw('FOO')).toBe("-ERR unknown command 'FOO', with args beginning with: \r\n");
  });

  it('turns a ReplyError into its reply and a bug into -ERR internal error', async () => {
    const c = await connect();
    expect(await c.raw('replyerror')).toBe(
      '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n',
    );
    expect(await c.raw('boom')).toBe('-ERR internal error\r\n');
    expect(
      t.logs.some((l) => l.includes("Internal error running 'boom'") && l.includes('kaboom')),
    ).toBe(true);
    expect(await c.raw('PING')).toBe('+PONG\r\n'); // the server keeps going
  });
});

describe('QUIT', () => {
  it('replies OK, closes, and runs nothing pipelined after it', async () => {
    const c = await connect();
    c.write('*1\r\n$4\r\nQUIT\r\n*3\r\n$3\r\nSET\r\n$4\r\nquit\r\n$1\r\n1\r\n');
    expect(await c.readRaw()).toBe('+OK\r\n');
    await c.closed;
    expect(c.unread).toBe('');
    const d = await connect();
    expect(await d.raw('GET', 'quit')).toBe('$-1\r\n');
  });
});

describe('SELECT', () => {
  it('switches databases per client', async () => {
    const a = await connect();
    const b = await connect();
    expect(await a.raw('SELECT', '3')).toBe('+OK\r\n');
    await a.call('SET', 'k', 'in3');
    expect(await b.raw('GET', 'k')).toBe('$-1\r\n');
    await b.call('SELECT', '3');
    expect(await b.raw('GET', 'k')).toBe('$3\r\nin3\r\n');
    expect(t.server.dbs[3]!.size).toBe(1);
  });

  it('gives the Redis errors', async () => {
    const c = await connect();
    const notInt = '-ERR value is not an integer or out of range\r\n';
    expect(await c.raw('SELECT', 'abc')).toBe(notInt);
    expect(await c.raw('SELECT', '007')).toBe(notInt);
    expect(await c.raw('SELECT', '-0')).toBe(notInt);
    expect(await c.raw('SELECT', '99999999999999999999')).toBe(notInt);
    expect(await c.raw('SELECT', '2147483648')).toBe(
      '-ERR value is out of range, value must between -2147483648 and 2147483647\r\n',
    );
    expect(await c.raw('SELECT', '16')).toBe('-ERR DB index is out of range\r\n');
    expect(await c.raw('SELECT', '-1')).toBe('-ERR DB index is out of range\r\n');
  });
});

describe('CLIENT', () => {
  it('ID counts up and is unique per connection', async () => {
    const a = await connect();
    const b = await connect();
    const ida = (await a.call('CLIENT', 'ID')) as number;
    const idb = (await b.call('client', 'id')) as number;
    expect(idb).toBeGreaterThan(ida);
    expect(await a.call('CLIENT', 'ID')).toBe(ida);
  });

  it('SETNAME and GETNAME', async () => {
    const c = await connect();
    expect(await c.raw('CLIENT', 'GETNAME')).toBe('$-1\r\n');
    expect(await c.raw('CLIENT', 'SETNAME', '!~')).toBe('+OK\r\n');
    expect(await c.raw('CLIENT', 'GETNAME')).toBe('$2\r\n!~\r\n');
    expect(await c.raw('CLIENT', 'SETNAME', 'a b')).toBe(
      '-ERR Client names cannot contain spaces, newlines or special characters.\r\n',
    );
    expect(await c.raw('CLIENT', 'SETNAME', '\x7f')).toBe(
      '-ERR Client names cannot contain spaces, newlines or special characters.\r\n',
    );
    expect(await c.raw('CLIENT', 'SETNAME', '')).toBe('+OK\r\n');
    expect(await c.raw('CLIENT', 'GETNAME')).toBe('$-1\r\n');
  });

  it('SETINFO', async () => {
    const c = await connect();
    expect(await c.raw('CLIENT', 'SETINFO', 'lib-name', 'ioredis')).toBe('+OK\r\n');
    expect(await c.raw('CLIENT', 'SETINFO', 'LIB-VER', '6.0.0')).toBe('+OK\r\n');
    expect(await c.raw('CLIENT', 'SETINFO', 'LIB-VER', 'x\x00 y')).toBe('+OK\r\n'); // stops at NUL
    expect(await c.raw('CLIENT', 'SETINFO', 'LIB-NAME', 'a b')).toBe(
      '-ERR LIB-NAME cannot contain spaces, newlines or special characters.\r\n',
    );
    expect(await c.raw('CLIENT', 'SETINFO', 'bad', 'x')).toBe("-ERR Unrecognized option 'bad'\r\n");
  });

  it('arity and subcommand errors', async () => {
    const c = await connect();
    expect(await c.raw('CLIENT')).toBe("-ERR wrong number of arguments for 'client' command\r\n");
    expect(await c.raw('CLIENT', 'nope')).toBe(
      "-ERR unknown subcommand 'nope'. Try CLIENT HELP.\r\n",
    );
    expect(await c.raw('CLIENT', 'ID', 'x')).toBe(
      "-ERR wrong number of arguments for 'client|id' command\r\n",
    );
    expect(await c.raw('CLIENT', 'SETINFO', 'lib-name', 'a', 'b')).toBe(
      "-ERR wrong number of arguments for 'client|setinfo' command\r\n",
    );
  });
});

describe('the read path', () => {
  it('runs inline commands, with quoting', async () => {
    const c = await connect();
    c.write('PING\r\n');
    expect(await c.readRaw()).toBe('+PONG\r\n');
    c.write('SET inline "a b"\nGET inline\r\n');
    expect(await c.readRaw()).toBe('+OK\r\n');
    expect(await c.readRaw()).toBe('$3\r\na b\r\n');
  });

  it('answers a 1,000-command pipeline in order, in one write', async () => {
    const c = await connect();
    const id = (await c.call('CLIENT', 'ID')) as number;
    const socket = t.server.clients.get(id)!.socket;
    let writes = 0;
    const write = socket.write.bind(socket) as (...args: unknown[]) => boolean;
    socket.write = ((...args: unknown[]) => {
      writes++;
      return write(...args);
    }) as typeof socket.write;
    let pipeline = '';
    for (let i = 0; i < 1000; i++)
      pipeline += `*2\r\n$4\r\nECHO\r\n$${String(i).length}\r\n${i}\r\n`;
    c.write(pipeline);
    for (let i = 0; i < 1000; i++) expect(await c.read()).toBe(String(i));
    expect(writes).toBe(1);
  });

  it('replies to a protocol error, then closes', async () => {
    const c = await connect();
    c.write('PING\r\n*abc\r\n');
    expect(await c.readRaw()).toBe('+PONG\r\n');
    expect(await c.readRaw()).toBe('-ERR Protocol error: invalid multibulk length\r\n');
    await c.closed;
  });

  it('closes a client past client-query-buffer-limit without a reply', async () => {
    const c = await connect();
    await c.call('CONFIG', 'SET', 'client-query-buffer-limit', '1mb');
    // An inline line can't grow past 64 KB, so use a bulk that never ends.
    c.write('*2\r\n$4\r\nECHO\r\n$2000000\r\n');
    c.write(Buffer.alloc(1_200_000, 0x61));
    await c.closed;
    expect(c.unread).toBe('');
    expect(
      t.logs.some((l) => l.includes('Closing client that reached max query buffer length')),
    ).toBe(true);
    const d = await connect();
    await d.call('CONFIG', 'SET', 'client-query-buffer-limit', '256mb');
  });

  it('keeps every client separate', async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => connect()));
    const replies = await Promise.all(all.map((c, i) => c.call('ECHO', `client-${i}`)));
    expect(replies).toEqual(all.map((_, i) => `client-${i}`));
  });

  it('decodes errors in the test client', async () => {
    const c = await connect();
    expect(await c.call('nosuch')).toBeInstanceOf(RespError);
  });
});
