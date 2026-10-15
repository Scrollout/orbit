import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoder, checkReviewer } from "./proof-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const run = (args, input) => spawnSync("node", [join(here, "proof-check.mjs"), ...args], { encoding: "utf8", input });
const redGreen = "RED TestA: --- FAIL: TestA\nRED TestA:   a_test.go:9: got 0, want 1\nGREEN TestA: ok  pkg 0.01s\n";

test("coder: red and green lines pass; a missing RED or GREEN, or an empty reason, is a gap", () => {
  assert.deepEqual(checkCoder(redGreen, { tests: ["TestA"] }), []);
  assert.deepEqual(checkCoder("GREEN TestA: ok\n", { tests: ["TestA"] }), ["TestA: no RED excerpt (the test failing without the change)"]);
  assert.deepEqual(checkCoder("RED TestA: FAIL\n"), ["TestA: no GREEN excerpt (the test passing with the change)"]);
  assert.deepEqual(checkCoder("RED TestA:\nGREEN TestA: ok\n"), ["TestA: no RED excerpt (the test failing without the change)"]);
  assert.deepEqual(checkCoder("CANNOT FAIL FIRST docs: docs-only step\n"), []);
  assert.deepEqual(checkCoder("CANNOT FAIL FIRST docs:\n"), ["docs: CANNOT FAIL FIRST needs a reason"]);
});

test("coder: every --tests name needs evidence; a report with none is a gap", () => {
  assert.deepEqual(checkCoder(redGreen, { tests: ["TestA", "TestB"] }), ["TestB: no evidence"]);
  assert.deepEqual(checkCoder("All tests pass.\n"), ["no RED/GREEN or CANNOT FAIL FIRST lines in the report"]);
});

test("coder: list bullets, backticked names and names with colons are read", () => {
  assert.deepEqual(checkCoder("- RED `tests/x.py::test_a`: E assert 0 == 1\n- GREEN `tests/x.py::test_a`: 1 passed\n", { tests: ["tests/x.py::test_a"] }), []);
});

test("coder: test_first_commit asks for a TEST FIRST sha per red test", () => {
  assert.deepEqual(checkCoder(redGreen, { testFirst: true }), ["TestA: test_first_commit is yes but no TEST FIRST <sha> line"]);
  assert.deepEqual(checkCoder(redGreen + "TEST FIRST TestA: 1a2b3c4\n", { testFirst: true }), []);
  assert.deepEqual(checkCoder(redGreen + "TEST FIRST TestA: later\n", { testFirst: true }), ["TestA: test_first_commit is yes but no TEST FIRST <sha> line"]);
  assert.deepEqual(checkCoder("CANNOT FAIL FIRST docs: docs only\n", { testFirst: true }), []);
});

test("reviewer: fails and not checked pass; passes needs a CONFIRMED proof-does-not-prove finding naming the test", () => {
  assert.deepEqual(checkReviewer("PROOF CHECK TestA: fails\n", { tests: ["TestA"] }), []);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA: not checked, no targeted-test command\n"), []);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA: passes\n"), ['TestA: passes without the change but no CONFIRMED "proof does not prove" finding names it']);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA: passes\nx.go:1 PLAUSIBLE: proof does not prove: TestA\n").length, 1);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA: passes\nx.go:1 CONFIRMED: proof does not prove: TestB\n").length, 1);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA: passes\nx_test.go:1 CONFIRMED: proof does not prove: TestA\n"), []);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA: green\n"), ['TestA: PROOF CHECK result must be fails, passes or not checked, got "green"']);
  assert.deepEqual(checkReviewer("No findings.\n"), ["no PROOF CHECK lines in the answer"]);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA: fails\n", { tests: ["TestA", "TestB"] }), ["TestB: no PROOF CHECK line"]);
});

test("cli: exit 0 ok, 2 on a gap, 64 on bad usage; stdin and the profile's test_first_commit are read", () => {
  const ok = run(["--coder", "-"], redGreen);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^proof ok: coder$/m);
  const gap = run(["--reviewer", "-"], "PROOF CHECK TestA: passes\n");
  assert.equal(gap.status, 2);
  assert.match(gap.stdout, /^proof gap: TestA: passes/m);
  assert.equal(run([]).status, 64);
  assert.equal(run(["--coder", "-", "--reviewer", "-"], "").status, 64);
  assert.equal(run(["--coder", join(tmpdir(), "no-such-report.md")]).status, 64);
  const root = mkdtempSync(join(tmpdir(), "pc-"));
  mkdirSync(join(root, ".agents"));
  const prof = readFileSync(join(here, "fixtures", "real-profile.md"), "utf8").replace(/^(ci_policy: .*)$/m, "$1\ntest_first_commit: yes");
  writeFileSync(join(root, ".agents", "project.md"), prof);
  assert.equal(run(["--coder", "-", "--root", root], redGreen).status, 2);
  assert.equal(run(["--coder", "-", "--root", root], redGreen + "TEST FIRST TestA: abcdef1\n").status, 0);
});
