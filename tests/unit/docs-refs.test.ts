// Keeps the study docs pointing at real code (spec step 25). Every relative markdown link in
// README.md, docs/*.md and docs/adr/*.md must name a file that exists; a `#L42` or `#L42-L50`
// anchor must fall inside it; link text that says `file.ts:42` must agree with the anchor; and
// a link whose text starts with a backticked symbol (`lookupWrite`) must point at lines that
// contain that symbol, so a reference that drifted when code moved fails here instead of
// silently pointing at the wrong function.
//
// SPEC.md and PLAN.md are the inputs to the build, not docs about the code, and walkthroughs
// describe the code as it was at their step, so they're left out.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const EXCLUDED = new Set(['SPEC.md', 'PLAN.md']);

const mdIn = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith('.md') && !EXCLUDED.has(f))
        .map((f) => join(dir, f))
    : [];

const FILES = [
  join(ROOT, 'README.md'),
  ...mdIn(join(ROOT, 'docs')),
  ...mdIn(join(ROOT, 'docs/adr')),
].filter(existsSync);

interface Ref {
  file: string;
  line: number;
  text: string;
  target: string;
}

function refsIn(file: string): Ref[] {
  const out: Ref[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  let fenced = false;
  lines.forEach((l, i) => {
    if (l.trimStart().startsWith('```')) fenced = !fenced;
    if (fenced) return;
    for (const m of l.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      const target = m[2]!;
      if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue; // URLs, in-page anchors
      out.push({ file, line: i + 1, text: m[1]!, target });
    }
  });
  return out;
}

/** The problem with one reference, or null if it holds. */
function checkRef(ref: Ref): string | null {
  const [path, anchor] = ref.target.split('#') as [string, string | undefined];
  const abs = resolve(dirname(ref.file), decodeURIComponent(path));
  if (!existsSync(abs)) return `${path} does not exist`;
  if (anchor === undefined) return null;
  const range = /^L(\d+)(?:-L(\d+))?$/.exec(anchor);
  if (range === null) return null; // a heading anchor in another markdown file
  if (statSync(abs).isDirectory()) return `#${anchor} on a directory`;
  const from = Number(range[1]);
  const to = Number(range[2] ?? range[1]);
  const lines = readFileSync(abs, 'utf8').split('\n');
  if (from < 1 || to < from || to > lines.length) {
    return `#${anchor} is outside ${path} (${lines.length} lines)`;
  }
  const said = /([\w.-]+\.\w+):(\d+)(?:-(\d+))?/.exec(ref.text);
  if (said !== null) {
    if (!abs.endsWith(said[1]!)) return `text names ${said[1]} but the link goes to ${path}`;
    if (Number(said[2]) !== from || Number(said[3] ?? said[2]) !== to) {
      return `text says :${said[2]}${said[3] ? `-${said[3]}` : ''} but the anchor is #${anchor}`;
    }
  }
  const symbol = /^`([^`]+)`/.exec(ref.text.trim());
  if (symbol !== null) {
    // `Db.lookupWrite()` → lookupWrite: the last name in the code span is what the line holds.
    const name = /([A-Za-z_$][\w$]*)\W*$/.exec(symbol[1]!)?.[1];
    if (name !== undefined && !lines.slice(from - 1, to).some((l) => l.includes(name))) {
      return `\`${name}\` is not on ${path}#${anchor}`;
    }
  }
  return null;
}

describe('docs references', () => {
  it('finds the docs to check', () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const file of FILES) {
    it(`${relative(ROOT, file)}: every link points at real code`, () => {
      const problems = refsIn(file)
        .map((r) => [r, checkRef(r)] as const)
        .filter(([, p]) => p !== null)
        .map(([r, p]) => `${relative(ROOT, r.file)}:${r.line} [${r.text}](${r.target}): ${p}`);
      expect(problems).toEqual([]);
    });
  }

  it('catches a moved symbol, a wrong line in the text and a missing file', () => {
    const self = join(ROOT, 'docs/x.md');
    const dispatch = readFileSync(join(ROOT, 'src/commands/dispatch.ts'), 'utf8').split('\n');
    const at = dispatch.findIndex((l) => l.startsWith('export function dispatch(')) + 1;
    const ok: Ref = {
      file: self,
      line: 1,
      text: `\`dispatch\` dispatch.ts:${at}`,
      target: `../src/commands/dispatch.ts#L${at}`,
    };
    expect(checkRef(ok)).toBeNull();
    expect(checkRef({ ...ok, target: `../src/commands/dispatch.ts#L${at + 1}` })).toMatch(
      /text says/,
    );
    expect(
      checkRef({ ...ok, text: '`dispatch`', target: '../src/commands/dispatch.ts#L1' }),
    ).toMatch(/is not on/);
    expect(checkRef({ ...ok, text: 'x', target: '../src/nope.ts#L1' })).toMatch(/does not exist/);
    expect(checkRef({ ...ok, text: 'x', target: '../src/commands/dispatch.ts#L99999' })).toMatch(
      /outside/,
    );
  });
});
