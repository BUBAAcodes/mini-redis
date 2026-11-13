import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

let t: TestServer;
let redis: Redis;

beforeAll(async () => {
  t = await startServer();
  // The ready check sends INFO and waits for loading:0 (spec 13.1).
  redis = new Redis({
    port: t.port,
    host: '127.0.0.1',
    lazyConnect: true,
    maxRetriesPerRequest: 0,
  });
  await redis.connect();
});

afterAll(async () => {
  redis.disconnect();
  await t.close();
});

describe('ioredis', () => {
  it('connects and runs SET and GET', async () => {
    expect(redis.status).toBe('ready');
    expect(await redis.set('io:a', 'hello')).toBe('OK');
    expect(await redis.get('io:a')).toBe('hello');
    expect(await redis.get('io:missing')).toBeNull();
  });

  it('gets the replies to a 100-command pipeline in order', async () => {
    const p = redis.pipeline();
    for (let i = 0; i < 100; i++) {
      if (i % 3 === 0) p.set(`io:p${i}`, `v${i}`);
      else if (i % 3 === 1) p.get(`io:p${i - 1}`);
      else p.echo(`e${i}`);
    }
    const results = await p.exec();
    expect(results).toHaveLength(100);
    results!.forEach(([err, value], i) => {
      expect(err).toBeNull();
      if (i % 3 === 0) expect(value).toBe('OK');
      else if (i % 3 === 1) expect(value).toBe(`v${i - 1}`);
      else expect(value).toBe(`e${i}`);
    });
  });

  it('surfaces errors as rejections', async () => {
    await expect(redis.call('nosuchcommand')).rejects.toThrow(/unknown command/);
  });
});
