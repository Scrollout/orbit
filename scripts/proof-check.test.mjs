import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoder, checkReviewer, coderTests, namesExactly } from "./proof-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const run = (args, input) => spawnSync("node", [join(here, "proof-check.mjs"), ...args], { encoding: "utf8", input });
const redGreen = "RED TestA -- --- FAIL: TestA\nRED TestA --   a_test.go:9: got 0, want 1\nGREEN TestA -- ok  pkg 0.01s\n";
const tmpFile = (text) => { const f = join(mkdtempSync(join(tmpdir(), "pc-")), "r.md"); writeFileSync(f, text); return f; };

test("coder: red and green lines pass; a missing RED or GREEN, or an empty reason, is a gap", () => {
  assert.deepEqual(checkCoder(redGreen, { tests: ["TestA"] }), []);
  assert.deepEqual(checkCoder("GREEN TestA -- ok\n", { tests: ["TestA"] }), ["TestA: no RED line (the test failing without the change)"]);
  assert.deepEqual(checkCoder("RED TestA -- FAIL\n"), ["TestA: no GREEN line (the test passing with the change)"]);
  assert.deepEqual(checkCoder("RED TestA --\nGREEN TestA -- ok\n"), ["TestA: no RED line (the test failing without the change)"]);
  assert.deepEqual(checkCoder("CANNOT FAIL FIRST docs -- docs-only step\n"), []);
  assert.deepEqual(checkCoder("CANNOT FAIL FIRST TestA -- no targeted-test command in the profile\n"), []);
  assert.deepEqual(checkCoder("CANNOT FAIL FIRST docs --\n"), ["docs: CANNOT FAIL FIRST needs a reason"]);
  assert.deepEqual(checkCoder("CANNOT FAIL FIRST TestA -- refactor\nRED TestA -- FAIL\n"), ["TestA: both RED and CANNOT FAIL FIRST"]);
});

test("coder: every --test name needs evidence; a report with none is a gap", () => {
  assert.deepEqual(checkCoder(redGreen, { tests: ["TestA", "TestB"] }), ["TestB: no evidence"]);
  assert.deepEqual(checkCoder("All tests pass.\n"), ["no RED/GREEN or CANNOT FAIL FIRST lines in the report"]);
});

test("names are exact and end at the first ` -- `: pytest ids, jest names with colons and spaces, Go subtests", () => {
  const py = "tests/x.py::test_a[1-2]", jest = "cart: total > adds tax: 2 items";
  const text = `- RED ${py} -- E assert 0 == 1\n- GREEN ${py} -- 1 passed\nRED ${jest} -- expected 3\nGREEN ${jest} -- ok\nRED TestA/sub -- FAIL\nGREEN TestA/sub -- PASS\n`;
  assert.deepEqual(coderTests(text).required, [py, jest, "TestA/sub"]);
  assert.deepEqual(checkCoder(text, { tests: [py, jest, "TestA/sub"] }), []);
  assert.deepEqual(checkCoder(text, { tests: ["TestA"] }), ["TestA: no evidence"]);
  assert.deepEqual(checkCoder("RED `TestA` -- FAIL\nGREEN `TestA` -- ok\n", { tests: ["TestA"] }), ["TestA: no evidence"], "backticks are part of the name");
});

test("coder: test_first_commit asks for a TEST FIRST sha per proved test", () => {
  assert.deepEqual(checkCoder(redGreen, { testFirst: true }), ["TestA: test_first_commit is yes but no TEST FIRST <sha> line"]);
  assert.deepEqual(checkCoder(redGreen + "TEST FIRST TestA -- 1a2b3c4\n", { testFirst: true }), []);
  assert.deepEqual(checkCoder(redGreen + "TEST FIRST TestA -- later\n", { testFirst: true }), ["TestA: test_first_commit is yes but no TEST FIRST <sha> line"]);
  assert.deepEqual(checkCoder("CANNOT FAIL FIRST docs -- docs only\n", { testFirst: true }), []);
});

test("reviewer: results are fails, passes, not checked with a reason, or exempt for a CANNOT FAIL FIRST test", () => {
  const req = { required: ["TestA"], exempt: [] };
  assert.deepEqual(checkReviewer("PROOF CHECK TestA -- fails\n", req), []);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA -- not checked: build fails with the production part reverted\n", req), []);
  assert.equal(checkReviewer("PROOF CHECK TestA -- not checked\n", req).length, 2, "a reason is required");
  assert.deepEqual(checkReviewer("PROOF CHECK TestA -- exempt\n", req)[0], "TestA: exempt only for a test the coder declared CANNOT FAIL FIRST");
  assert.deepEqual(checkReviewer("PROOF CHECK TestA -- green\n", req)[0], 'TestA: PROOF CHECK must be fails, passes, not checked: <reason> or exempt, got "green"');
  assert.deepEqual(checkReviewer("No findings.\n", req), ["TestA: no PROOF CHECK line"]);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA -- fails\n", { required: ["TestA", "TestB"] }), ["TestB: no PROOF CHECK line"]);
});

test("reviewer: exempt tests need no line; a review with only exempt tests needs no PROOF CHECK at all", () => {
  const ex = { required: [], exempt: ["docs"] };
  assert.deepEqual(checkReviewer("No findings.\n", ex), []);
  assert.deepEqual(checkReviewer("PROOF CHECK docs -- exempt, the reason holds: docs only\n", ex), []);
  assert.deepEqual(checkReviewer("PROOF CHECK docs -- not checked: no targeted-test command in the profile\n", ex), []);
});

test("reviewer: passes needs a CONFIRMED proof-does-not-prove finding naming exactly that test", () => {
  const req = { required: ["TestA"] };
  const gap = ['TestA: passes without the change but no CONFIRMED "proof does not prove" finding names it'];
  assert.deepEqual(checkReviewer("PROOF CHECK TestA -- passes\n", req), gap);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA -- passes\nx.go:1 PLAUSIBLE: proof does not prove: TestA\n", req), gap);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA -- passes\nx.go:1 CONFIRMED: proof does not prove: TestAB\n", req), gap);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA -- passes\nx.go:1 CONFIRMED: proof does not prove: TestA/sub\n", req), gap);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA -- passes\nx_test.go:1 CONFIRMED: proof does not prove: TestA.\n", req), []);
  assert.deepEqual(checkReviewer("PROOF CHECK TestA -- passes\nx_test.go:1 Confirmed - Proof does not prove: `TestA`\n", req), []);
  assert.ok(namesExactly("proof does not prove: tests/x.py::test_a[1]", "tests/x.py::test_a[1]"));
  assert.ok(!namesExactly("proof does not prove: tests/x.py::test_a[1]", "tests/x.py::test_a"));
});

test("cli: exit 0 ok, 2 on a gap, 64 on bad usage; repeated --test; stdin; --coder-report derives the reviewer's list", () => {
  const ok = run(["--coder", "-", "--test", "TestA"], redGreen);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^proof ok: coder$/m);
  assert.equal(run(["--coder", "-", "--test", "TestA", "--test", "TestB"], redGreen).status, 2);
  const j = JSON.parse(run(["--coder", "-", "--json"], redGreen + "CANNOT FAIL FIRST docs -- docs only\n").stdout);
  assert.deepEqual(j, { required: ["TestA"], exempt: ["docs"], gaps: [] });
  const report = tmpFile(redGreen + "CANNOT FAIL FIRST docs -- docs only\n");
  assert.equal(run(["--reviewer", "-", "--coder-report", report], "PROOF CHECK TestA -- fails\n").status, 0);
  const miss = run(["--reviewer", "-", "--coder-report", report], "No findings.\n");
  assert.equal(miss.status, 2);
  assert.match(miss.stdout, /^proof gap: TestA: no PROOF CHECK line$/m);
  assert.equal(run(["--reviewer", "-", "--coder-report", tmpFile("CANNOT FAIL FIRST docs -- docs only\n")], "No findings.\n").status, 0);
  assert.equal(run(["--reviewer", "-"], "PROOF CHECK TestA -- fails\n").status, 64, "the reviewer needs the required list");
  assert.equal(run(["--reviewer", "-", "--test", "TestA"], "PROOF CHECK TestA -- fails\n").status, 0);
  assert.equal(run([]).status, 64);
  assert.equal(run(["--coder", "-", "--reviewer", "-"], "").status, 64);
  assert.equal(run(["--coder", "-", "--test"], redGreen).status, 64);
  assert.equal(run(["--coder", join(tmpdir(), "no-such-report.md")]).status, 64);
});

test("cli: the profile's test_first_commit is read", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-"));
  mkdirSync(join(root, ".agents"));
  const prof = readFileSync(join(here, "fixtures", "real-profile.md"), "utf8").replace(/^(ci_policy: .*)$/m, "$1\ntest_first_commit: yes");
  writeFileSync(join(root, ".agents", "project.md"), prof);
  assert.equal(run(["--coder", "-", "--root", root], redGreen).status, 2);
  assert.equal(run(["--coder", "-", "--root", root], redGreen + "TEST FIRST TestA -- abcdef1\n").status, 0);
});
