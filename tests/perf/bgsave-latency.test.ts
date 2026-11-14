// Spec 15.8 performance check, run locally with `npm run test:perf`: PING latency while a
// BGSAVE walks 1M keys (step 13's "no PING takes over 50 ms"). Kept out of `npm test`, whose
// suites run in parallel: filling 1M keys would starve them of CPU on a slow machine.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readSnapshot } from '../../src/persistence/snapshot-format.js';
import { createStringObject } from '../../src/storage/redis-object.js';
import { TestClient } from '../helpers/resp-client.js';
import { startServer } from '../helpers/server.js';
import type { TestServer } from '../helpers/server.js';

const dir = mkdtempSync(join(tmpdir(), 'miniredis-perf-'));
const open: Array<TestServer | TestClient> = [];

afterEach(async () => {
  for (const thing of open.splice(0).reverse()) {
    if (thing instanceof TestClient) thing.socket.destroy();
    else await thing.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

it('no PING waits over 50 ms during a BGSAVE of 1M keys', async () => {
  const t = await startServer({ dir, save: '' });
  open.push(t);
  const db = t.server.dbs[0]!;
  for (let i = 0; i < 1_000_000; i++) db.add(`fill:${i}`, createStringObject('value'));
  const c = await TestClient.connect(t.port);
  const ping = await TestClient.connect(t.port);
  open.push(c, ping);
  expect(await c.call('BGSAVE')).toBe('Background saving started');
  let worst = 0;
  let pings = 0;
  const started = performance.now();
  while (t.server.snapshotJob !== null) {
    const sent = performance.now();
    expect(await ping.call('PING')).toBe('PONG');
    worst = Math.max(worst, performance.now() - sent);
    pings++;
  }
  const seconds = (performance.now() - started) / 1000;
  // Recorded in docs/walkthroughs/step-13.md and, in step 24, bench/RESULTS.md.
  console.log(
    `BGSAVE of 1M keys: ${seconds.toFixed(2)} s, ${pings} PINGs, worst ${worst.toFixed(1)} ms`,
  );
  expect(t.server.lastBgsaveStatus).toBe('ok');
  expect(pings).toBeGreaterThan(10);
  expect(worst).toBeLessThan(50);
  const loaded = readSnapshot(t.server, readFileSync(join(dir, 'dump.mrdb')), { now: null });
  expect(loaded.keys).toBe(1_000_000);
});
