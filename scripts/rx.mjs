// Pattern helpers kept as plain code or simple regexes (no nested quantifiers, linear time), so the static-analysis
// ReDoS checks stay quiet and the behaviour is pinned by scripts/rx.test.mjs. No side effects: importable by tests.

const IDENT = /^[0-9A-Za-z.-]+$/;
const LINE_END = /[\n\r\u2028\u2029]/; // what `.` does not match

// vMAJOR.MINOR.PATCH[-pre][+build], no leading zeros; the exec-like array [tag, major, minor, patch, pre] or null.
export const semverExec = (s) => {
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (!m || m.slice(1).some((n) => n.length > 1 && n[0] === "0")) return null;
  let rest = s.slice(m[0].length), pre;
  if (rest[0] === "-") {
    const plus = rest.indexOf("+");
    pre = plus < 0 ? rest.slice(1) : rest.slice(1, plus);
    if (!IDENT.test(pre)) return null;
    rest = plus < 0 ? "" : rest.slice(plus);
  }
  if (rest !== "" && !(rest[0] === "+" && IDENT.test(rest.slice(1)))) return null;
  return [s, m[1], m[2], m[3], pre];
};

// ISO 8601 datetime with a UTC offset: YYYY-MM-DDTHH:MM[:SS[.frac]](Z|+HH:MM). The seconds and fraction are optional.
const DT_RE = [
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/,
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+(?:Z|[+-]\d{2}:\d{2})$/,
];
export const DATETIME = { test: (s) => DT_RE.some((re) => re.test(s)) };

// `key: value` of a plain YAML line (optionally after `- `): the value, or null. A value holding a line terminator gives null.
export function plainValue(line) {
  let t = line.trimStart();
  if (/^-\s/.test(t)) t = t.slice(1).trimStart();
  const m = /^[A-Za-z_][\w-]*:/.exec(t);
  const after = m ? t.slice(m[0].length) : "";
  if (!/^\s/.test(after)) return null;
  const rest = after.trimStart();
  if (rest !== "") return LINE_END.test(rest) ? null : rest;
  // Blanks only: the former pattern gave the last blank to the value when at least two followed the colon.
  const last = after[after.length - 1];
  return after.length >= 2 && !LINE_END.test(last) ? last : null;
}

// A YAML `key: rest` line of the small parser: [line, key, rest|undefined] or null. The key is quoted or runs to the first
// colon; after the colon comes the end of the line or whitespace and the rest.
export function keyLine(t) {
  let key, p;
  if (t[0] === '"' || t[0] === "'") {
    const e = t.indexOf(t[0], 1);
    if (e < 0) return null;
    key = t.slice(0, e + 1); p = e + 1;
    const gap = /^\s*/.exec(t.slice(p))[0].length;
    if (t[p + gap] !== ":") return null;
    p += gap;
  } else {
    if (t === "" || /[\s"'#]/.test(t[0])) return null;
    p = t.indexOf(":", 1);
    if (p < 0) return null;
    key = t.slice(0, p).trimEnd();
  }
  const after = t.slice(p + 1);
  if (after === "") return [t, key, undefined];
  if (!/^\s/.test(after)) return null;
  const rest = after.trimStart();
  return LINE_END.test(rest) ? null : [t, key, rest];
}

// `- RED test name -- reason` style proof lines: [line, label, text, note|undefined] or null.
const PROOF_LABELS = ["RED", "GREEN", "CANNOT FAIL FIRST", "TEST FIRST", "PROOF CHECK"];
export function proofLine(raw) {
  let t = raw.trimStart();
  if (/^[-*]\s/.test(t)) t = t.slice(1).trimStart();
  const label = PROOF_LABELS.find((l) => t.startsWith(`${l} `));
  if (!label) return null;
  const rest = t.slice(label.length + 1);
  for (let j = rest.indexOf(" --", 1); j > 0; j = rest.indexOf(" --", j + 1)) {
    const text = rest.slice(0, j), tail = rest.slice(j + 3);
    if (LINE_END.test(text)) return null;
    if (tail === "") return [raw, label, text, undefined];
    if (tail[0] === " " && !LINE_END.test(tail.slice(1))) return [raw, label, text, tail.slice(1)];
  }
  return null;
}

// `## X.Y.Z[-pre]` changelog sections: [header line, version, body up to the next `## ` line], newest first as written.
export function changelogHeads(text) {
  const out = [];
  for (const m of text.matchAll(/^## \[?v?(\d+\.\d+\.\d+)([0-9A-Za-z.-]*)[^\n]*\n/gm)) {
    const start = m.index + m[0].length;
    const next = /^## /gm;
    next.lastIndex = start;
    const n = next.exec(text);
    out.push([m[0], m[1] + (m[2].length > 1 && m[2][0] === "-" ? m[2] : ""), text.slice(start, n ? n.index : text.length)]);
  }
  return out;
}

// The body of the `## <heading>` sections (a heading ends at a word boundary), one string per section.
export function sectionBodies(text, heading) {
  const out = [];
  for (const m of text.matchAll(/^## [^\n]*\n/gm)) {
    const line = m[0].slice(3);
    if (!line.startsWith(heading) || /\w/.test(line[heading.length] ?? "") === /\w$/.test(heading)) continue;
    const start = m.index + m[0].length;
    const next = /^## /gm;
    next.lastIndex = start;
    const n = next.exec(text);
    out.push(text.slice(start, n ? n.index : text.length));
  }
  return out;
}

// Version declared in a version file: `version: 1.2.3`, `"version": "v1.2.3-rc.1"`, `Version = 1.2.3`; or undefined.
export function declaredVersion(text) {
  const m = /^\s*"?version"?\s*[:=]\s*["']?v?(\d+\.\d+\.\d+)/im.exec(text);
  if (!m) return undefined;
  const pre = /^-[0-9A-Za-z.-]+/.exec(text.slice(m.index + m[0].length));
  return m[1] + (pre ? pre[0] : "");
}

// A Conventional Commits subject: { type, bang } or null.
const CC = ["feat", "fix", "docs", "chore", "refactor", "perf", "test", "build", "ci", "style", "revert"];
export function conventional(subject) {
  const t = CC.find((c) => subject.slice(0, c.length).toLowerCase() === c);
  if (!t) return null;
  let rest = subject.slice(t.length);
  if (rest[0] === "(") {
    const close = rest.indexOf(")");
    if (close < 0) return null;
    rest = rest.slice(close + 1);
  }
  const bang = rest[0] === "!";
  if (bang) rest = rest.slice(1);
  return /^:\s/.test(rest) ? { type: subject.slice(0, t.length), bang } : null;
}

// The `ID` of every `ID line N:` line of an audit output (ID: CAPITALS, optionally -digits).
export function violationIds(stdout) {
  const ids = [];
  for (const line of stdout.split("\n")) {
    const word = /^[A-Z]+/.exec(line)?.[0];
    if (!word) continue;
    const num = /^-\d+/.exec(line.slice(word.length))?.[0] ?? "";
    if (/^ line \d+:/.test(line.slice(word.length + num.length))) ids.push(word + num);
  }
  return ids;
}
