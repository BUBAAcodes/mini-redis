// AUTH, HELLO and RESET (spec 8.9, 9.2): every reply is checked as the exact bytes the
// reference Redis 7.4 gives (rule 3), including the order in which HELLO checks its arguments.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

const NOAUTH = '-NOAUTH Authentication required.\r\n';
const WRONGPASS = '-WRONGPASS invalid username-password pair or user is disabled.\r\n';
const NOAUTH_HELLO =
  '-NOAUTH HELLO must be called with the client already authenticated, otherwise the HELLO <proto> AUTH <user> <pass> option can be used to authenticate the client and select the RESP protocol version at the same time\r\n';

let open: TestServer;
let locked: TestServer;
const clients: TestClient[] = [];
const connect = async (t: TestServer): Promise<TestClient> => {
  const c = await TestClient.connect(t.port);
  clients.push(c);
  return c;
};

beforeAll(async () => {
  open = await startServer();
  locked = await startServer({ requirepass: 'secret' });
});

afterAll(async () => {
  for (const c of clients) c.socket.destroy();
  await open.close();
  await locked.close();
});

describe('AUTH', () => {
  it('without a password configured', async () => {
    const c = await connect(open);
    expect(await c.raw('AUTH', 'foo')).toBe(
      '-ERR AUTH <password> called without any password configured for the default user. Are you sure your configuration is correct?\r\n',
    );
    // The two-argument form: the default user has no password, so anything goes.
    expect(await c.raw('AUTH', 'default', 'foo')).toBe('+OK\r\n');
    expect(await c.raw('AUTH', 'a', 'b', 'c')).toBe('-ERR syntax error\r\n');
    expect(await c.raw('AUTH')).toBe("-ERR wrong number of arguments for 'auth' command\r\n");
  });

  it('refuses everything but AUTH, HELLO, QUIT and RESET until it succeeds', async () => {
    const c = await connect(locked);
    for (const argv of [['PING'], ['GET', 'a'], ['SELECT', '1'], ['CLIENT', 'ID'], ['MULTI']])
      expect(await c.raw(...argv)).toBe(NOAUTH);
    expect(await c.raw('AUTH', 'wrong')).toBe(WRONGPASS);
    expect(await c.raw('AUTH', 'default', 'wrong')).toBe(WRONGPASS);
    expect(await c.raw('AUTH', 'nouser', 'secret')).toBe(WRONGPASS);
    // One word is a password, even when it says "default".
    expect(await c.raw('AUTH', 'default')).toBe(WRONGPASS);
    expect(await c.raw('PING')).toBe(NOAUTH);
    expect(await c.raw('AUTH', 'secret')).toBe('+OK\r\n');
    expect(await c.raw('PING')).toBe('+PONG\r\n');
    // Once authenticated, AUTH can be repeated, and a wrong one doesn't log the client out.
    expect(await c.raw('AUTH', 'default', 'secret')).toBe('+OK\r\n');
    expect(await c.raw('AUTH', 'wrong')).toBe(WRONGPASS);
    expect(await c.raw('PING')).toBe('+PONG\r\n');
  });

  it('unknown commands and wrong arities are reported before NOAUTH', async () => {
    const c = await connect(locked);
    // Arity comes first (spec 9.1 step 3.2), then NOAUTH.
    expect(await c.raw('GET')).toBe("-ERR wrong number of arguments for 'get' command\r\n");
    expect(await c.raw('nosuch')).toMatch(/^-ERR unknown command 'nosuch'/);
  });

  it('QUIT works before AUTH', async () => {
    const c = await connect(locked);
    expect(await c.raw('QUIT')).toBe('+OK\r\n');
    await c.closed;
  });

  it('a password changed at runtime applies to new clients only', async () => {
    const t = await startServer();
    try {
      const old = await connect(t);
      expect(await old.raw('CONFIG', 'SET', 'requirepass', 'pw')).toBe('+OK\r\n');
      expect(await old.raw('PING')).toBe('+PONG\r\n');
      const fresh = await connect(t);
      expect(await fresh.raw('PING')).toBe(NOAUTH);
      expect(await fresh.raw('AUTH', 'pw')).toBe('+OK\r\n');
    } finally {
      await t.close();
    }
  });
});

describe('HELLO', () => {
  const helloMap = (proto: number, id: number): string =>
    `%7\r\n$6\r\nserver\r\n$5\r\nredis\r\n$7\r\nversion\r\n$5\r\n7.4.0\r\n$5\r\nproto\r\n:${proto}\r\n$2\r\nid\r\n:${id}\r\n$4\r\nmode\r\n$10\r\nstandalone\r\n$4\r\nrole\r\n$6\r\nmaster\r\n$7\r\nmodules\r\n*0\r\n`;
  const helloFlat = (proto: number, id: number): string =>
    `*14\r\n$6\r\nserver\r\n$5\r\nredis\r\n$7\r\nversion\r\n$5\r\n7.4.0\r\n$5\r\nproto\r\n:${proto}\r\n$2\r\nid\r\n:${id}\r\n$4\r\nmode\r\n$10\r\nstandalone\r\n$4\r\nrole\r\n$6\r\nmaster\r\n$7\r\nmodules\r\n*0\r\n`;

  it('switches protocol, and the reply to HELLO itself already uses the new one', async () => {
    const c = await connect(open);
    const id = Number(await c.call('CLIENT', 'ID'));
    expect(await c.raw('HELLO')).toBe(helloFlat(2, id));
    expect(await c.raw('HELLO', '3')).toBe(helloMap(3, id));
    expect(await c.raw('HELLO')).toBe(helloMap(3, id));
    expect(await c.raw('HELLO', '2')).toBe(helloFlat(2, id));
  });

  it('bad versions and bad options, in Redis order', async () => {
    const c = await connect(open);
    expect(await c.raw('HELLO', '4')).toBe('-NOPROTO unsupported protocol version\r\n');
    expect(await c.raw('HELLO', '0')).toBe('-NOPROTO unsupported protocol version\r\n');
    expect(await c.raw('HELLO', '-1')).toBe('-NOPROTO unsupported protocol version\r\n');
    expect(await c.raw('HELLO', 'foo')).toBe(
      '-ERR Protocol version is not an integer or out of range\r\n',
    );
    expect(await c.raw('HELLO', '3', 'foo')).toBe("-ERR Syntax error in HELLO option 'foo'\r\n");
    expect(await c.raw('HELLO', '3', 'auth', 'u')).toBe(
      "-ERR Syntax error in HELLO option 'auth'\r\n",
    );
    expect(await c.raw('HELLO', '3', 'setname')).toBe(
      "-ERR Syntax error in HELLO option 'setname'\r\n",
    );
    expect(await c.raw('HELLO', '3', 'setname', 'a b')).toBe(
      '-ERR Client names cannot contain spaces, newlines or special characters.\r\n',
    );
    // None of those changed the protocol (rule 4).
    expect(await c.raw('HGETALL', 'nokey')).toBe('*0\r\n');
  });

  it('SETNAME, and AUTH with any password when none is set', async () => {
    const c = await connect(open);
    await c.raw('HELLO', '2', 'AUTH', 'default', 'x', 'SETNAME', 'n');
    expect(await c.raw('CLIENT', 'GETNAME')).toBe('$1\r\nn\r\n');
  });

  it('authenticates a locked server and refuses to answer an unauthenticated HELLO', async () => {
    const c = await connect(locked);
    expect(await c.raw('HELLO', '3')).toBe(NOAUTH_HELLO);
    expect(await c.raw('HELLO')).toBe(NOAUTH_HELLO);
    // The version is checked before the credentials.
    expect(await c.raw('HELLO', '9', 'AUTH', 'default', 'secret')).toBe(
      '-NOPROTO unsupported protocol version\r\n',
    );
    expect(await c.raw('HELLO', '3', 'AUTH', 'default', 'bad')).toBe(WRONGPASS);
    expect(await c.raw('HELLO', '3', 'AUTH', 'nouser', 'secret')).toBe(WRONGPASS);
    expect(await c.raw('PING')).toBe(NOAUTH);
    // A bad name is reported ahead of a wrong password and ahead of NOAUTH, and a good
    // password doesn't stick when the name is refused (checked against Redis 7.4).
    const badName = '-ERR Client names cannot contain spaces, newlines or special characters.\r\n';
    expect(await c.raw('HELLO', '3', 'AUTH', 'default', 'bad', 'SETNAME', 'a b')).toBe(badName);
    expect(await c.raw('HELLO', '3', 'SETNAME', 'a b')).toBe(badName);
    expect(await c.raw('HELLO', '3', 'AUTH', 'default', 'secret', 'SETNAME', 'a b')).toBe(badName);
    expect(await c.raw('PING')).toBe(NOAUTH);
    const ok = await c.call('HELLO', '3', 'AUTH', 'default', 'secret', 'SETNAME', 'n');
    expect(ok).toBeInstanceOf(Map);
    expect(await c.raw('CLIENT', 'GETNAME')).toBe('$1\r\nn\r\n');
    expect(await c.raw('PING')).toBe('+PONG\r\n');
  });

  it('works inside MULTI as an ordinary queued command', async () => {
    const c = await connect(open);
    expect(await c.raw('MULTI')).toBe('+OK\r\n');
    expect(await c.raw('HELLO', '3')).toBe('+QUEUED\r\n');
    // Run by EXEC, so the map inside the array is already RESP3.
    expect((await c.raw('EXEC')).startsWith('*1\r\n%7\r\n')).toBe(true);
  });
});

describe('RESET', () => {
  it('returns the connection to its just-connected state', async () => {
    const c = await connect(open);
    await c.raw('HELLO', '3');
    await c.raw('SELECT', '3');
    await c.raw('CLIENT', 'SETNAME', 'zz');
    await c.raw('WATCH', 'k');
    await c.raw('MULTI');
    expect(await c.raw('RESET')).toBe('+RESET\r\n');
    expect(await c.raw('CLIENT', 'GETNAME')).toBe('$-1\r\n'); // RESP2 null again
    expect(await c.raw('EXEC')).toBe('-ERR EXEC without MULTI\r\n');
    // RESET put the connection back in db 0.
    expect(await c.raw('SET', 'rk', '1')).toBe('+OK\r\n');
    await c.raw('SELECT', '3');
    expect(await c.raw('GET', 'rk')).toBe('$-1\r\n');
    await c.raw('SELECT', '0');
    expect(await c.raw('DEL', 'rk')).toBe(':1\r\n');
  });

  it('leaves subscriber mode, and logs out a client of a locked server', async () => {
    const c = await connect(open);
    await c.raw('SUBSCRIBE', 'ch');
    expect(await c.raw('GET', 'a')).toMatch(/^-ERR Can't execute 'get': only .* RESET are allowed/);
    expect(await c.raw('RESET')).toBe('+RESET\r\n');
    expect(await c.raw('GET', 'a')).toBe('$-1\r\n');

    const d = await connect(locked);
    await d.raw('AUTH', 'secret');
    expect(await d.raw('RESET')).toBe('+RESET\r\n');
    expect(await d.raw('PING')).toBe(NOAUTH);
    // RESET itself works before AUTH.
    expect(await d.raw('RESET')).toBe('+RESET\r\n');
  });
});
