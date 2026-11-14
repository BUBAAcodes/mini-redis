// SIGKILL while a BGSAVE or an AOF rewrite is running (spec 15.5): the file from before the job
// must still load, and the restart removes the job's temp file. The keyspace is padded so a job
// takes long enough to be killed in the middle; most kills must really land before the job's
// rename, which a temp file left on disk proves.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestClient } from '../helpers/resp-client.js';
import {
  CrashServer,
  type Durability,
  KILLS,
  Workload,
  info,
  leftoverTemps,
  removeDir,
  sleep,
  tempDir,
} from './harness.js';

const PAD = 100_000;

interface Job {
  name: string;
  directives: Record<string, string>;
  command: string;
  started: string;
  flag: string;
  /** What a restart may load, given whether the kill landed before the job's rename. */
  durability: (midJob: boolean) => Durability;
}

const jobs: Job[] = [
  {
    name: 'BGSAVE',
    directives: { appendonly: 'no', save: '' },
    command: 'BGSAVE',
    started: 'Background saving started',
    flag: 'rdb_bgsave_in_progress',
    // Killed before the rename: exactly the previous snapshot. After it: a newer one.
    durability: (midJob) => (midJob ? 'unchanged' : 'snapshot'),
  },
  {
    name: 'BGREWRITEAOF',
    directives: { appendonly: 'yes', appendfsync: 'everysec', save: '' },
    command: 'BGREWRITEAOF',
    started: 'Background append only file rewriting started',
    flag: 'aof_rewrite_in_progress',
    // The old AOF kept every write until the swap, and the new one has them all after it.
    durability: () => 'acked',
  },
];

describe.each(jobs)('a kill during $name', (job) => {
  let dir: string;
  beforeAll(async () => {
    dir = await tempDir();
  });
  afterAll(async () => {
    await removeDir(dir);
  });

  it(`leaves the previous file loadable, ${KILLS} times`, async () => {
    const load = new Workload();
    let server = await CrashServer.start(dir, job.directives);
    let c = await TestClient.connect(server.port);
    await load.seed(c, PAD);
    if (job.command === 'BGSAVE') expect(await c.call('SAVE')).toBe('OK');

    // How long one job takes under the load, so kills can be spread across it.
    let run = await load.run(server.port);
    let t0 = Date.now();
    expect(await c.call(job.command)).toBe(job.started);
    while ((await info(c, job.flag)) === '1') await sleep(2);
    const jobMs = Date.now() - t0;
    run.stop();
    await run.stopped;
    // The disk must hold what verify() records as loaded: the timing job's file is older.
    if (job.command === 'BGSAVE') expect(await c.call('SAVE')).toBe('OK');
    await load.verify(c, 'snapshot', PAD);
    console.log(`${job.name} of ${PAD} keys under load: ${jobMs} ms`);

    let midJob = 0;
    for (let k = 0; k < KILLS; k++) {
      run = await load.run(server.port);
      await sleep(10);
      t0 = Date.now();
      expect(await c.call(job.command)).toBe(job.started);
      await sleep(Math.max(0, load.rng.int(Math.ceil(jobMs * 0.9)) - (Date.now() - t0)));
      await server.kill();
      await run.stopped;
      c.socket.destroy();

      const killedMidJob = leftoverTemps(dir).length > 0;
      if (killedMidJob) midJob++;
      server = await CrashServer.start(dir, job.directives);
      if (killedMidJob) expect(server.output).toContain('Removed leftover temp file temp-');
      expect(leftoverTemps(dir)).toEqual([]);
      c = await TestClient.connect(server.port);
      await load.verify(c, job.durability(killedMidJob), PAD);
    }
    console.log(`${job.name}: ${midJob} of ${KILLS} kills landed mid-job`);
    expect(midJob).toBeGreaterThanOrEqual(KILLS / 2);
    c.socket.destroy();
    await server.kill();
  });
});
