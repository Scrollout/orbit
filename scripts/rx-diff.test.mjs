// Differential test: each plain-code helper that replaced a regex (scripts/rx.mjs, hooks/guard.mjs) against the FORMER regex,
// copied here as the reference, over a seeded generated input set (random token strings from per-pattern alphabets, every
// short combination of the alphabet's first tokens, and long hostile strings). Any divergence fails with the input.
// The reference patterns are the ones the static ReDoS check flagged: they are listed in ci/eslint-baseline.json for this file only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SCRIPTERS, isAssign, isEnvSplit, isMktempAssign } from "../hooks/guard.mjs";
import { DATETIME, changelogHeads, conventional, declaredVersion, hasBareRefs, keyLine, plainValue, proofLine, sectionBodies, semverExec, violationIds } from "./rx.mjs";

let seed = 20261015;
const rnd = (n) => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) % n); }; // mulberry32
const randomStrings = (alphabet, count, maxTokens) => {
  const out = new Set(["", ...alphabet]);
  for (const a of alphabet.slice(0, 8)) for (const b of alphabet.slice(0, 8)) for (const c of alphabet.slice(0, 6)) out.add(a + b + c);
  while (out.size < count) { let s = ""; for (let k = rnd(maxTokens + 1); k > 0; k--) s += alphabet[rnd(alphabet.length)]; out.add(s); }
  return [...out];
};
const hostile = (alphabet) => alphabet.flatMap((t) => [t.repeat(20000), "a" + t.repeat(20000) + "!", t.repeat(5000) + "\n"]);
// The hostile inputs run the new helper only (the former regexes are the slow ones there); `want` is a thunk for that reason.
let hostilePhase = false;
const diff = (name, alphabet, same, { count = 12000, maxTokens = 9 } = {}) => test(name, () => {
  hostilePhase = false;
  for (const s of randomStrings(alphabet, count, maxTokens)) same(s);
  hostilePhase = true;
  const t0 = Date.now();
  try { for (const s of hostile(alphabet)) same(s); } finally { hostilePhase = false; }
  assert.ok(Date.now() - t0 < 20000, `hostile inputs took ${Date.now() - t0} ms`);
});
const eq = (got, want, s) => { if (!hostilePhase) assert.deepEqual(got, want(), JSON.stringify(s.length > 80 ? `${s.slice(0, 60)}...(${s.length})` : s)); };

const ASSIGN = /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/;
diff("isAssign", ["a", "_", "1", "[", "]", "+", "=", "x", "\n", " ", "-", "$", "\r"], (s) => eq(isAssign(s), () => ASSIGN.test(s), s));

const NODE = /^(-e|--eval(=.*)?|-p|--print(=.*)?)$/;
diff("SCRIPTERS.node", ["-", "e", "p", "v", "a", "l", "=", "x", "\n", "print", "eval", "--", "\r", "\u2028", "\u2029", "E"], (s) => eq(SCRIPTERS.node.test(s), () => NODE.test(s), s));

const ENV_S = /^(-[a-zA-Z]*S.*|--split-string(=.*)?)$/;
diff("isEnvSplit", ["-", "S", "s", "i", "u", "=", "x", "\n", "--split-string", "split", "\r", "\u2028", " ", "0"], (s) => eq(isEnvSplit(s), () => ENV_S.test(s), s));

const MKTEMP = /^([A-Za-z_]\w*)=("?)\$\(\s*mktemp((\s+(-d|-q|--directory|--quiet|-[dq]*t\s+[\w.-]+))*)\s*\)\2$/;
diff("isMktempAssign", ["a", "=", "\"", "$(", ")", "mktemp", " ", "-d", "-q", "-t", "-dt", "x.XXXX", "--directory", "--quiet", "\t", "\n", "-p", "/tmp", "'"],
  (s) => eq(isMktempAssign(s), () => MKTEMP.test(s), s), { count: 30000, maxTokens: 12 });
// Structured: a correct assignment shape with random option runs.
test("isMktempAssign: structured options", () => {
  const opts = ["-d", "-q", "--directory", "--quiet", "-t", "-dt", "-qt", "-dqt", "n.X", "a-b", "-x", "-d-q", "", " "];
  for (let i = 0; i < 20000; i++) {
    let o = ""; for (let k = rnd(6); k > 0; k--) o += [" ", "\t", "\n", ""][rnd(4)] + opts[rnd(opts.length)];
    const q = ["", '"'][rnd(2)], close = ["", '"', " "][rnd(3)];
    const s = `a=${q}$(${["", " "][rnd(2)]}mktemp${o}${[" ", ""][rnd(2)]})${close}`;
    eq(isMktempAssign(s), () => MKTEMP.test(s), s);
  }
});

const SEMVER = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
diff("semverExec", ["v", "0", "1", "12", "07", ".", "-", "+", "a", "rc", "_", "\n", "9"], (s) => {
  const n = semverExec(s);
  eq(n && [n[1], n[2], n[3], n[4] ?? null], () => { const m = SEMVER.exec(s); return m && [m[1], m[2], m[3], m[4] ?? null]; }, s);
}, { count: 30000, maxTokens: 12 });

const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
test("DATETIME", () => {
  const pick = (a) => a[rnd(a.length)];
  for (let i = 0; i < 30000; i++) {
    const s = `${pick(["2026", "26", "20260"])}-${pick(["01", "1", "13"])}-${pick(["02", "2"])}${pick(["T", " ", "t"])}${pick(["03", "3"])}:${pick(["04", "4"])}${pick(["", ":05", ":5", ":05.1", ":05.", ":05.123", ".5"])}${pick(["Z", "z", "+01:00", "-0100", "+1:00", "", "+01:00\n", "Z "])}`;
    eq(DATETIME.test(s), () => DT.test(s), s);
  }
  const t0 = Date.now();
  for (const s of ["0".repeat(100000), "2026-01-02T03:04:05." + "1".repeat(100000) + "x"]) DATETIME.test(s);
  assert.ok(Date.now() - t0 < 5000);
});

const KV = /^\s*(?:-\s+)?[A-Za-z_][\w-]*:\s+(.+)$/;
diff("plainValue", ["a", "k", "_", "-", ":", " ", "\t", "b", "#", "\r", "\n", "\u2028", "\"", "x", "1", "\u00a0"], (s) => eq(plainValue(s), () => { const m = s.match(KV); return m ? m[1] : null; }, s), { count: 30000, maxTokens: 12 });

const KL = /^("[^"]*"|'[^']*'|[^\s"'#][^:]*?)\s*:(?:\s+(.*))?$/;
diff("keyLine", ["a", "b", ":", " ", "\t", "\"", "'", "#", "-", "x y", "\r", "\n", "\u2028", "http", "//", "1"], (s) => {
  const n = keyLine(s);
  eq(n && [n[1], n[2] ?? null], () => { const m = s.match(KL); return m && [m[1], m[2] ?? null]; }, s);
}, { count: 40000, maxTokens: 12 });

const PL = /^\s*(?:[-*]\s+)?(RED|GREEN|CANNOT FAIL FIRST|TEST FIRST|PROOF CHECK) (.+?) --(?: (.*))?$/;
diff("proofLine", ["RED", "GREEN", "TEST FIRST", "CANNOT FAIL FIRST", "PROOF CHECK", " ", "--", "-", "a", "b", "\n", "\r", "*", " --", "\u2028", "\t"], (s) => {
  const n = proofLine(s);
  eq(n && [n[1], n[2], n[3] ?? null], () => { const m = s.match(PL); return m && [m[1], m[2], m[3] ?? null]; }, s);
}, { count: 40000, maxTokens: 10 });

const CH = /^## \[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm;
diff("changelogHeads", ["## ", "1.2.3", "v", "[", "]", "-", "rc", ".", "\n", "x", " ", "+", "0", "##", "\r", "\u2028", "1.0.0-a"], (s) =>
  eq(changelogHeads(s).map((h) => [h[1], h[2]]), () => [...s.matchAll(CH)].map((m) => [m[1], m[2]]), s), { count: 20000, maxTokens: 12 });

const DV = /^\s*(?:"?version"?|Version)\s*[:=]\s*["']?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/im;
diff("declaredVersion", ["version", "Version", "VERSION", "\"", "'", ":", "=", " ", "\n", "v", "1.2.3", "-", "rc", "+", "x", "\r", "#", "\u2028", "1.2"], (s) => {
  eq(declaredVersion(s) ?? null, () => { const m = s.match(DV); return m ? m[1] : null; }, s);
}, { count: 30000, maxTokens: 10 });

const CC = /^(feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert)(?:\([^)]*\))?(!)?:\s/i;
diff("conventional", ["feat", "fix", "docs", "chore", "perf", "ci", "revert", "FEAT", "Fix", "(", ")", "!", ":", " ", "a", "\n", "x", "\t", "refactor", "style", "build", "test"], (s) => {
  const n = conventional(s);
  eq(n && [n.type.toLowerCase(), n.bang], () => { const m = s.match(CC); return m && [m[1].toLowerCase(), !!m[2]]; }, s);
}, { count: 30000, maxTokens: 7 });

const V = /^([A-Z]+(?:-\d+)?) line \d+:/gm;
diff("violationIds", ["DEC", "OPR", "LEDGER", "A", "-", "01", "1", " line ", "line", " ", "3", ":", "\n", "x", "\r", "a"], (s) =>
  eq(violationIds(s), () => [...s.matchAll(V)].map((m) => m[1]), s), { count: 20000, maxTokens: 12 });

const section = (text, heading) => [...text.matchAll(new RegExp(`^## ${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "gm"))].map((m) => m[1]);
for (const heading of ["Steps", "Exit tests"]) {
  diff(`sectionBodies ${heading}`, ["## ", heading, `${heading}x`, " ", "\n", "(", "x", "|", "##", "\r", "-", "_"], (s) => eq(sectionBodies(s, heading), () => section(s, heading), s), { count: 15000, maxTokens: 12 });
}

const BARE = /(^|[^/\w}])(skills\/\w+\/)?refs\/[\w-]+(\/[\w-]+)?\.md/m;
diff("hasBareRefs", ["refs/", "skills/", "x/", "a", ".md", "-", "/", "}", " ", "\n", "${P}/", "b", "_"], (s) => eq(hasBareRefs(s), () => BARE.test(s), s), { count: 30000, maxTokens: 10 });
