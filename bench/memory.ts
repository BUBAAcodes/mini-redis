// Memory for 1M keys with 100-byte values (spec 18), on Redis and MiniRedis side by side in
// Compose: `used_memory` from INFO and the container's RSS from `docker stats --no-stream`.
//
// Run (with `docker compose up -d miniredis redis`): npx tsx bench/memory.ts [keys]
//
// The two `used_memory` numbers aren't measured the same way: Redis asks its allocator, which
// counts everything it allocated (an empty server shows about 1 MB); MiniRedis reports its own
// estimate of the dataset (spec 10.5). RSS is the honest comparison: whole process, real bytes.
import { call, containerRss, fill, infoField, mb, sleep } from './lib.js';

const KEYS = Number(process.argv[2] ?? 1_000_000);
const SERVERS = [
  { name: 'Redis 7.4', service: 'redis', port: 6379 },
  { name: 'MiniRedis', service: 'miniredis', port: 6380 },
];

console.log(`| Server | Keys | used_memory | RSS before | RSS after | RSS per key |`);
console.log(`| --- | ---: | ---: | ---: | ---: | ---: |`);
for (const { name, service, port } of SERVERS) {
  await call(port, 'FLUSHALL');
  await sleep(2000); // let V8 collect the old dataset before the "before" reading
  const before = containerRss(service);
  const start = Date.now();
  await fill(port, KEYS, 100);
  const seconds = (Date.now() - start) / 1000;
  await sleep(2000);
  const used = Number(await infoField(port, 'memory', 'used_memory'));
  const after = containerRss(service);
  const dbsize = (await call(port, 'DBSIZE')).trim();
  if (dbsize !== `:${KEYS}`) throw new Error(`${name}: DBSIZE is ${dbsize}, expected ${KEYS}`);
  console.log(
    `| ${name} | ${KEYS.toLocaleString('en-US')} | ${mb(used)} | ${mb(before)} | ${mb(after)} | ${((after - before) / KEYS).toFixed(0)} B |`,
  );
  console.error(`${name}: loaded in ${seconds.toFixed(1)} s`);
  await call(port, 'FLUSHALL');
}
