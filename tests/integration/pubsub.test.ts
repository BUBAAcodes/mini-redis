// Step 17: pub/sub (spec 8.7, 9.11). Expected frames follow the redis:7.4 reference server.
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PropagationRecord } from '../../src/server/propagate.js';
import { RespError, TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer;
let pub: TestClient;
let sub: TestClient;
const records: PropagationRecord[] = [];

const SUBSCRIBER_ERROR = (cmd: string) =>
  `ERR Can't execute '${cmd}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`;

beforeAll(async () => {
  t = await startServer();
  t.server.propagator.attach({ append: (r) => records.push(r) });
  pub = await TestClient.connect(t.port);
});

beforeEach(async () => {
  sub = await TestClient.connect(t.port);
  records.length = 0;
});

// Each test gets fresh subscribers: wait until the previous one's are gone from the hub.
afterEach(async () => {
  sub.socket.destroy();
  await until(() => t.server.pubsub.channels().length === 0 && t.server.pubsub.numPat() === 0);
});

afterAll(async () => {
  pub.socket.destroy();
  await t.close();
});

const until = async (cond: () => Promise<boolean> | boolean): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition never became true');
};

/** Makes the server treat `client` as speaking RESP3 (HELLO arrives in step 22). */
async function useResp3(client: TestClient): Promise<void> {
  const id = (await client.call('CLIENT', 'ID')) as number;
  t.server.clients.get(id)!.reply.resp = 3;
}

describe('SUBSCRIBE and UNSUBSCRIBE', () => {
  it('confirms each channel with its running count, in exact RESP2 bytes', async () => {
    sub.send('SUBSCRIBE', 'a', 'b');
    expect(await sub.readRaw()).toBe('*3\r\n$9\r\nsubscribe\r\n$1\r\na\r\n:1\r\n');
    expect(await sub.readRaw()).toBe('*3\r\n$9\r\nsubscribe\r\n$1\r\nb\r\n:2\r\n');
  });

  it('does not count a repeated channel twice, but still confirms it', async () => {
    expect(await sub.call('SUBSCRIBE', 'a')).toEqual(['subscribe', 'a', 1]);
    expect(await sub.call('SUBSCRIBE', 'a')).toEqual(['subscribe', 'a', 1]);
  });

  it('counts channels and patterns together', async () => {
    expect(await sub.call('SUBSCRIBE', 'c')).toEqual(['subscribe', 'c', 1]);
    expect(await sub.call('PSUBSCRIBE', 'p*')).toEqual(['psubscribe', 'p*', 2]);
    expect(await sub.call('UNSUBSCRIBE', 'c')).toEqual(['unsubscribe', 'c', 1]);
    expect(await sub.call('PUNSUBSCRIBE', 'p*')).toEqual(['punsubscribe', 'p*', 0]);
  });

  it('UNSUBSCRIBE with no arguments leaves every channel, one reply each', async () => {
    sub.send('SUBSCRIBE', 'a', 'b');
    await sub.read();
    await sub.read();
    sub.send('UNSUBSCRIBE');
    expect(await sub.read()).toEqual(['unsubscribe', 'a', 1]);
    expect(await sub.read()).toEqual(['unsubscribe', 'b', 0]);
  });

  it('UNSUBSCRIBE with no subscriptions at all replies a nil channel and 0', async () => {
    expect(await sub.raw('UNSUBSCRIBE')).toBe('*3\r\n$11\r\nunsubscribe\r\n$-1\r\n:0\r\n');
    expect(await sub.raw('PUNSUBSCRIBE')).toBe('*3\r\n$12\r\npunsubscribe\r\n$-1\r\n:0\r\n');
  });

  it('UNSUBSCRIBE from a channel never joined still replies with the count', async () => {
    await sub.call('SUBSCRIBE', 'a');
    expect(await sub.call('UNSUBSCRIBE', 'zzz')).toEqual(['unsubscribe', 'zzz', 1]);
  });

  it('rejects SUBSCRIBE with no channel by arity', async () => {
    expect(await sub.call('SUBSCRIBE')).toEqual(
      new RespError("ERR wrong number of arguments for 'subscribe' command"),
    );
  });
});

describe('PUBLISH', () => {
  it('replies 0 when nobody listens', async () => {
    expect(await pub.call('PUBLISH', 'void', 'x')).toBe(0);
  });

  it('delivers message frames and counts receivers', async () => {
    const sub2 = await TestClient.connect(t.port);
    await sub.call('SUBSCRIBE', 'news');
    await sub2.call('SUBSCRIBE', 'news');
    expect(await pub.call('PUBLISH', 'news', 'hello')).toBe(2);
    expect(await sub.read()).toEqual(['message', 'news', 'hello']);
    expect(await sub2.read()).toEqual(['message', 'news', 'hello']);
    sub2.socket.destroy();
  });

  it('counts overlapping patterns once per matching subscription', async () => {
    await sub.call('SUBSCRIBE', 'news.1');
    await sub.call('PSUBSCRIBE', 'news.*');
    await sub.call('PSUBSCRIBE', 'n*');
    await sub.call('PSUBSCRIBE', 'sports.*');
    expect(await pub.call('PUBLISH', 'news.1', 'x')).toBe(3);
    expect(await sub.read()).toEqual(['message', 'news.1', 'x']);
    expect(await sub.read()).toEqual(['pmessage', 'news.*', 'news.1', 'x']);
    expect(await sub.read()).toEqual(['pmessage', 'n*', 'news.1', 'x']);
  });

  it('carries binary payloads untouched (spec 7.1)', async () => {
    const payload = '\xff\xfe\x00\r\n\x80';
    await sub.call('SUBSCRIBE', 'bin');
    await pub.call('PUBLISH', 'bin', payload);
    expect(await sub.read()).toEqual(['message', 'bin', payload]);
  });

  it('lets a client publish to itself in RESP3, message frame first', async () => {
    await useResp3(sub);
    await sub.call('SUBSCRIBE', 'me');
    sub.send('PUBLISH', 'me', 'self');
    expect(await sub.read()).toEqual(['message', 'me', 'self']);
    expect(await sub.read()).toBe(1);
  });

  it('stops delivering after UNSUBSCRIBE', async () => {
    await sub.call('SUBSCRIBE', 'a');
    await sub.call('UNSUBSCRIBE', 'a');
    expect(await pub.call('PUBLISH', 'a', 'x')).toBe(0);
  });

  it('stops delivering after the subscriber disconnects', async () => {
    await sub.call('SUBSCRIBE', 'gone');
    await sub.call('PSUBSCRIBE', 'g*');
    sub.socket.destroy();
    await until(async () => (await pub.call('PUBLISH', 'gone', 'x')) === 0);
    expect(await pub.call('PUBSUB', 'NUMPAT')).toBe(0);
  });

  it('is propagated to replicas only, even with no receivers and no data change', async () => {
    await pub.call('PUBLISH', 'c', 'm');
    await pub.call('SET', 'prop:k', 'v');
    expect(records).toEqual([
      { db: 0, argv: ['PUBLISH', 'c', 'm'], replicasOnly: true },
      { db: 0, argv: ['SET', 'prop:k', 'v'] },
    ]);
  });
});

describe('RESP2 subscriber mode', () => {
  it('refuses other commands with the subscriber-mode error', async () => {
    await sub.call('SUBSCRIBE', 'a');
    expect(await sub.call('GET', 'k')).toEqual(new RespError(SUBSCRIBER_ERROR('get')));
    expect(await sub.call('PUBLISH', 'a', 'x')).toEqual(new RespError(SUBSCRIBER_ERROR('publish')));
  });

  it('allows (P)SUBSCRIBE, (P)UNSUBSCRIBE, PING and QUIT', async () => {
    await sub.call('SUBSCRIBE', 'a');
    expect(await sub.call('PSUBSCRIBE', 'p')).toEqual(['psubscribe', 'p', 2]);
    expect(await sub.call('PUNSUBSCRIBE', 'p')).toEqual(['punsubscribe', 'p', 1]);
    expect(await sub.call('QUIT')).toBe('OK');
    await sub.closed;
  });

  it('answers PING with ["pong", ""] and ["pong", arg]', async () => {
    await sub.call('SUBSCRIBE', 'a');
    expect(await sub.raw('PING')).toBe('*2\r\n$4\r\npong\r\n$0\r\n\r\n');
    expect(await sub.call('PING', 'hi')).toEqual(['pong', 'hi']);
  });

  it('checks arity before the mode, and unknown commands first of all', async () => {
    await sub.call('SUBSCRIBE', 'a');
    expect(await sub.call('GET')).toEqual(
      new RespError("ERR wrong number of arguments for 'get' command"),
    );
    expect(await sub.call('NOSUCH')).toEqual(
      new RespError("ERR unknown command 'NOSUCH', with args beginning with: "),
    );
  });

  it('returns to normal mode once the last subscription is gone', async () => {
    await sub.call('SUBSCRIBE', 'a');
    await sub.call('PSUBSCRIBE', 'p');
    await sub.call('UNSUBSCRIBE', 'a');
    expect(await sub.call('GET', 'k')).toEqual(new RespError(SUBSCRIBER_ERROR('get')));
    await sub.call('PUNSUBSCRIBE', 'p');
    expect(await sub.call('GET', 'nokey')).toBe(null);
    expect(await sub.call('PING')).toBe('PONG');
  });
});

describe('RESP3', () => {
  it('sends confirmations and messages as push frames and allows every command', async () => {
    await useResp3(sub);
    expect(await sub.raw('SUBSCRIBE', 'a')).toBe('>3\r\n$9\r\nsubscribe\r\n$1\r\na\r\n:1\r\n');
    expect(await sub.call('GET', 'nokey')).toBe(null);
    expect(await sub.raw('PING')).toBe('+PONG\r\n');
    await pub.call('PUBLISH', 'a', 'x');
    expect(await sub.readRaw()).toBe('>3\r\n$7\r\nmessage\r\n$1\r\na\r\n$1\r\nx\r\n');
  });

  it('sends pmessage as a 4-item push and a nil UNSUBSCRIBE as _', async () => {
    await useResp3(sub);
    await sub.call('PSUBSCRIBE', 'p*');
    await pub.call('PUBLISH', 'pq', 'x');
    expect(await sub.readRaw()).toBe('>4\r\n$8\r\npmessage\r\n$2\r\np*\r\n$2\r\npq\r\n$1\r\nx\r\n');
    const other = await TestClient.connect(t.port);
    await useResp3(other);
    expect(await other.raw('UNSUBSCRIBE')).toBe('>3\r\n$11\r\nunsubscribe\r\n_\r\n:0\r\n');
    other.socket.destroy();
  });
});

describe('PUBSUB', () => {
  it('CHANNELS lists active channels, optionally by glob; patterns do not count', async () => {
    await sub.call('SUBSCRIBE', 'foo', 'bar');
    await sub.call('PSUBSCRIBE', 'zzz*');
    const all = (await pub.call('PUBSUB', 'CHANNELS')) as string[];
    expect(all.sort()).toEqual(['bar', 'foo']);
    expect(await pub.call('PUBSUB', 'CHANNELS', 'f*')).toEqual(['foo']);
    expect(await pub.call('PUBSUB', 'CHANNELS', 'nomatch*')).toEqual([]);
  });

  it('NUMSUB replies a flat channel/count list, counting channel subscribers only', async () => {
    await sub.call('SUBSCRIBE', 'foo');
    await sub.call('PSUBSCRIBE', 'f*');
    expect(await pub.call('PUBSUB', 'NUMSUB', 'foo', 'nope')).toEqual(['foo', 1, 'nope', 0]);
    expect(await pub.call('PUBSUB', 'NUMSUB')).toEqual([]);
  });

  it('NUMPAT counts distinct patterns', async () => {
    const sub2 = await TestClient.connect(t.port);
    await sub.call('PSUBSCRIBE', 'a*', 'b*');
    await sub2.call('PSUBSCRIBE', 'a*');
    expect(await pub.call('PUBSUB', 'NUMPAT')).toBe(2);
    sub2.socket.destroy();
  });

  it("rejects CHANNELS with two patterns using Redis's legacy text", async () => {
    expect(await pub.call('PUBSUB', 'CHANNELS', 'a', 'b')).toEqual(
      new RespError(
        "ERR unknown subcommand or wrong number of arguments for 'CHANNELS'. Try PUBSUB HELP.",
      ),
    );
  });

  it('rejects an unknown subcommand', async () => {
    expect(await pub.call('PUBSUB', 'FOO')).toEqual(
      new RespError("ERR unknown subcommand 'FOO'. Try PUBSUB HELP."),
    );
  });
});

describe('with ioredis', () => {
  it('delivers messages and pmessages to a subscriber connection', async () => {
    const subscriber = new Redis({ port: t.port, host: '127.0.0.1', maxRetriesPerRequest: 0 });
    const publisher = new Redis({ port: t.port, host: '127.0.0.1', maxRetriesPerRequest: 0 });
    try {
      const messages: [string, string, string?][] = [];
      subscriber.on('message', (ch: string, m: string) => messages.push(['message', ch, m]));
      subscriber.on('pmessage', (p: string, ch: string, m: string) =>
        messages.push(['pmessage:' + p, ch, m]),
      );
      expect(await subscriber.subscribe('io:a', 'io:b')).toBe(2);
      expect(await subscriber.psubscribe('io:*')).toBe(3);
      expect(await publisher.publish('io:a', 'one')).toBe(2);
      expect(await publisher.publish('io:zzz', 'two')).toBe(1);
      await until(() => messages.length === 3);
      expect(messages).toEqual([
        ['message', 'io:a', 'one'],
        ['pmessage:io:*', 'io:a', 'one'],
        ['pmessage:io:*', 'io:zzz', 'two'],
      ]);
      expect(await subscriber.unsubscribe('io:a', 'io:b')).toBe(1);
    } finally {
      subscriber.disconnect();
      publisher.disconnect();
    }
  });
});
