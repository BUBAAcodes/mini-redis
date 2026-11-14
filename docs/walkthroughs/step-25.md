# Step 25: Docs and the study kit

## What this step built

The documents someone needs to run, test, benchmark and study MiniRedis without asking anyone:
the [README](../../README.md), [ARCHITECTURE.md](../ARCHITECTURE.md) with four Mermaid
diagrams, [INTERVIEW.md](../INTERVIEW.md) answering all 26 questions of spec section 23 with
links into the code, [EXERCISES.md](../EXERCISES.md) with the 13 break-it sabotages and the 25 †
commands, and a sample [miniredis.conf](../../miniredis.conf) holding every directive at its
default. A new test, `tests/unit/docs-refs.test.ts`, keeps those links honest.

## One real reference's path through the new test

The link [`dispatch` dispatch.ts:62](../../src/commands/dispatch.ts#L62) in INTERVIEW.md:

1. `refsIn` (`tests/unit/docs-refs.test.ts`) reads the markdown line by line, skips fenced code
   blocks, and collects every `[text](target)` whose target isn't a URL or an in-page anchor.
2. `checkRef` resolves the target against the markdown file's own folder, so
   `../src/commands/dispatch.ts` from `docs/` is `src/commands/dispatch.ts`, and checks it
   exists.
3. It parses `#L62` (or `#L62-L70`) and checks the range is inside the file.
4. The text says `dispatch.ts:62`, so the file name and the line must agree with the anchor;
   that catches a link updated in one place but not the other.
5. The text starts with a backticked symbol, `` `dispatch` ``, so line 62 must contain
   `dispatch`. That's the drift check: add ten lines above `dispatch()` and this test names the
   exact link that now points at the wrong code.

## Key pieces and why each exists

- **The drift check in `checkRef`**: line numbers rot silently. A link that still lands inside
  the file but on the wrong function would mislead a study session, so links that name a symbol
  are checked against it. INTERVIEW.md and EXERCISES.md name a symbol in nearly every link.
- **What it skips**: SPEC.md and PLAN.md are inputs, not docs about the code, and the
  walkthroughs describe the code as it was at their own step, so their `file:line` notes are
  allowed to age. Only README, the top-level docs and the ADRs are checked.
- **INTERVIEW.md**: each answer is short enough to say aloud, and points at the line that makes
  it true, so checking yourself means reading code, not prose.
- **EXERCISES.md**: each sabotage names the test that catches it and why. The hints for the †
  commands point at the existing helper to reuse (`expireDeadline`, `lmoveGeneric`,
  `parseLexRange`…) and at the rule that makes the command interesting.
- **miniredis.conf**: spec 4's layout lists it and the README's quick start uses it. Comments sit
  on their own lines because, as in Redis, `#` only starts a comment at the start of a line.
  It was checked to load as exactly the defaults.

## Trade-offs, and what Redis does differently

Redis documents itself on redis.io, generated from per-command JSON files in its source
(`src/commands/*.json`), which also generate the command table, so docs and code can't drift.
Here the command table is TypeScript and the docs are markdown, so a test does the policing
instead. It checks that a link points at a line naming the right symbol, not that the prose
around it is still true; that part is on the reader.

## The most important line

In `checkRef`:

```ts
if (name !== undefined && !lines.slice(from - 1, to).some((l) => l.includes(name))) {
```

Delete it and the test still passes when code moves, and every `file:line` in INTERVIEW.md can
quietly point at the wrong function. The self-test "catches a moved symbol, a wrong line in the
text and a missing file" fails, because its moved-symbol case is no longer reported.

## Quiz

1. Why does the docs test skip fenced code blocks?
2. A link reads ``[`lookupWrite` database.ts:106](../src/storage/database.ts#L106)`` and
   someone inserts a comment line above `lookupWrite`. What does the test report?
3. Why are the walkthroughs left out of the check?

<details>
<summary>Answers</summary>

1. Code blocks hold examples, such as `[text](link)` inside a snippet, that aren't references
   to check. Mermaid diagrams also live in fences, and their `-->` arrows and brackets would
   look like links.
2. `` `lookupWrite` is not on ../src/storage/database.ts#L106 ``: line 106 is now the comment,
   so the symbol isn't on it. The fix is to change both the anchor and the text to `:107`.
3. Each walkthrough is a snapshot of one step, and later steps move code, so its line numbers
   are expected to age. Forcing them to follow would rewrite history in a study log.

</details>
