import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PropagationRecord } from '../../src/server/propagate.js';
import { TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer;
let c: TestClient;
const records: PropagationRecord[] = [];

beforeAll(async () => {
  t = await startServer();
  t.server.propagator.attach({ append: (r) => records.push(r) });
  c = await TestClient.connect(t.port);
});

beforeEach(() => {
  records.length = 0;
});

afterAll(async () => {
  c.socket.destroy();
  await t.close();
});

describe('propagation through a recording sink (spec 9.5)', () => {
  it('propagates a write as it arrived', async () => {
    await c.call('set', 'k', 'v');
    expect(records).toEqual([{ db: 0, argv: ['set', 'k', 'v'] }]);
  });

  it('propagates nothing for reads, errors and writes that changed nothing', async () => {
    await c.call('GET', 'k');
    await c.call('PING');
    await c.call('SET', 'k', 'v', 'bogus');
    await c.call('DEL', 'missing');
    await c.call('SELECT', '2');
    await c.call('CONFIG', 'SET', 'hz', '10');
    expect(records).toEqual([]);
    await c.call('SELECT', '0');
  });

  it('records the db the write ran in', async () => {
    await c.call('SELECT', '5');
    await c.call('SET', 'k5', 'v');
    await c.call('DEL', 'k5', 'nope');
    await c.call('SELECT', '0');
    expect(records).toEqual([
      { db: 5, argv: ['SET', 'k5', 'v'] },
      { db: 5, argv: ['DEL', 'k5', 'nope'] },
    ]);
  });

  it('keeps the order commands ran in across a pipeline', async () => {
    let pipeline = '';
    for (let i = 0; i < 50; i++)
      pipeline += `*3\r\n$3\r\nSET\r\n$1\r\np\r\n$${String(i).length}\r\n${i}\r\n`;
    c.write(pipeline);
    for (let i = 0; i < 50; i++) await c.read();
    expect(records.map((r) => r.argv[2])).toEqual(Array.from({ length: 50 }, (_, i) => String(i)));
  });
});
