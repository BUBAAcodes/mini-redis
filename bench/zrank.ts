// ZRANK cost against sorted-set size (spec step 11): builds sorted sets of 10k, 100k and 1M
// members and times random rank lookups on each. With a skip list the work per lookup grows with
// log n: each 10× more members adds about the same number of links followed.
//
// Run: npx tsx bench/zrank.ts
//
// It times the ZSet directly, without the network, so the numbers are the data structure's
// cost alone. Each size is warmed up first so the JIT has compiled the hot paths. Two columns
// matter: links followed per lookup (the algorithm: ~log n) and ns per lookup (the algorithm
// plus cache misses, which grow much faster once a million nodes no longer fit in cache).
import { ZSet } from '../src/datastructures/zset.js';
import { Random } from '../src/utils/random.js';

const SIZES = [10_000, 100_000, 1_000_000];
const LOOKUPS = 200_000;

function build(n: number): { zset: ZSet; members: string[] } {
  const rng = new Random(n);
  const zset = new ZSet({ seed: 1, rng }, rng);
  const members: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = `member:${i}`;
    members.push(m);
    zset.add(m, rng.int(1_000_000) / 4);
  }
  return { zset, members };
}

function time(zset: ZSet, members: string[], rng: Random): number {
  let sink = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < LOOKUPS; i++) sink += zset.rank(members[rng.int(members.length)]!)!;
  const ns = Number(process.hrtime.bigint() - start);
  if (sink < 0) console.log(sink); // keep the loop from being optimised away
  return ns / LOOKUPS;
}

function steps(zset: ZSet, members: string[], rng: Random): number {
  let total = 0;
  const samples = 20_000;
  for (let i = 0; i < samples; i++) {
    const m = members[rng.int(members.length)]!;
    total += zset.zsl.searchSteps(zset.score(m)!, m);
  }
  return total / samples;
}

const rows: Array<{ n: number; ns: number; hops: number; levels: number }> = [];
for (const n of SIZES) {
  const { zset, members } = build(n);
  const rng = new Random(42);
  time(zset, members, rng); // warm-up
  rows.push({
    n,
    ns: time(zset, members, rng),
    hops: steps(zset, members, rng),
    levels: zset.zsl.level,
  });
}

console.log('members     links/ZRANK   ns/ZRANK   levels');
for (const { n, ns, hops, levels } of rows) {
  console.log(
    `${String(n).padEnd(11)} ${hops.toFixed(1).padStart(11)}   ${ns.toFixed(0).padStart(8)}   ${String(levels).padStart(6)}`,
  );
}
const first = rows[0]!;
const last = rows.at(-1)!;
console.log(
  `\n100× more members: ${(last.hops / first.hops).toFixed(2)}× the links ` +
    `(log2 n grows ${(Math.log2(last.n) / Math.log2(first.n)).toFixed(2)}×), ` +
    `${(last.ns / first.ns).toFixed(1)}× the time (linear would be 100×).`,
);
