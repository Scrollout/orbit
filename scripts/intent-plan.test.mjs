import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "intent-plan.mjs");
const profile = (extra = "production_env: none") => `\`\`\`yaml orbit-profile
base_branch: main
security_paths: [auth/, "scripts/check-*", "Makefile"]
review_trailer: Reviewed-by
labels: [bug]
issue_tracker: github
base_pusher: agent
ci_policy: ci-only
${extra}
\`\`\`
`;
const fm = `---
type: Roadmap
title: "M2 plan: CSV export"
description: M2's intent, steps with proofs, exit tests and carried issues.
status: stable
generated: { by: claude-code/claude-opus-5-5, at: 2026-10-14T10:00:00Z }
verified:
  - { by: human:owner, at: 2026-10-14T10:05:00Z }
---
**TL;DR:** M2 (CSV export) is done when its exit tests pass.

## Intent
- Goal: users export reports as CSV.
- Assumptions: A1 UTF-8 only.
`;
const exitTests = "\n## Exit tests\n| Test | Step |\n|---|---|\n| `export.test` exports a report | 2 |\n";
const stepsHead = "\n## Steps\n| Step | Builds | Files | Proof | Depends | Hint |\n|---|---|---|---|---|---|\n";
const rows = [
  "| 1 | CSV writer | `src/csv/writer.ts` | `csv.test` | - | sec=no door=no |",
  "| 2 | Export endpoint | `src/api/export.ts` | `export.test` | 1 | sec=no door=yes |",
  "| 3 | Export button | `web/*.tsx` | `ui.test` | 1 | sec=no door=no |",
];
const plan = (r = rows, extra = exitTests) => `${fm}${extra}${stepsHead}${r.join("\n")}\n\n## Carried\nNone.\n`;

function run(text, { prof = profile(), args = [], stdin = false, okf } = {}) {
  const root = mkdtempSync(join(tmpdir(), "intent-"));
  mkdirSync(join(root, ".agents"));
  if (prof !== null) writeFileSync(join(root, ".agents/project.md"), prof);
  if (okf) writeFileSync(join(root, ".agents/okf.json"), JSON.stringify(okf));
  writeFileSync(join(root, "plan.md"), text);
  const r = spawnSync("node", [script, "--root", root, "--plan", stdin ? "-" : "plan.md", ...args], { encoding: "utf8", input: stdin ? text : undefined });
  rmSync(root, { recursive: true, force: true });
  return r;
}
const gapOf = (r, re) => { assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stdout, re); };

test("a valid plan passes, prints waves and the steps that go to /decide first", () => {
  const r = run(plan());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^wave 1: 1$/m);
  assert.match(r.stdout, /^wave 2: 2, 3$/m);
  assert.match(r.stdout, /^decide first: 2 \(door=yes\)$/m);
});

test("stdin input works the same", () => {
  const r = run(plan(), { stdin: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^wave 2: 2, 3$/m);
});

test("the OKF per-doc checks run on the rendered plan", () => {
  gapOf(run(plan().replace("type: Roadmap\n", "")), /okf: frontmatter needs a non-empty 'type'/);
  gapOf(run(plan().replace("**TL;DR:**", "TLDR")), /okf: missing a '\*\*TL;DR:\*\*' line/);
  gapOf(run(plan().replace("generated: { by: claude-code/claude-opus-5-5, ", "generated: { ")), /okf: generated needs `by`/);
});

test("the size cap is measured on the whole rendered file, from okf.json or --max-chars", () => {
  gapOf(run(plan(), { okf: { maxDocChars: 500 } }), /okf: \d+ chars exceeds 500/);
  gapOf(run(plan(), { args: ["--max-chars", "400"] }), /okf: \d+ chars exceeds 400/);
});

test("intent, builds, proof and files gaps", () => {
  gapOf(run(plan().replace("## Intent\n- Goal: users export reports as CSV.\n- Assumptions: A1 UTF-8 only.\n", "## Intent\n<goal>\n")), /no ## Intent section, or it still has placeholders/);
  gapOf(run(plan([rows[0].replace("`csv.test`", "<test or check>")])), /step 1: Proof is empty or a placeholder/);
  gapOf(run(plan([rows[0].replace("CSV writer", "")])), /step 1: Builds is empty or a placeholder/);
  gapOf(run(plan([rows[0].replace("`src/csv/writer.ts`", "")])), /step 1: no Files/);
  gapOf(run(plan([rows[0].replace("`src/csv/writer.ts`", "`src/*/writer.ts`")])), /wildcard outside the last segment/);
});

test("depends: unknown and cyclic", () => {
  gapOf(run(plan([rows[0].replace("| - |", "| 9 |")])), /step 1: depends on unknown step 9/);
  gapOf(run(plan([rows[0].replace("| - |", "| 2 |"), rows[1]])), /dependency cycle: (1 -> 2 -> 1|2 -> 1 -> 2)/);
});

test("exit tests must name known steps, and at least one must exist", () => {
  gapOf(run(plan(rows, exitTests.replace("| 2 |", "| 7 |"))), /names unknown step 7/);
  gapOf(run(plan(rows, "")), /no ## Exit tests table with a row/);
});

test("hint grammar, prod required only with a production_env", () => {
  gapOf(run(plan([rows[0].replace("sec=no door=no", "secure")])), /step 1: hint 'secure' is not/);
  gapOf(run(plan(), { prof: profile("production_env: prod-eu") }), /step 1: hint 'sec=no door=no' is not 'sec=yes\|no door=yes\|no prod=yes\|no'/);
  assert.equal(run(plan(rows.map((r) => r.replace("door=no |", "door=no prod=no |").replace("door=yes |", "door=yes prod=no |"))), { prof: profile("production_env: prod-eu") }).status, 0);
});

test("a decide-first step needs no files or proof and is listed first", () => {
  const r = run(plan([...rows, "| 4 | Retention policy | | | - | decide-first |"]));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /decide first: .*4 \(decide-first\)/);
});

test("security paths force sec=yes: exact, and may-touch for a directory entry", () => {
  let r = run(plan([...rows, "| 4 | Scopes | `auth/scopes.ts` | `scope.test` | 2 | sec=no door=no |"]));
  assert.match(r.stdout, /^step 4: sec=yes \(forced: auth\/\)$/m);
  r = run(plan([...rows, "| 4 | Checks | `scripts/` | `c.test` | - | sec=no door=no |"]));
  assert.match(r.stdout, /^step 4: sec=yes \(forced, may touch: scripts\/check-\*\)$/m);
  assert.match(r.stdout, /decide first: .*4 \(sec=yes\)/);
  assert.doesNotMatch(run(plan()).stdout, /sec=yes/);
});

// Review round: real overlaps the first version missed. Each must be forced.
const secProfile = (paths) => profile().replace('security_paths: [auth/, "scripts/check-*", "Makefile"]', `security_paths: [${paths}]`);
const forcedFor = (paths, files) => run(plan([`| 1 | X | ${files} | \`x.test\` | - | sec=no door=no |`], exitTests.replace("| 2 |", "| 1 |")), { prof: secProfile(paths) }).stdout;
test("a plain-name glob covers everything below it", () => {
  assert.match(forcedFor("src/auth", "`src/auth/login.ts`"), /^step 1: sec=yes \(forced: src\/auth\)$/m);
  assert.match(forcedFor("infra", "`infra/terraform/`"), /^step 1: sec=yes/m);
  assert.match(forcedFor("infra", "`infra/*.tf`"), /^step 1: sec=yes/m);
});
test("a wildcard glob segment matches a directory and covers below it", () => {
  assert.match(forcedFor('"src/*"', "`src/auth/*.ts`"), /^step 1: sec=yes/m);
  assert.match(forcedFor('"**/config/secrets.yml"', "`app/*`"), /^step 1: sec=yes/m);
  assert.match(forcedFor('"**/auth/token.ts"', "`src/a*`"), /^step 1: sec=yes/m);
  assert.doesNotMatch(forcedFor('"src/auth/**"', "`web/*.tsx`"), /sec=yes/);
});
test("Files split on commas, semicolons, <br> and spaces", () => {
  for (const f of ["`src/a.ts src/auth/x.ts`", "`src/a.ts`; `src/auth/x.ts`", "`src/a.ts`<br>`src/auth/x.ts`"]) assert.match(forcedFor('"src/auth/**"', f), /^step 1: sec=yes/m, f);
});
test("placeholders in Files and exit tests are gaps", () => {
  gapOf(run(plan([rows[0].replace("`src/csv/writer.ts`", "<paths>")])), /step 1: Files is a placeholder/);
  gapOf(run(plan(rows, exitTests.replace("`export.test` exports a report", "<behaviour proved>"))), /exit test '<behaviour proved>' is empty or a placeholder/);
});
test("an escaped pipe stays in its cell; a heading may carry text; CRLF is read", () => {
  assert.equal(run(plan([rows[0].replace("CSV writer", "parse `a \\| b`"), rows[1], rows[2]])).status, 0);
  assert.equal(run(plan().replace("## Steps\n", "## Steps (track A)\n")).status, 0);
  assert.equal(run(plan().replace(/\n/g, "\r\n")).status, 0);
});
test("production_env TODO does not make prod= mandatory", () => {
  const r = run(plan(), { prof: profile("production_env: TODO") });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /warn: profile production_env is TODO/);
});
test("an undefined footnote is a plan gap, not a crash", () => {
  gapOf(run(plan().replace("**TL;DR:** M2 (CSV export) is done when its exit tests pass.", "**TL;DR:** Cited.[^s1]")), /okf: footnote \[\^s1\] has no definition/);
});

test("waves keep steps that touch the same paths apart", () => {
  const r = run(plan([
    "| 1 | A | `src/a/` | `a.test` | - | sec=no door=no |",
    "| 2 | B | `src/a/b.ts` | `b.test` | - | sec=no door=no |",
    "| 3 | C | `src/c.ts` | `c.test` | - | sec=no door=no |",
    "| 4 | D | `web/*.tsx` | `d.test` | - | sec=no door=no |",
    "| 5 | E | `web/x.tsx` | `e.test` | - | sec=no door=no |",
  ], exitTests.replace("| 2 |", "| 1 |")));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^wave 1: 1, 3, 4$/m);
  assert.match(r.stdout, /^wave 2: 2, 5$/m);
});

test("several plan docs are one plan: ids unique across them, Depends may cross", () => {
  const root = mkdtempSync(join(tmpdir(), "intent-"));
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents/project.md"), profile());
  writeFileSync(join(root, "a.md"), plan());
  writeFileSync(join(root, "b.md"), plan(["| 4 | Docs | `docs/csv.md` | `docs check` | 3 | sec=no door=no |"], ""));
  writeFileSync(join(root, "c.md"), plan(["| 1 | Dup | `x.ts` | `x.test` | - | sec=no door=no |"], ""));
  const ok = spawnSync("node", [script, "--root", root, "--plan", "a.md", "--plan", "b.md"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^wave 3: 4$/m);
  const dup = spawnSync("node", [script, "--root", root, "--plan", "a.md", "--plan", "c.md"], { encoding: "utf8" });
  assert.match(dup.stdout, /step 1: duplicate id/);
  rmSync(root, { recursive: true, force: true });
});

test("only a security_paths gap stops it; other TODO fields are not needed for planning", () => {
  const r = run(plan(), { prof: profile("production_env: none").replace("base_pusher: agent", "base_pusher: TODO").replace("labels: [bug]", "labels: [TODO]") });
  assert.equal(r.status, 0, r.stdout);
  const g = run(plan(), { prof: profile().replace('security_paths: [auth/, "scripts/check-*", "Makefile"]', "security_paths: [TODO]") });
  assert.equal(g.status, 1);
  assert.match(g.stdout, /profile gap: security_paths/);
  assert.equal(run(plan(), { prof: null }).status, 1);
});

test("usage errors", () => {
  assert.equal(spawnSync("node", [script], { encoding: "utf8" }).status, 64);
  assert.equal(spawnSync("node", [script, "--plan", "-", "--plan", "-"], { encoding: "utf8" }).status, 64);
  assert.equal(spawnSync("node", [script, "--root", tmpdir(), "--plan", "missing.md"], { encoding: "utf8" }).status, 64);
});
