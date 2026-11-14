// SIGKILL under write load with snapshots only (spec 15.5): no AOF, a client asking for BGSAVE
// after BGSAVE. The restarted server must hold one consistent point in time: A + B unchanged,
// every hash and list whole, and nothing older than what the previous start loaded.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestClient } from '../helpers/resp-client.js';
import { CrashServer, KILLS, Workload, info, removeDir, sleep, tempDir } from './harness.js';

describe('snapshot only', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await tempDir();
  });
  afterAll(async () => {
    await removeDir(dir);
  });

  it(`loads one consistent snapshot after each of ${KILLS} kills`, async () => {
    const directives = { appendonly: 'no', save: '' };
    const load = new Workload();
    let server = await CrashServer.start(dir, directives);
    let c = await TestClient.connect(server.port);
    await load.seed(c);
    expect(await c.call('SAVE')).toBe('OK');
    let saves = 0;

    for (let k = 0; k < KILLS; k++) {
      const run = await load.run(server.port);
      const until = Date.now() + 30 + load.rng.int(300);
      const saver = (async () => {
        try {
          while (Date.now() < until) {
            expect(await c.call('BGSAVE')).toBe('Background saving started');
            while ((await info(c, 'rdb_bgsave_in_progress')) === '1') await sleep(1);
            saves++;
          }
        } catch (e) {
          if (!(e as Error).message.startsWith('connection closed')) throw e;
        }
      })();
      await sleep(until - Date.now());
      await server.kill();
      await Promise.all([run.stopped, saver]);
      c.socket.destroy();

      server = await CrashServer.start(dir, directives);
      c = await TestClient.connect(server.port);
      await load.verify(c, 'snapshot');
    }
    // Snapshots really were taken and loaded, not just the first SAVE over and over.
    expect(saves).toBeGreaterThanOrEqual(KILLS / 2);
    console.log(`snapshot only: ${saves} BGSAVEs, ${load.transfers} transfers`);
    c.socket.destroy();
    await server.kill();
  });
});
