// Reads the machine block of a project profile and reports gaps instead of guessing. Zero dependencies.
//   node <plugin>/scripts/profile.mjs [--root .] [--profile .agents/project.md] [--json]
// The block is a fenced code block whose info string is `yaml orbit-profile` (templates/project.md).
// Subset of YAML: `key: value`, `key: [a, b]`, or `key:` followed by `- item` lines (indented or at column 0); `#` starts a comment.
// A security_paths entry that is empty, `/`, `./` or `.` has no segment and would match every file: it is a gap.
// Output: one `profile gap: <field>` line per missing, empty or TODO field; exit 1 if any. --json prints the parsed block.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FIELDS = {
  base_branch: { required: true },
  security_paths: { required: true, list: true },
  review_trailer: { required: true },
  labels: { required: true, list: true },
  issue_tracker: { required: true },
  base_pusher: { required: true, enum: ["agent", "owner"] },
  ci_policy: { required: true, enum: ["ci-only", "local-full"] },
  production_env: { required: false },
  standing_waivers: { required: false, list: true },
  ledger_path: { required: false },
  // Releases (OPR-09). Optional: unset means the audit checks release events but not when they are due.
  release_when: { required: false, enum: ["change-set", "milestone", "never"] },
  release_via: { required: false, enum: ["ci", "session"] },
  release_tool: { required: false, enum: ["none", "release-please", "changesets", "semantic-release", "goreleaser", "other"] },
  changelog: { required: false },
  version_files: { required: false, list: true },
  // DEC-21, DEC-22 apply only with tdd: yes (unset means no). test_first_commit: yes asks the coder to commit the failing
  // test before the fix; it means something only with tdd: yes (loadProfile warns otherwise).
  tdd: { required: false, enum: ["no", "yes", "auto"] },   // auto: resolved per step at triage by tdd-suggest.mjs
  // the targeted-test command (e.g. `make test-one PKG={pkg}`); required with tdd: yes
  targeted_test: { required: false },
  test_first_commit: { required: false, enum: ["no", "yes"] },
};
export const RELEASE_FIELDS = ["release_when", "release_via", "release_tool", "changelog", "version_files"];

const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
const stripComment = (s) => {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
};
const splitInline = (s) => {
  const out = [];
  let cur = "", q = null;
  for (const c of s) {
    if (q) { if (c === q) q = null; cur += c; } else if (c === '"' || c === "'") { q = c; cur += c; }
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map(unquote);
};

export function parseProfileText(text, warnings = []) {
  const m = text.match(/^```yaml[ \t]+orbit-profile[ \t]*\r?\n([\s\S]*?)^```/m);
  if (!m) return null;
  const data = Object.create(null);
  let key = null, skip = false;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = stripComment(raw).replace(/\s+$/, "");
    if (!line.trim()) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) {
      if (skip) continue;
      if (typeof data[key] === "string" && data[key] !== "" || (Array.isArray(data[key]) && data[key].inline)) {
        warnings.push(`${key}: list items after a scalar`);
        delete data[key]; skip = true; continue;
      }
      (Array.isArray(data[key]) ? data[key] : (data[key] = [])).push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    skip = false;
    if (key === "__proto__") { warnings.push("ignored key __proto__"); skip = true; continue; }
    if (key in data) warnings.push(`duplicate key ${key}`);
    const v = kv[2].trim();
    if (v === "") data[key] = "";
    else if (v.startsWith("[") && v.endsWith("]")) {
      const inner = v.slice(1, -1);
      // security_paths keeps an empty entry ([a/, , b]) so gaps() can report it; every other list drops them
      data[key] = inner.trim() ? splitInline(inner).filter((x) => key === "security_paths" || x !== "") : [];
      Object.defineProperty(data[key], "inline", { value: true });
    }
    else data[key] = unquote(v);
  }
  return data;
}

export function loadProfile(root, path) {
  const file = resolve(root, path ?? ".agents/project.md");
  if (!existsSync(file)) return { file, data: null, warnings: [] };
  const warnings = [];
  const data = parseProfileText(readFileSync(file, "utf8"), warnings);
  if (data?.test_first_commit === "yes" && data.tdd !== "yes") warnings.push("test_first_commit is yes but tdd is not yes: it has no effect");
  return { file, data, warnings };
}

// The segments of a glob, as globMatch reads them; none (`""`, `/`, `./`, `//`) would match every file.
const globSegments = (g) => g.trim().replace(/^\.?\//, "").split("/").filter(Boolean).filter((x) => x !== ".");
const isTodo = (s) => /^TODO\b/i.test(String(s).trim());
export function gaps(data) {
  const out = [];
  for (const [name, spec] of Object.entries(FIELDS)) {
    const v = data?.[name];
    const missing = v === undefined;
    const empty = missing || (spec.list && !Array.isArray(v)) || (Array.isArray(v) ? (v.length === 0 && spec.required) || v.some(isTodo) : v === "" || isTodo(v));
    if (missing && !spec.required) continue;
    const matchAll = name === "security_paths" && Array.isArray(v) && v.some((x) => globSegments(String(x)).length === 0);
    if (empty || matchAll || (spec.enum && !spec.enum.includes(v))) out.push(name);
  }
  if (data?.tdd === "yes" && data.targeted_test === undefined) out.push("targeted_test");
  return out;
}

// Globs, matched segment by segment (no regular expressions, so no ReDoS): patterns are anchored at the repo root and
// case-sensitive; `*` and `?` stay inside one path segment (`*` any run, `?` one character); a `**` segment matches
// zero or more whole segments (`**/Makefile` matches it at any depth); a pattern also covers everything below the
// path it matches (a directory pattern such as `ci/`, `ci` or `ci/*` covers its files); a leading `./` or `/` is
// ignored; braces and character classes are not supported (taken literally).
function segMatch(p, s) {
  let pi = 0, si = 0, star = -1, mark = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) { pi++; si++; }
    else if (pi < p.length && p[pi] === "*") { star = pi++; mark = si; }
    else if (star >= 0) { pi = star + 1; si = ++mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}
export function globMatch(glob, file) {
  const ps = glob.replace(/^\.?\//, "").split("/").filter(Boolean).map((x) => (x === "**" ? x : x.replace(/\*+/g, "*")));
  const fs = file.split("/").filter(Boolean);
  const memo = new Map();
  const go = (i, j) => {
    if (i === ps.length) return true;
    const k = i * (fs.length + 1) + j;
    if (memo.has(k)) return memo.get(k);
    let r = false;
    if (ps[i] === "**") { for (let t = j; t <= fs.length && !r; t++) r = go(i + 1, t); }
    else r = j < fs.length && segMatch(ps[i], fs[j]) && go(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return go(0, 0);
}
export const matchesAny = (file, globs) => globs.some((g) => globMatch(g, file));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const { file, data, warnings } = loadProfile(flag("root") ?? ".", flag("profile"));
  for (const w of warnings) console.error(`profile warning: ${w}`);
  if (args.includes("--json") && data) console.log(JSON.stringify(data, null, 2));
  const g = gaps(data);
  if (!args.includes("--json") || g.length) for (const f of g) console.log(`profile gap: ${f}`);
  if (g.length && !data) console.error(`profile: no orbit-profile block in ${file}`);
  process.exit(g.length ? 1 : 0);
}
