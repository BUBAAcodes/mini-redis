// Reads a V8 `.cpuprofile` (from `node --cpu-prof`) and prints the functions with the most
// self time, and the most total time, so the top hotspot can be named without opening
// Chrome DevTools. Used for step 24's optimisation; see bench/RESULTS.md.
//
// Run: npx tsx bench/profile-top.ts <file.cpuprofile> [rows]
//
// Self time is where the samples landed; total time adds everything a function called.
// Idle and GC appear as `(idle)`, `(program)` and `(garbage collector)`, which matter too:
// a GC share that drops after a fix is the allocation savings showing up.
import { readFileSync } from 'node:fs';

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
interface Profile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

const [file, rowsArg] = process.argv.slice(2);
if (file === undefined) {
  console.error('usage: tsx bench/profile-top.ts <file.cpuprofile> [rows]');
  process.exit(1);
}
const rows = Number(rowsArg ?? 25);
const profile = JSON.parse(readFileSync(file, 'utf8')) as Profile;

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const label = (n: ProfileNode): string => {
  const { functionName, url, lineNumber } = n.callFrame;
  const where = url === '' ? '' : ` ${url.replace(/^.*\/(src|node:)/, '$1')}:${lineNumber + 1}`;
  return `${functionName || '(anonymous)'}${where}`;
};

const self = new Map<string, number>();
const total = new Map<string, number>();
let all = 0;
profile.samples.forEach((id, i) => {
  const dt = profile.timeDeltas[i] ?? 0;
  all += dt;
  const node = byId.get(id)!;
  self.set(label(node), (self.get(label(node)) ?? 0) + dt);
  // Each frame on the stack once, however often it recurses.
  const seen = new Set<string>();
  for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
    const l = label(byId.get(cur)!);
    if (seen.has(l)) continue;
    seen.add(l);
    total.set(l, (total.get(l) ?? 0) + dt);
  }
});

const print = (title: string, m: Map<string, number>): void => {
  console.log(`\n${title} (of ${(all / 1000).toFixed(0)} ms sampled)`);
  for (const [l, t] of [...m].sort((a, b) => b[1] - a[1]).slice(0, rows)) {
    console.log(
      `${((t / all) * 100).toFixed(1).padStart(5)}%  ${(t / 1000).toFixed(0).padStart(6)} ms  ${l}`,
    );
  }
};
print('Self time', self);
print('Total time', total);
