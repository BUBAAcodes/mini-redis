// SIGKILL under write load with the AOF on, once per fsync mode (spec 15.5). Every acknowledged
// write must come back. All three modes pass because SIGKILL ends the process, not the machine:
// bytes handed to the OS with write() sit in its page cache and reach the disk anyway. fsync only
// matters if the machine loses power, which a test can't do.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestClient } from '../helpers/resp-client.js';
import { CrashServer, KILLS, Workload, removeDir, sleep, tempDir } from './harness.js';

describe.each(['always', 'everysec', 'no'])('appendfsync %s', (fsync) => {
  let dir: string;
  beforeAll(async () => {
    dir = await tempDir();
  });
  afterAll(async () => {
    await removeDir(dir);
  });

  it(`keeps every acknowledged write across ${KILLS} kills`, async () => {
    // No save points: the AOF alone must carry the data.
    const directives = { appendonly: 'yes', appendfsync: fsync, save: '' };
    const load = new Workload();
    let server = await CrashServer.start(dir, directives);
    let c = await TestClient.connect(server.port);
    await load.seed(c);
    let truncatedLoads = 0;

    for (let k = 0; k < KILLS; k++) {
      const run = await load.run(server.port);
      await sleep(30 + load.rng.int(300));
      await server.kill();
      await run.stopped;
      c.socket.destroy();

      server = await CrashServer.start(dir, directives);
      if (server.output.includes('Truncating the AOF')) truncatedLoads++;
      c = await TestClient.connect(server.port);
      await load.verify(c, 'acked');
    }
    expect(load.transfers).toBeGreaterThan(KILLS);
    console.log(
      `appendfsync ${fsync}: ${load.transfers} transfers, ${truncatedLoads} truncated loads`,
    );
    c.socket.destroy();
    await server.kill();
  });
});
