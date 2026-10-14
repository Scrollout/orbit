// Reads the machine block of a project profile and reports gaps instead of guessing. Zero dependencies.
//   node <plugin>/scripts/profile.mjs [--root .] [--profile .agents/project.md] [--json]
// The block is a fenced code block whose info string is `yaml orbit-profile` (templates/project.md).
// Subset of YAML: `key: value`, `key: [a, b]`, or `key:` followed by `- item` lines; `#` starts a comment.
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
};

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
  return out.map(unquote).filter((x) => x !== "");
};

export function parseProfileText(text) {
  const m = text.match(/^```yaml[ \t]+orbit-profile[ \t]*\r?\n([\s\S]*?)^```/m);
  if (!m) return null;
  const data = {};
  let key = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const line = stripComment(raw).replace(/\s+$/, "");
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && key) { (Array.isArray(data[key]) ? data[key] : (data[key] = [])).push(unquote(item[1])); continue; }
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].trim();
    if (v === "") data[key] = "";
    else if (v.startsWith("[") && v.endsWith("]")) data[key] = splitInline(v.slice(1, -1));
    else data[key] = unquote(v);
  }
  return data;
}

export function loadProfile(root, path) {
  const file = resolve(root, path ?? ".agents/project.md");
  if (!existsSync(file)) return { file, data: null };
  return { file, data: parseProfileText(readFileSync(file, "utf8")) };
}

const isTodo = (s) => /^TODO\b/i.test(String(s).trim());
export function gaps(data) {
  const out = [];
  for (const [name, spec] of Object.entries(FIELDS)) {
    const v = data?.[name];
    const missing = v === undefined;
    const empty = missing || (Array.isArray(v) ? v.length === 0 || v.some(isTodo) : v === "" || isTodo(v));
    if (missing && !spec.required) continue;
    if (empty || (spec.enum && !spec.enum.includes(v))) out.push(name);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const { file, data } = loadProfile(flag("root") ?? ".", flag("profile"));
  if (args.includes("--json") && data) console.log(JSON.stringify(data, null, 2));
  const g = gaps(data);
  if (!args.includes("--json") || g.length) for (const f of g) console.log(`profile gap: ${f}`);
  if (g.length && !data) console.error(`profile: no orbit-profile block in ${file}`);
  process.exit(g.length ? 1 : 0);
}
