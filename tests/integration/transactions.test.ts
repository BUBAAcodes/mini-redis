// Step 16: MULTI, EXEC, DISCARD, WATCH and UNWATCH (spec 8.8, 9.10). Expected replies, including
// the two-client WATCH cases, were checked against the redis:7.4 reference server.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PropagationRecord } from '../../src/server/propagate.js';
import { TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer;
let a: TestClient;
let b: TestClient;
const records: PropagationRecord[] = [];

beforeAll(async () => {
  t = await startServer();
  t.server.propagator.attach({ append: (r) => records.push(r) });
  a = await TestClient.connect(t.port);
  b = await TestClient.connect(t.port);
});

beforeEach(async () => {
  await a.call('DEBUG', 'SET-ACTIVE-EXPIRE', '1');
  await a.call('FLUSHALL');
  await a.call('UNWATCH');
  records.length = 0;
});

afterAll(async () => {
  a.socket.destroy();
  b.socket.destroy();
  await t.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const argvs = () => records.map((r) => r.argv);
const EXECABORT = '-EXECABORT Transaction discarded because of previous errors.\r\n';

/** WATCH key, let `between` run, then MULTI, GET key, EXEC: returns EXEC's raw reply. */
async function watchedExec(key: string, between: () => Promise<unknown>): Promise<string> {
  expect(await a.raw('WATCH', key)).toBe('+OK\r\n');
  await between();
  expect(await a.raw('MULTI')).toBe('+OK\r\n');
  expect(await a.raw('GET', key)).toBe('+QUEUED\r\n');
  return a.raw('EXEC');
}

/** A key with a deadline that has passed but is still stored (active expiry off). */
async function deadKey(key: string): Promise<void> {
  await a.call('DEBUG', 'SET-ACTIVE-EXPIRE', '0');
  await a.call('SET', key, 'v', 'PX', '10');
  await sleep(30);
}

describe('MULTI and EXEC', () => {
  it('queues commands and replies with all their replies in one array', async () => {
    expect(await a.raw('MULTI')).toBe('+OK\r\n');
    expect(await a.raw('SET', 'k', '1')).toBe('+QUEUED\r\n');
    expect(await a.raw('INCR', 'k')).toBe('+QUEUED\r\n');
    expect(await a.raw('GET', 'k')).toBe('+QUEUED\r\n');
    expect(await a.raw('EXEC')).toBe('*3\r\n+OK\r\n:2\r\n$1\r\n2\r\n');
  });

  it('an empty transaction replies with an empty array', async () => {
    await a.call('MULTI');
    expect(await a.raw('EXEC')).toBe('*0\r\n');
  });

  it('a run-time error is one reply among the others; nothing rolls back', async () => {
    await a.call('MULTI');
    await a.call('SET', 's', 'x');
    await a.call('LPUSH', 's', 'y');
    await a.call('GET', 's');
    expect(await a.raw('EXEC')).toBe(
      '*3\r\n+OK\r\n-WRONGTYPE Operation against a key holding the wrong kind of value\r\n$1\r\nx\r\n',
    );
  });

  it('SELECT inside a transaction applies to the commands after it, and sticks', async () => {
    await a.call('MULTI');
    await a.call('SELECT', '2');
    await a.call('SET', 'z', '1');
    await a.call('SELECT', '99');
    expect(await a.raw('EXEC')).toBe('*3\r\n+OK\r\n+OK\r\n-ERR DB index is out of range\r\n');
    expect(await a.call('GET', 'z')).toBe('1');
    await a.call('SELECT', '0');
  });

  it('reads the clock once for the whole EXEC (spec 7.5)', async () => {
    await a.call('SET', 'k', 'v', 'PX', '50');
    await a.call('MULTI');
    await a.call('DEBUG', 'SLEEP', '0.1');
    await a.call('GET', 'k');
    expect(await a.call('EXEC')).toEqual(['OK', 'v']);
    expect(await a.call('GET', 'k')).toBeNull();
  });

  it('QUIT inside MULTI runs at once', async () => {
    const c = await TestClient.connect(t.port);
    await c.call('MULTI');
    expect(await c.raw('QUIT')).toBe('+OK\r\n');
    await c.closed;
  });
});

describe('errors', () => {
  it('EXEC and DISCARD without MULTI', async () => {
    expect(await a.raw('EXEC')).toBe('-ERR EXEC without MULTI\r\n');
    expect(await a.raw('DISCARD')).toBe('-ERR DISCARD without MULTI\r\n');
  });

  it('a nested MULTI is an error but keeps the transaction alive', async () => {
    await a.call('MULTI');
    expect(await a.raw('MULTI')).toBe('-ERR MULTI calls can not be nested\r\n');
    await a.call('SET', 'k', '1');
    expect(await a.raw('EXEC')).toBe('*1\r\n+OK\r\n');
  });

  it('WATCH inside MULTI is an error but keeps the transaction alive', async () => {
    await a.call('MULTI');
    expect(await a.raw('WATCH', 'k')).toBe('-ERR WATCH inside MULTI is not allowed\r\n');
    await a.call('SET', 'k', '1');
    expect(await a.raw('EXEC')).toBe('*1\r\n+OK\r\n');
  });

  it('an unknown command while queueing aborts the transaction', async () => {
    await a.call('MULTI');
    expect(await a.raw('NOSUCH')).toBe(
      "-ERR unknown command 'NOSUCH', with args beginning with: \r\n",
    );
    await a.call('SET', 'k', '1');
    expect(await a.raw('EXEC')).toBe(EXECABORT);
    expect(await a.call('GET', 'k')).toBeNull();
  });

  it('a wrong argument count while queueing aborts the transaction', async () => {
    await a.call('MULTI');
    expect(await a.raw('SET', 'k')).toBe("-ERR wrong number of arguments for 'set' command\r\n");
    expect(await a.raw('EXEC')).toBe(EXECABORT);
  });

  it('a bad subcommand or DISCARD with arguments also aborts it', async () => {
    await a.call('MULTI');
    expect(await a.raw('CONFIG', 'NOPE')).toMatch(/^-ERR unknown subcommand 'NOPE'/);
    expect(await a.raw('EXEC')).toBe(EXECABORT);
    await a.call('MULTI');
    expect(await a.raw('DISCARD', 'x')).toBe(
      "-ERR wrong number of arguments for 'discard' command\r\n",
    );
    expect(await a.raw('EXEC')).toBe(EXECABORT);
  });

  it('EXEC with arguments aborts at once with the reason, in or out of MULTI', async () => {
    const abort =
      "-EXECABORT Transaction discarded because of: wrong number of arguments for 'exec' command\r\n";
    await a.call('MULTI');
    await a.call('SET', 'k', '1');
    expect(await a.raw('EXEC', 'x')).toBe(abort);
    // The transaction is over: SET runs, and EXEC has nothing to execute.
    expect(await a.raw('SET', 'k', '2')).toBe('+OK\r\n');
    expect(await a.raw('EXEC')).toBe('-ERR EXEC without MULTI\r\n');
    expect(await a.raw('EXEC', 'x')).toBe(abort);
  });

  it('DISCARD drops the queue', async () => {
    await a.call('MULTI');
    await a.call('SET', 'k', '1');
    expect(await a.raw('DISCARD')).toBe('+OK\r\n');
    expect(await a.call('GET', 'k')).toBeNull();
    expect(await a.raw('EXEC')).toBe('-ERR EXEC without MULTI\r\n');
  });

  it('WATCH and UNWATCH check their argument counts', async () => {
    expect(await a.raw('WATCH')).toBe("-ERR wrong number of arguments for 'watch' command\r\n");
    expect(await a.raw('UNWATCH', 'x')).toBe(
      "-ERR wrong number of arguments for 'unwatch' command\r\n",
    );
  });
});

describe('WATCH', () => {
  it('EXEC returns a null array when another client changes a watched key', async () => {
    await a.call('SET', 'k', '1');
    expect(await watchedExec('k', () => b.call('SET', 'k', '1'))).toBe('*-1\r\n');
  });

  it("the client's own change counts too", async () => {
    expect(await watchedExec('k', () => a.call('SET', 'k', '2'))).toBe('*-1\r\n');
  });

  it('EXPIRE and RENAME onto the key are changes', async () => {
    await a.call('SET', 'k', '1');
    expect(await watchedExec('k', () => b.call('EXPIRE', 'k', '100'))).toBe('*-1\r\n');
    await a.call('SET', 'src', '1');
    expect(await watchedExec('dst', () => b.call('RENAME', 'src', 'dst'))).toBe('*-1\r\n');
  });

  it('writes that changed nothing are not changes', async () => {
    await a.call('SET', 'k', '1');
    expect(await watchedExec('k', () => b.call('SET', 'k', '9', 'NX'))).toBe('*1\r\n$1\r\n1\r\n');
    expect(await watchedExec('zz', () => b.call('DEL', 'zz'))).toBe('*1\r\n$-1\r\n');
  });

  it('only the watched db counts', async () => {
    await a.call('SELECT', '1');
    await a.call('WATCH', 'k');
    await a.call('SELECT', '0');
    await b.call('SET', 'k', '1');
    await a.call('MULTI');
    expect(await a.raw('EXEC')).toBe('*0\r\n');
  });

  it('FLUSHDB and FLUSHALL count for watched keys that existed', async () => {
    await a.call('SET', 'k', '1');
    expect(await watchedExec('k', () => b.call('FLUSHDB'))).toBe('*-1\r\n');
    await a.call('SET', 'k', '1');
    expect(await watchedExec('k', () => b.call('FLUSHALL'))).toBe('*-1\r\n');
    await a.call('SET', 'other', '1');
    expect(await watchedExec('missing', () => b.call('FLUSHALL'))).toBe('*1\r\n$-1\r\n');
  });

  it('flushing another db leaves the watch alone', async () => {
    await a.call('SET', 'k', '1');
    const flushOther = async () => {
      await b.call('SELECT', '1');
      await b.call('FLUSHDB');
      await b.call('SELECT', '0');
    };
    expect(await watchedExec('k', flushOther)).toBe('*1\r\n$1\r\n1\r\n');
  });

  it('a key that expires before EXEC counts as changed, lazily', async () => {
    await a.call('DEBUG', 'SET-ACTIVE-EXPIRE', '0');
    await a.call('SET', 'k', 'v', 'PX', '30');
    expect(await watchedExec('k', () => sleep(60))).toBe('*-1\r\n');
  });

  it('a key that expires before EXEC counts as changed, actively', async () => {
    await a.call('SET', 'k', 'v', 'PX', '30');
    const waitForCollection = async () => {
      for (let i = 0; i < 100 && t.server.dbs[0]!.size > 0; i++) await sleep(20);
      expect(t.server.dbs[0]!.size).toBe(0);
    };
    expect(await watchedExec('k', waitForCollection)).toBe('*-1\r\n');
  });

  it('a key already expired at WATCH time is no change when it is deleted', async () => {
    await deadKey('k');
    expect(await watchedExec('k', async () => {})).toBe('*1\r\n$-1\r\n');
    await deadKey('k');
    expect(await watchedExec('k', () => b.call('GET', 'k'))).toBe('*1\r\n$-1\r\n');
    await deadKey('k');
    expect(await watchedExec('k', () => b.call('FLUSHDB'))).toBe('*1\r\n$-1\r\n');
  });

  it('a key already expired at WATCH time that comes back is a change', async () => {
    await deadKey('k');
    expect(await watchedExec('k', () => b.call('SET', 'k', '2'))).toBe('*-1\r\n');
    await deadKey('k');
    const getThenSet = async () => {
      await b.call('GET', 'k');
      await b.call('SET', 'k', '3');
    };
    expect(await watchedExec('k', getThenSet)).toBe('*-1\r\n');
  });

  it('EXEC, DISCARD, an aborted EXEC and UNWATCH all unwatch', async () => {
    const afterwards = async (finish: () => Promise<unknown>) => {
      await a.call('WATCH', 'k');
      await finish();
      await b.call('SET', 'k', '5');
      await a.call('MULTI');
      return a.raw('EXEC');
    };
    expect(await afterwards(async () => (await a.call('MULTI'), a.call('EXEC')))).toBe('*0\r\n');
    expect(await afterwards(async () => (await a.call('MULTI'), a.call('DISCARD')))).toBe('*0\r\n');
    const aborted = async () => {
      await a.call('MULTI');
      await a.call('NOSUCH');
      expect(await a.raw('EXEC')).toBe(EXECABORT);
    };
    expect(await afterwards(aborted)).toBe('*0\r\n');
    expect(await afterwards(() => a.call('UNWATCH'))).toBe('*0\r\n');
  });

  it('UNWATCH also clears a change already seen', async () => {
    await a.call('WATCH', 'k');
    await b.call('SET', 'k', '1');
    await a.call('UNWATCH');
    await a.call('MULTI');
    expect(await a.raw('EXEC')).toBe('*0\r\n');
  });

  it('a dirty EXEC runs nothing, SELECT included', async () => {
    await a.call('WATCH', 'k');
    await b.call('SET', 'k', '1');
    await a.call('MULTI');
    await a.call('SELECT', '1');
    expect(await a.raw('EXEC')).toBe('*-1\r\n');
    expect(await a.raw('DBSIZE')).toBe(':1\r\n');
  });

  it('a disconnecting client leaves nothing in the registry', async () => {
    const c = await TestClient.connect(t.port);
    await c.call('WATCH', 'gone1', 'gone2');
    expect(t.server.dbs[0]!.watched.size).toBe(2);
    await c.close();
    for (let i = 0; i < 50 && t.server.dbs[0]!.watched.size > 0; i++) await sleep(10);
    expect(t.server.dbs[0]!.watched.size).toBe(0);
  });
});

describe('propagation (spec 9.5)', () => {
  it('an EXEC with writes propagates as MULTI, the writes, EXEC', async () => {
    await a.call('MULTI');
    await a.call('SET', 'a', '1');
    await a.call('GET', 'a');
    await a.call('INCR', 'b');
    await a.call('EXEC');
    expect(argvs()).toEqual([['MULTI'], ['SET', 'a', '1'], ['INCR', 'b'], ['EXEC']]);
  });

  it('keeps each record in the db it ran in', async () => {
    await a.call('MULTI');
    await a.call('SET', 'a', '1');
    await a.call('SELECT', '3');
    await a.call('SET', 'b', '1');
    await a.call('SELECT', '0');
    await a.call('EXEC');
    expect(records).toEqual([
      { db: 0, argv: ['MULTI'] },
      { db: 0, argv: ['SET', 'a', '1'] },
      { db: 3, argv: ['SET', 'b', '1'] },
      { db: 3, argv: ['EXEC'] },
    ]);
  });

  it('applies the usual rewrites, and puts a lazy-expiry DEL inside the transaction', async () => {
    await a.call('DEBUG', 'SET-ACTIVE-EXPIRE', '0');
    await a.call('SET', 'gone', 'v', 'PXAT', '1');
    records.length = 0;
    await a.call('MULTI');
    await a.call('GET', 'gone');
    await a.call('EXPIRE', 'k', '10');
    await a.call('SET', 'k', 'v', 'PXAT', '99999999999999');
    await a.call('EXEC');
    expect(argvs()).toEqual([
      ['MULTI'],
      ['DEL', 'gone'],
      ['SET', 'k', 'v', 'PXAT', '99999999999999'],
      ['EXEC'],
    ]);
  });

  it('propagates nothing for read-only, empty, discarded, aborted or dirty transactions', async () => {
    await a.call('MULTI');
    await a.call('GET', 'a');
    await a.call('EXEC');
    await a.call('MULTI');
    await a.call('EXEC');
    await a.call('MULTI');
    await a.call('SET', 'a', '1');
    await a.call('DISCARD');
    await a.call('MULTI');
    await a.call('SET', 'a', '1');
    await a.call('NOSUCH');
    await a.call('EXEC');
    await a.call('WATCH', 'w');
    await b.call('SET', 'w', '1');
    records.length = 0;
    await a.call('MULTI');
    await a.call('SET', 'a', '1');
    await a.call('EXEC');
    expect(records).toEqual([]);
  });
});

describe('under load', () => {
  it('50 clients running the transfer transaction keep A + B constant', async () => {
    const TOTAL = 1_000_000;
    await a.call('SET', 'A', String(TOTAL));
    await a.call('SET', 'B', '0');
    const clients = await Promise.all(Array.from({ length: 50 }, () => TestClient.connect(t.port)));
    let running = true;
    const sums: number[] = [];
    const checker = (async () => {
      while (running) {
        const [x, y] = (await b.call('MGET', 'A', 'B')) as [string, string];
        sums.push(Number(x) + Number(y));
      }
    })();
    await Promise.all(
      clients.map(async (c, i) => {
        for (let round = 0; round < 40; round++) {
          const n = String(1 + ((i * 7 + round) % 13));
          // Pipelined: the four commands arrive together, as a client library would send them.
          c.write(
            ['MULTI', `DECRBY A ${n}`, `INCRBY B ${n}`, 'EXEC'].map((l) => `${l}\r\n`).join(''),
          );
          for (let r = 0; r < 4; r++) await c.read();
        }
      }),
    );
    running = false;
    await checker;
    await Promise.all(clients.map((c) => c.close()));
    expect(sums.length).toBeGreaterThan(0);
    expect(new Set(sums)).toEqual(new Set([TOTAL]));
    const [x, y] = (await a.call('MGET', 'A', 'B')) as [string, string];
    expect(Number(x) + Number(y)).toBe(TOTAL);
    expect(Number(y)).toBeGreaterThan(0);
  });

  it('WATCH makes a correct check-and-set counter under contention', async () => {
    await a.call('SET', 'counter', '0');
    const clients = await Promise.all(Array.from({ length: 20 }, () => TestClient.connect(t.port)));
    await Promise.all(
      clients.map(async (c) => {
        for (let done = 0; done < 10;) {
          await c.call('WATCH', 'counter');
          const value = Number(await c.call('GET', 'counter'));
          await c.call('MULTI');
          await c.call('SET', 'counter', String(value + 1));
          // A null EXEC means another client got in between: read again and retry.
          if ((await c.call('EXEC')) !== null) done++;
        }
      }),
    );
    await Promise.all(clients.map((c) => c.close()));
    expect(await a.call('GET', 'counter')).toBe('200');
  });
});
