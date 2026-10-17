import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "./decision-lint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HEAD = "| Call | Model | Verdict | Confidence | Key reason | Conditions | Tokens |\n|---|---|---|---|---|---|---|\n";
const TRIAGE = "\n- Security paths: no\n- One-way door: no, reversible\n- Touches the profile's production-like environment: no\n";
const SEC = "\n**Decision**: adopt A.\n- **Track and why**: full review, a line is yes.\n- Lenses: economics cheap; risk and fit reversible.\n- Actions taken: record written.\n- Open risks and revisit trigger: none; revisit at 10x load.\n- Cost: 4 agents, 34k tokens.\n";
const GOOD = [
  "| PM | opus | adopt A | high | simplest | - | - |",
  "| `engineer:root-fix` | sonnet | for A | medium | cheap | - | 12k |",
  "| `reviewer:risk` | opus | against B | high | breaks X | | 9k |",
  "| `security:authz` | opus | conditions | high | needs a deny test | C1: test the deny path | 8k |",
  "| `techlead:signoff` | opus | adopt A | high | fits | - | 5k |",
].join("\n");
const rec = (rows = GOOD, tail = TRIAGE + SEC, head = HEAD) => head + rows + "\n" + tail;

test("a complete record has no gaps", () => assert.deepEqual(lint(rec()), []));

test("no table, missing columns, no rows and no PM row", () => {
  assert.deepEqual(lint(TRIAGE + SEC), ["no decision table (a header row with Call and Verdict)"]);
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
  assert.match(one("| `security:x` | opus | block | high | r | - | 1k |")[0], /security blocked but a verdict adopts it/, "block is a valid word; the PM adopting past it needs the override line");
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
  assert.equal(lint(rec(GOOD, SEC)).length, 3);
  assert.deepEqual(lint(rec(GOOD, "\n**Security paths:** yes, auth/\n**One-way door:** no\nTouches real: n/a, no production environment\n" + SEC)), []);
  assert.match(lint(rec(GOOD, TRIAGE.replace("Security paths: no", "Security paths: maybe") + SEC))[0], /Security paths: answer must start with yes or no/);
  assert.deepEqual(lint(rec(GOOD, TRIAGE.replace("environment: no", "environment: n/a") + SEC)), [], "n/a is fine for the last line");
});

test("triage lines come after the table, at the start of a line, with the exact label; skipped is not an answer", () => {
  const miss = ["Security paths", "One-way door", "Touches real"].map((n) => `triage line ${n} missing (after the table, at the start of a line, as "${n}:")`);
  assert.deepEqual(lint(TRIAGE.trimStart() + "\n" + HEAD + GOOD + "\n" + SEC), miss, "above the table");
  assert.deepEqual(lint(rec(GOOD, "\nsee Security paths: no\nOne-way door? no\nTouches the profile: no\n" + SEC)), miss, "mid-line or another label");
  assert.match(lint(rec(GOOD, TRIAGE.replace("environment: no", "environment: skipped") + SEC))[0], /Touches real: answer must start with yes, no or n\/a/);
  assert.deepEqual(lint(rec(GOOD, "\nSecurity paths: yes, auth/\n* One-way door: no\nTouches `real`: n/a\n" + SEC)), []);
  assert.deepEqual(lint(rec(GOOD, "\nSecurity paths: yes\nOne-way door: no\nTouches real: no\n" + SEC)), []);
});

test("cli: exit 2 with gap lines, 0 when clean, 64 on bad usage", () => {
  const run = (input, ...a) => spawnSync("node", [join(here, "decision-lint.mjs"), ...a], { encoding: "utf8", input });
  const bad = run(rec(GOOD, SEC), "-");
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /^decision gap: triage line Security paths missing/);
  const ok = run(rec(), "-");
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), "decision ok");
  assert.deepEqual(JSON.parse(run(rec(GOOD, SEC), "-", "--json").stdout).gaps.length, 3);
  assert.equal(run("", "--json").status, 64);
  assert.equal(run("", "/nonexistent.md").status, 64);
});

test("the six sections are required, with the exact label, and not empty or a placeholder", () => {
  for (const sec of ["Decision", "Track and why", "Lenses", "Actions taken", "Open risks and revisit trigger", "Cost"]) {
    const without = SEC.split("\n").filter((l) => !((r) => r.startsWith(sec) && !/^\w/.test(r.slice(sec.length)))(l.replace(/^[-* ]*\**/, ""))).join("\n");
    assert.deepEqual(lint(rec(GOOD, TRIAGE + without)), [`section ${sec} missing (after the table, at the start of a line, as "${sec}:")`], sec);
  }
  assert.deepEqual(lint(rec(GOOD, TRIAGE + SEC.replace("Cost: 4 agents, 34k tokens.", "Cost: ..."))), ["section Cost is empty or a placeholder"]);
  assert.deepEqual(lint(rec(GOOD, TRIAGE + SEC.replace("Cost: 4 agents, 34k tokens.", "Cost:"))), ["section Cost is empty or a placeholder"], "a label with nothing after it");
  assert.deepEqual(lint(rec(GOOD, TRIAGE + SEC.replace("- Cost: 4 agents, 34k tokens.", "- Cost:\n  4 agents, 34k tokens."))), [], "text on the next line counts");
  assert.deepEqual(lint(rec(GOOD, TRIAGE + SEC.replace("Cost: 4 agents, 34k tokens.", "Cost:\n- Lenses: again"))), ["section Cost is empty or a placeholder"], "the next label is not its text");
});

test("PM and tech lead verdicts that differ need an 'override tech lead:' line (DEC-10)", () => {
  const rows = GOOD.replace("| PM | opus | adopt A |", "| PM | opus | adopt B |");
  assert.match(lint(rec(rows))[0], /PM verdict "adopt B" differs from the tech lead's "adopt A": add an "override tech lead: <reason>" line/);
  assert.deepEqual(lint(rec(rows, TRIAGE + SEC + "\noverride tech lead: B fits the migration window\n")), []);
  assert.match(lint(rec(rows, TRIAGE + SEC + "\noverride tech lead:\n"))[0], /override tech lead/, "a reason is needed");
  assert.match(lint(rec(GOOD.replace("| PM | opus | adopt A |", "| PM | opus | reject A |")))[0], /differs/);
  assert.deepEqual(lint(rec(GOOD.replace("| PM | opus | adopt A |", "| PM | opus | Adopt  A |"))), [], "case and spacing do not make a difference");
});

test("DEC-12: only the PM's final verdict counts as adopted, not a tech lead pick the PM overruled", () => {
  const rows = (pm, lead) => [`| PM | opus | adopt ${pm} | high | simplest | - | - |`, "| `engineer:root-fix` | sonnet | for A | medium | cheap | - | 12k |",
    "| `security:authz` | opus | block B | high | breaks the boundary | - | 8k |", `| \`techlead:signoff\` | opus | adopt ${lead} | high | fits | - | 5k |`].join("\n");
  const over = TRIAGE + SEC + "override tech lead: B breaks the boundary, security blocked it\n";
  assert.deepEqual(lint(rec(rows("A", "B"), over)), [], "the tech lead adopted the blocked B, the PM adopted A: no security override");
  assert.match(lint(rec(rows("B", "B")))[0], /security blocked b but a verdict adopts it/, "the PM adopting the blocked B needs the line");
  assert.deepEqual(lint(rec(rows("B", "B"), TRIAGE + SEC + "override security: the owner accepted it\n")), []);
});

test("a security block that a verdict adopts needs an 'override security:' line (DEC-12)", () => {
  const blockA = GOOD.replace("| conditions | high | needs a deny test | C1: test the deny path |", "| block A | high | breaks the boundary | - |");
  assert.match(lint(rec(blockA))[0], /security blocked a but a verdict adopts it: add an "override security: <reason>" line/);
  assert.deepEqual(lint(rec(blockA, TRIAGE + SEC + "override security: the owner accepted the boundary change\n")), []);
  const blockB = blockA.replace("block A", "block B");
  assert.deepEqual(lint(rec(blockB)), [], "blocking another proposal than the adopted one needs no override");
  const bare = blockA.replace("block A", "block");
  assert.match(lint(rec(bare))[0], /security blocked but a verdict adopts it/, "a block naming no proposal covers any adopt");
  assert.deepEqual(lint(rec(blockA.replace(/adopt A/g, "reject A"))), [], "the block is adopted: nothing to override");
});
