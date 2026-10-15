import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "./decision-lint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HEAD = "| Call | Model | Verdict | Confidence | Key reason | Conditions | Tokens |\n|---|---|---|---|---|---|---|\n";
const TRIAGE = "\n- Security paths: no\n- One-way door: no, reversible\n- Touches the profile's production-like environment: no\n";
const GOOD = [
  "| PM | opus | adopt A | high | simplest | - | - |",
  "| `engineer:root-fix` | sonnet | for A | medium | cheap | - | 12k |",
  "| `reviewer:risk` | opus | against B | high | breaks X | | 9k |",
  "| `security:authz` | opus | conditions | high | needs a deny test | C1: test the deny path | 8k |",
  "| `techlead:signoff` | opus | adopt A | high | fits | - | 5k |",
].join("\n");
const rec = (rows = GOOD, tail = TRIAGE, head = HEAD) => head + rows + "\n" + tail;

test("a complete record has no gaps", () => assert.deepEqual(lint(rec()), []));

test("no table, missing columns, no rows and no PM row", () => {
  assert.deepEqual(lint(TRIAGE), ["no decision table (a header row with Call and Verdict)"]);
  assert.deepEqual(lint(rec(GOOD, TRIAGE, HEAD.replace(" Confidence |", "").replace("|---|", "|"))).filter((g) => /column/.test(g)), ["column Confidence missing"]);
  assert.ok(lint(rec("", TRIAGE)).includes("the table has no rows"));
  assert.ok(lint(rec(GOOD.split("\n").slice(1).join("\n"))).includes("no PM row"));
});

test("verdict words by role, with the proposal", () => {
  const one = (row) => lint(rec("| PM | opus | adopt A | high | r | - | - |\n" + row));
  assert.match(one("| `security:x` | opus | adopt A | high | r | - | 1k |")[0], /must start with accept, conditions, block/);
  assert.match(one("| `engineer:x` | opus | accept | high | r | - | 1k |")[0], /must start with for, against/);
  assert.match(one("| `techlead:x` | opus | for A | high | r | - | 1k |")[0], /must start with adopt, reject/);
  assert.match(one("| `engineer:x` | opus | for | high | r | - | 1k |")[0], /Verdict for needs the proposal/);
  assert.deepEqual(one("| `security:x` | opus | block | high | r | - | 1k |"), []);
  assert.deepEqual(one("| `analyst:x` | haiku | - | high | r | - | 1k |"), []);
  assert.match(one("| `analyst:x` | haiku | for A | high | r | - | 1k |")[0], /an analyst gives -/);
});

test("a conditions verdict needs conditions; placeholders and empty cells are gaps", () => {
  assert.match(lint(rec(GOOD.replace("C1: test the deny path", "-")))[0], /conditions needs a Conditions cell/);
  assert.match(lint(rec(GOOD.replace("| high | simplest", "| ... | simplest")))[0], /Confidence is empty or a placeholder/);
  assert.match(lint(rec(GOOD.replace("| cheap |", "|  |")))[0], /Key reason is empty/);
  assert.match(lint(rec(GOOD.replace("| sonnet |", "| <model> |")))[0], /Model is empty/);
  assert.match(lint(rec(GOOD.replace("| 12k |", "|  |")))[0], /Tokens is empty/);
  assert.match(lint(rec(GOOD.replace("| - | - |\n", "| - |\n")))[0], /cells, the header has 7/);
});

test("the three triage lines: present, answered yes or no", () => {
  assert.deepEqual(lint(rec(GOOD, "")), ["triage line Security paths missing", "triage line One-way door missing", "triage line Touches real missing"]);
  assert.deepEqual(lint(rec(GOOD, "\n**Security paths:** yes, auth/\n**One-way door?** no\nTouches real: n/a, no production environment\n")), []);
  assert.match(lint(rec(GOOD, TRIAGE.replace("Security paths: no", "Security paths: maybe")))[0], /Security paths: answer must start with yes or no/);
  assert.deepEqual(lint(rec(GOOD, TRIAGE.replace("environment: no", "environment: n/a"))), [], "n/a is fine for the last line");
});

test("cli: exit 2 with gap lines, 0 when clean, 64 on bad usage", () => {
  const run = (input, ...a) => spawnSync("node", [join(here, "decision-lint.mjs"), ...a], { encoding: "utf8", input });
  const bad = run(rec(GOOD, ""), "-");
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /^decision gap: triage line Security paths missing/);
  const ok = run(rec(), "-");
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), "decision ok");
  assert.deepEqual(JSON.parse(run(rec(GOOD, ""), "-", "--json").stdout).gaps.length, 3);
  assert.equal(run("", "--json").status, 64);
  assert.equal(run("", "/nonexistent.md").status, 64);
});
