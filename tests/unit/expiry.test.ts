import { describe, expect, it } from 'vitest';
import { Server } from '../../src/server/server.js';
import { activeExpireCycle } from '../../src/storage/expiry.js';
import { createStringObject } from '../../src/storage/redis-object.js';

const newServer = () => new Server({ log: () => {}, seed: 7 });

/** `n` keys in `db` with the given deadline (Unix ms). */
const fill = (server: Server, db: number, n: number, deadline: number, prefix = 'k') => {
  const d = server.dbs[db]!;
  for (let i = 0; i < n; i++) {
    d.add(`${prefix}${i}`, createStringObject('v'));
    d.setExpire(`${prefix}${i}`, deadline);
  }
};

describe('activeExpireCycle (spec 9.3)', () => {
  it('keeps sampling while more than a quarter of each sample was expired', () => {
    const server = newServer();
    fill(server, 0, 5000, 1);
    fill(server, 3, 5000, 1);
    activeExpireCycle(server, 1000);
    expect(server.dbs[0]!.size).toBe(0);
    expect(server.dbs[3]!.size).toBe(0);
    expect(server.stats.expiredKeys).toBe(10_000);
  });

  it('stops sampling a db once few of its keys are expired', () => {
    const server = newServer();
    // 1 key in 100 expired: a sample of 20 almost never finds more than 5, so the cycle
    // gives up long before it has looked at every key.
    fill(server, 0, 9900, Date.now() + 3_600_000, 'live');
    fill(server, 0, 100, 1, 'dead');
    activeExpireCycle(server, 1000);
    expect(server.stats.expiredKeys).toBeLessThan(100);
    expect(server.dbs[0]!.size).toBeGreaterThan(9900);
  });

  it('never touches keys without a TTL or with one in the future', () => {
    const server = newServer();
    server.dbs[0]!.add('nottl', createStringObject('v'));
    fill(server, 0, 50, Date.now() + 3_600_000);
    activeExpireCycle(server, 1000);
    expect(server.dbs[0]!.size).toBe(51);
    expect(server.stats.expiredKeys).toBe(0);
  });

  it('respects its time budget and resumes at the same db next time', () => {
    const server = newServer();
    fill(server, 2, 300_000, 1);
    const start = performance.now();
    activeExpireCycle(server, 2);
    expect(performance.now() - start).toBeLessThan(50);
    const left = server.dbs[2]!.size;
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(300_000);
    expect(server.activeExpireDb).toBe(2);
    activeExpireCycle(server, 2);
    expect(server.dbs[2]!.size).toBeLessThan(left);
  });

  it('a zero budget does nothing', () => {
    const server = newServer();
    fill(server, 0, 100, 1);
    activeExpireCycle(server, 0);
    expect(server.dbs[0]!.size).toBe(100);
  });
});
