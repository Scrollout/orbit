// Pins the behaviour of the plain-code pattern helpers (scripts/rx.mjs and the guard helpers) that replaced single regexes the
// static ReDoS check flagged. Each GOLDEN row is [input, result], recorded from the former regex before it was replaced.
// Also: hostile long inputs finish at once (linear time).
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAssign, isMktempAssign } from "../hooks/guard.mjs";
import { DATETIME, changelogHeads, conventional, declaredVersion, keyLine, plainValue, proofLine, sectionBodies, semverExec, violationIds } from "./rx.mjs";

const G1 = {"assign": [["a=1", true], ["a+=1", true], ["a[1]=2", true], ["a[=1", false], ["a[x]+=1", true], ["1a=2", false], ["_x=", true], ["a", false], ["a=\nb", true], ["a[b\nc]=1", true], ["a[]=", true], ["=x", false], ["a [1]=2", false]], "node": [["-e", true], ["-p", true], ["--eval", true], ["--print", true], ["--eval=x", true], ["--print=", true], ["--eval=a\nb", false], ["--evalx", false], ["-ee", false], ["--eval=a\r", false], ["x", false]], "env": [["-S", true], ["-iS", true], ["-S foo", true], ["-Sx\ny", false], ["--split-string", true], ["--split-string=a", true], ["--split-string=a\nb", false], ["-i", false], ["-S\n", false], ["--split-stringx", false], ["-aSb", true]], "mktemp": [["a=$(mktemp)", true], ["a=\"$(mktemp -d)\"", true], ["a=\"$(mktemp -d)", false], ["a=$(mktemp -d)\"", false], ["a=$( mktemp -q -d )", true], ["a=$(mktemp -t foo.XXXX)", true], ["a=$(mktemp -dt foo.XXXX)", true], ["a=$(mktemp -p /x)", false], ["a=$(mktemp -d -d)", true], ["a=$(mktemp --directory --quiet)", true], ["a=$(mktemp -t)", false], ["a=$(mktemp -t x y)", false], ["a=$(mktemp-d)", false], ["1=$(mktemp)", false], ["a=$(mktemp -qdt a-b.c)", true], ["a=$(mktemp\t-d\n)", true]], "semver": [["v1.2.3", ["1", "2", "3", null]], ["v0.0.0", ["0", "0", "0", null]], ["v01.2.3", null], ["v1.02.3", null], ["v1.2.03", null], ["v1.2.3-rc.1", ["1", "2", "3", "rc.1"]], ["v1.2.3-", null], ["v1.2.3+b", ["1", "2", "3", null]], ["v1.2.3-rc+b.1", ["1", "2", "3", "rc"]], ["v1.2.3+", null], ["v1.2.3-a+b+c", null], ["v1.2", null], ["1.2.3", null], ["v1.2.3-a_b", null], ["v10.20.30-x-y.z", ["10", "20", "30", "x-y.z"]], ["v1.2.3\n", null], ["v99999999999999999999.0.0", ["99999999999999999999", "0", "0", null]], ["v1.2.3-+b", null]], "datetime": [["2026-01-02T03:04Z", true], ["2026-01-02T03:04:05Z", true], ["2026-01-02T03:04:05.123Z", true], ["2026-01-02T03:04.5Z", false], ["2026-01-02T03:04:05+01:00", true], ["2026-01-02T03:04-0100", false], ["2026-01-02T03:04:05.Z", false], ["2026-01-02T03:04", false], ["2026-01-02", false], ["2026-01-02T03:04:05.1+00:00\n", false], ["x2026-01-02T03:04Z", false]]};
const G2 = {"proof": [["RED test a -- why", ["RED", "test a", "why"]], ["- GREEN x --", ["GREEN", "x", null]], ["* RED a -- b -- c", ["RED", "a", "b -- c"]], ["RED a --b", null], ["RED  -- x", null], ["RED a -- ", ["RED", "a", ""]], ["RED -- x", null], ["TEST FIRST t -- n", ["TEST FIRST", "t", "n"]], ["  - CANNOT FAIL FIRST z -- q", ["CANNOT FAIL FIRST", "z", "q"]], ["RED a -- x\r", null], ["RED a\u2028b -- c", null], ["RED a -- b\u2028c", null], ["GREEN", null], ["RED a ---", null], ["RED a -- -- b", ["RED", "a", "-- b"]], ["PROOF CHECK p -- ", ["PROOF CHECK", "p", ""]], ["-RED a -- b", null], ["RED a - - b", null]], "plain": [["a: b", "b"], ["- a: b", "b"], ["  a-b:  c: d", "c: d"], ["a:b", null], ["a:   ", " "], ["a: b\r", null], ["- a:\tx", "x"], ["-a: b", null], ["a: b # c", "b # c"], ["k: \"q\"", "\"q\""], ["1a: x", null], ["a:\n", null], ["a: b\u2028c", null], ["  - k:  v", "v"]], "keyline": [["a: b", ["a", "b"]], ["a:", ["a", null]], ["a:b", null], ["\"a b\": c", ["\"a b\"", "c"]], ["'x':y", null], ["'x' : y", ["'x'", "y"]], ["\"x", null], ["a b : c", ["a b", "c"]], ["a : ", ["a", ""]], ["#a: b", null], ["- a: b", ["- a", "b"]], [":x: y", [":x", "y"]], [": y", null], ["a::b", null], ["a: b: c", ["a", "b: c"]], ["a:  ", ["a", ""]], ["a:\t", ["a", ""]], ["k: v\r", null], ["k:\r", ["k", ""]], ["a b c", null], ["\"a\"b: c", null], ["'a':", ["'a'", null]], ["a\u2028: b", ["a", "b"]], ["a: b\u2028c", null], ["a:b: c", null], ["url: http://x", ["url", "http://x"]]], "changelog": [["# C\n\n## 1.2.3\n- a\n\n## 1.2.2\n- b\n", [["1.2.3", "- a\n\n"], ["1.2.2", "- b\n"]]], ["## [v1.2.3-rc.1] - date\nx\n## Unreleased\ny\n## 0.1.0\nz", [["1.2.3-rc.1", "x\n"], ["0.1.0", "z"]]], ["## 1.2.3", []], ["## 1.2.3\n", [["1.2.3", ""]]], ["## 1.2.3-\nbody\n## 1.2.2-x+y\nb2\n", [["1.2.3", "body\n"], ["1.2.2-x", "b2\n"]]], ["## 1.2.3abc\nq\n", [["1.2.3", "q\n"]]], ["## v2.0.0 (x)\n\n\n## 1.0.0\n", [["2.0.0", "\n\n"], ["1.0.0", ""]]], ["intro\n## 1.0.0\na\n##  2.0.0\nb\n## 3.0.0\nc", [["1.0.0", "a\n"], ["3.0.0", "c"]]]], "declared": [["version: 1.2.3", "1.2.3"], ["{\n \"version\": \"v1.2.3-rc.1\"\n}", "1.2.3-rc.1"], ["Version = 1.2.3+b", "1.2.3"], ["x\nVERSION: 1.2.3-a.b\n", "1.2.3-a.b"], ["version:\n  1.2.3", "1.2.3"], ["nope", null], ["version: 1.2", null], ["  \"version\" : '1.2.3'", "1.2.3"], ["version: 1.2.3-", "1.2.3"], ["version: 1.2.3-+x", "1.2.3"], ["# version: 1.2.3\nversion: 2.0.0", "2.0.0"]], "cc": [["feat: x", ["feat", false]], ["fix(scope): y", ["fix", false]], ["feat!: z", ["feat", true]], ["feat(a)!: z", ["feat", true]], ["FEAT: x", ["feat", false]], ["Fix: y", ["fix", false]], ["fix:x", null], ["fixup: x", null], ["feat(a: b", null], ["feat(a\nb): c", ["feat", false]], ["docs(x)(y): z", null], ["chore!:  q", ["chore", true]], ["perf(): ok", ["perf", false]], ["revert: r", ["revert", false]], ["feature: x", null], ["ci(a)!", null], ["test(a)b: c", null], ["build!(a): x", null]], "viol": [["DEC-01 line 3: x\nOPR-09 line 12: y\nLEDGER line 1: z\nnoise\nDEC-01 line 4: w\n", ["DEC-01", "OPR-09", "LEDGER", "DEC-01"]], ["dec-01 line 3:", []], ["DEC- line 3:", []], ["DEC-1line 3:", []], ["A line 1:\nAB-12 line 2:\nA-1 line  3:\n DEC-01 line 3:", ["A", "AB-12"]], ["DEC-01-02 line 3:", []], ["X line 5: ok", ["X"]]], "sections": [["Steps", "## Steps\n| a |\n| - |\n| 1 |\n## Exit tests\nx\n", ["| a |\n| - |\n| 1 |\n"]], ["Steps", "## Steps (x)\nbody\n## Stepsx\nno\n## Steps\nagain", ["body\n", "again"]], ["Steps", "## Steps", []], ["Steps", "## Exit tests\n\n## Steps\n", [""]], ["Steps", "intro\n## Exit tests: t\nrows\n## Next\n", []], ["Steps", "## Exit tests\nA\n## Exit tests\nB", []], ["Exit tests", "## Steps\n| a |\n| - |\n| 1 |\n## Exit tests\nx\n", ["x\n"]], ["Exit tests", "## Steps (x)\nbody\n## Stepsx\nno\n## Steps\nagain", []], ["Exit tests", "## Steps", []], ["Exit tests", "## Exit tests\n\n## Steps\n", ["\n"]], ["Exit tests", "intro\n## Exit tests: t\nrows\n## Next\n", ["rows\n"]], ["Exit tests", "## Exit tests\nA\n## Exit tests\nB", ["A\n", "B"]]]};

test("isAssign", () => { for (const [s, want] of G1.assign) assert.equal(isAssign(s), want, JSON.stringify(s)); });
test("isMktempAssign", () => { for (const [s, want] of G1.mktemp) assert.equal(isMktempAssign(s), want, JSON.stringify(s)); });
test("semverExec", () => {
  for (const [s, want] of G1.semver) {
    const m = semverExec(s);
    assert.deepEqual(m && [m[1], m[2], m[3], m[4] ?? null], want, JSON.stringify(s));
  }
});
test("DATETIME", () => { for (const [s, want] of G1.datetime) assert.equal(DATETIME.test(s), want, JSON.stringify(s)); });
test("plainValue", () => { for (const [s, want] of G2.plain) assert.equal(plainValue(s), want, JSON.stringify(s)); });
test("keyLine", () => {
  for (const [s, want] of G2.keyline) {
    const m = keyLine(s);
    assert.deepEqual(m && [m[1], m[2] ?? null], want, JSON.stringify(s));
  }
});
test("proofLine", () => {
  for (const [s, want] of G2.proof) {
    const m = proofLine(s);
    assert.deepEqual(m && [m[1], m[2], m[3] ?? null], want, JSON.stringify(s));
  }
});
test("changelogHeads", () => { for (const [s, want] of G2.changelog) assert.deepEqual(changelogHeads(s).map((h) => [h[1], h[2]]), want, JSON.stringify(s)); });
test("declaredVersion", () => { for (const [s, want] of G2.declared) assert.equal(declaredVersion(s) ?? null, want, JSON.stringify(s)); });
test("conventional", () => {
  for (const [s, want] of G2.cc) {
    const m = conventional(s);
    assert.deepEqual(m && [m.type.toLowerCase(), m.bang], want, JSON.stringify(s));
  }
});
test("violationIds", () => { for (const [s, want] of G2.viol) assert.deepEqual(violationIds(s), want, JSON.stringify(s)); });
test("sectionBodies", () => { for (const [h, s, want] of G2.sections) assert.deepEqual(sectionBodies(s, h), want, `${h} ${JSON.stringify(s)}`); });

test("hostile long inputs finish at once", () => {
  const n = 200000, t0 = Date.now();
  const big = ["a=" + "[".repeat(n), "a[" + "x".repeat(n), "-" + "S".repeat(n), "v1.2.3-" + "a".repeat(n) + "!", "k:" + " ".repeat(n) + "\u2028",
    "RED " + "a --".repeat(n / 4) + "\n", "x ".repeat(n) + ":", "## 1.0.0" + "-".repeat(n) + "\n" + "## ".repeat(n / 3)];
  for (const s of big) { isAssign(s); isMktempAssign(s); semverExec(s); DATETIME.test(s); plainValue(s); keyLine(s); proofLine(s); changelogHeads(s); declaredVersion(s); conventional(s); sectionBodies(s, "Steps"); }
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});
