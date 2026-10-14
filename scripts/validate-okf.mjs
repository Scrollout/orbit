// Docs lint for an OKF v0.2 bundle and the agent entry files. Zero dependencies.
//   node <plugin>/scripts/validate-okf.mjs [--root .] [--config .agents/okf.json] [--bundle docs/okf]
//     [--max-doc-chars 4000] [--max-agents-lines 80] [--agents-file AGENTS.md]
//     [--pointer-files CLAUDE.md,GEMINI.md] [--max-pointer-lines 6] [--okf-version 0.2]
// Settings: flags beat the JSON config (default <root>/.agents/okf.json, optional) beat the defaults below.
// Config keys: bundle, maxDocChars, maxAgentsLines, agentsFile, pointerFiles (array), maxPointerLines, okfVersion.
// Checks: the spec's conformance (frontmatter with a non-empty `type`, reserved index.md and log.md) plus the doc rules
// (skills/okf/SKILL.md): title, description, a TL;DR line, a size cap, every doc indexed, links that resolve,
// timestamps with a UTC offset, quoted YAML values that hold ': ', footnotes that match `sources`, the v0.2 trust and
// provenance fields (generated.by, verified by/at, actors, sources[].resource, usage_window), and vendor instruction
// files that only point to AGENTS.md. Warnings (printed as `warn:`, exit stays 0): a human-verified doc with status
// draft, an actor off the §7 convention, and an index line that does not include the doc's frontmatter description
// (SPEC §8, a SHOULD; case and a trailing period ignored).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const ROOT = resolve(flag("root") ?? ".");
const configPath = resolve(ROOT, flag("config") ?? ".agents/okf.json");
let config = {};
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error(`validate-okf: cannot read ${configPath}: ${e.message}`);
    process.exit(1);
  }
}
const setting = (flagName, key, dflt, conv = (v) => v) => conv(flag(flagName) ?? config[key] ?? dflt);
const BUNDLE = resolve(ROOT, setting("bundle", "bundle", "docs/okf"));
const OKF_VERSION = setting("okf-version", "okfVersion", "0.2", String);
const MAX_DOC_CHARS = setting("max-doc-chars", "maxDocChars", 4000, Number); // about 1000 tokens
const MAX_AGENTS_LINES = setting("max-agents-lines", "maxAgentsLines", 80, Number);
const AGENTS_FILE = setting("agents-file", "agentsFile", "AGENTS.md");
const POINTER_FILES = setting(
  "pointer-files",
  "pointerFiles",
  ["CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md", ".cursor/rules/agents.mdc"],
  (v) => (Array.isArray(v) ? v : String(v).split(",").filter(Boolean)),
);
const MAX_POINTER_LINES = setting("max-pointer-lines", "maxPointerLines", 6, Number);

const errors = [];
const fail = (file, msg) => errors.push(`${relative(ROOT, file)}: ${msg}`);
const warnings = [];
const warn = (file, msg) => warnings.push(`warn: ${relative(ROOT, file)}: ${msg}`);

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

// Top-level keys of a YAML frontmatter block; values are only needed as strings here.
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// Every timestamp key (generated.at, verified.at, stale_after, sources[].last_modified) is an ISO 8601 datetime
// with an explicit UTC offset; usage_window's from and to are checked in checkTrust.
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
function checkTimestamps(file, block) {
  for (const m of block.matchAll(/(?:^|[\s{,])(at|stale_after|last_modified):\s*["']?([^,}"'\s]+)/gm)) {
    if (!DATETIME.test(m[2])) fail(file, `${m[1]} '${m[2]}' is not an ISO 8601 datetime with a UTC offset`);
  }
}

// A plain (unquoted) YAML value may not hold ': ' or ' #': YAML reads them as a nested key or a comment. Quote such values.
function checkPlainScalars(file, block) {
  for (const line of block.split("\n")) {
    const kv = line.match(/^\s*(?:-\s+)?[A-Za-z_][\w-]*:\s+(.+)$/);
    if (kv && !/^["'[{|>&*!]/.test(kv[1]) && /: | #/.test(kv[1])) fail(file, `quote the value of '${line.trim()}' (': ' or ' #' in a plain YAML value)`);
  }
}

// The OKF v0.2 trust and provenance families as values: a flow mapping `{ k: v }`, a block mapping, or a list of
// either (`- { k: v }`, or `- k: v` with indented continuation lines). Enough YAML for these fields, nothing more.
const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2");
function flowMap(s) {
  const parts = [];
  let cur = "", q = null, depth = 0;
  for (const c of s.trim().slice(1, -1)) {
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += c;
  }
  parts.push(cur);
  const out = {};
  for (const p of parts) {
    const kv = p.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/s);
    if (kv) out[kv[1]] = yamlValue(kv[2]);
  }
  return out;
}
const yamlValue = (s) => (/^\s*\{.*\}\s*$/s.test(s) ? flowMap(s) : unquote(s));
function trustFields(block) {
  const lines = block.split("\n"), out = {};
  for (let i = 0; i < lines.length; i++) {
    const top = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!top) continue;
    if (top[2].trim()) { out[top[1]] = yamlValue(top[2]); continue; }
    const body = [];
    while (i + 1 < lines.length && /^(\s+\S|-\s)/.test(lines[i + 1])) body.push(lines[++i]);
    if (!body.length) { out[top[1]] = ""; continue; }
    if (!/^\s*-\s/.test(body[0])) {
      const map = {};
      for (const l of body) { const kv = l.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/); if (kv) map[kv[1]] = yamlValue(kv[2]); }
      out[top[1]] = map;
      continue;
    }
    const list = [];
    for (const l of body) {
      const item = l.match(/^\s*-\s+(.*)$/);
      const kv = (item ? item[1] : l).match(/^\s*([A-Za-z_][\w-]*):\s*(.*)$/);
      if (item && /^\{/.test(item[1].trim())) list.push(yamlValue(item[1]));
      else if (item) list.push(kv ? { [kv[1]]: yamlValue(kv[2]) } : unquote(item[1]));
      else if (kv && list.length && typeof list[list.length - 1] === "object") list[list.length - 1][kv[1]] = yamlValue(kv[2]);
    }
    out[top[1]] = list;
  }
  return out;
}

// OKF v0.2 trust and provenance (SPEC §5): `generated` needs `by`; every `verified` entry (a list, or a bare
// mapping read as a one-element list) needs `by` and `at`; every `sources` entry needs a `resource`; usage_window
// bounds are datetimes. Warnings only: an actor off the §7 convention (generated.by and verified.by; never a
// source's `author`, which may be e.g. `team:x`), and a human-verified doc that still says `status: draft`
// (§5.4: not yet reviewed).
const ACTOR = /^(human:\S+|process:\S+|[^\s:/]+\/\S+)$/;
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function checkTrust(file, block, status) {
  const f = trustFields(block);
  if ("generated" in f) {
    if (!isMap(f.generated) || !f.generated.by) fail(file, "generated needs `by` (an actor)");
    else if (!ACTOR.test(f.generated.by)) warn(file, `generated.by '${f.generated.by}' does not follow the actor convention (<producer>/<version>, human:<id> or process:<id>)`);
  }
  if ("verified" in f) {
    const list = Array.isArray(f.verified) ? f.verified : [f.verified];
    if (!list.length) fail(file, "verified is empty");
    for (const v of list) {
      if (!isMap(v) || !v.by || !v.at) fail(file, "each verified entry needs `by` and `at`");
      else if (!ACTOR.test(v.by)) warn(file, `verified.by '${v.by}' does not follow the actor convention (<producer>/<version>, human:<id> or process:<id>)`);
    }
    if (status === "draft" && list.some((v) => isMap(v) && /^human:/.test(v.by ?? ""))) warn(file, "status draft means not yet reviewed, but a human verified it; set status stable");
  }
  const windows = [f.usage_window];
  if ("sources" in f) {
    if (!Array.isArray(f.sources)) fail(file, "sources must be a list");
    else f.sources.forEach((s, i) => {
      if (!isMap(s) || !s.resource) fail(file, `sources entry ${(isMap(s) && s.id) || i + 1} needs a resource`);
      if (isMap(s)) windows.push(s.usage_window);
    });
  }
  for (const w of windows.filter((w) => w !== undefined)) {
    if (!isMap(w)) { fail(file, "usage_window needs { from, to }"); continue; }
    for (const k of ["from", "to"]) if (!DATETIME.test(w[k] ?? "")) fail(file, `usage_window.${k} '${w[k] ?? ""}' is not an ISO 8601 datetime with a UTC offset`);
  }
}

// Footnotes join on sources[].id: each one cited has a definition and a source, and each source is cited.
function checkFootnotes(file, block, body) {
  const sources = trustFields(block).sources;
  const ids = new Set((Array.isArray(sources) ? sources : []).filter((s) => isMap(s) && s.id).map((s) => s.id));
  const prose = body.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const defs = new Set([...prose.matchAll(/^\[\^([^\]]+)\]:/gm)].map((m) => m[1]));
  const refs = new Set([...prose.replace(/^\[\^[^\]]+\]:/gm, "").matchAll(/\[\^([^\]]+)\]/g)].map((m) => m[1]));
  for (const r of refs) {
    if (!defs.has(r)) fail(file, `footnote [^${r}] has no definition`);
    if (!ids.has(r)) fail(file, `footnote [^${r}] matches no sources id`);
  }
  for (const id of ids) if (!refs.has(id)) fail(file, `source '${id}' is never cited`);
}

// Links in prose (not in code) must resolve; bundle-relative links start at docs/okf.
function checkLinks(file, text) {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const m of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    const path = target.startsWith("/") ? join(BUNDLE, target) : resolve(dirname(file), target);
    if (!existsSync(path)) fail(file, `broken link ${m[1]}`);
  }
}

if (!existsSync(BUNDLE)) {
  console.error(`validate-okf: bundle ${relative(ROOT, BUNDLE) || "."} is missing`);
  process.exit(1);
}
const files = walk(BUNDLE).filter((f) => f.endsWith(".md"));
if (!existsSync(join(BUNDLE, "index.md"))) fail(BUNDLE, "missing root index.md");
if (!existsSync(join(BUNDLE, "log.md"))) fail(BUNDLE, "missing root log.md");

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const name = file.split("/").pop();
  checkLinks(file, text);

  if (name === "index.md") {
    const fm = frontmatter(text);
    if (fm && dirname(file) !== BUNDLE) fail(file, "an index.md below the root takes no frontmatter");
    if (fm && dirname(file) === BUNDLE) {
      const extra = Object.keys(fm).filter((k) => k !== "okf_version");
      if (extra.length) fail(file, `root index frontmatter allows only okf_version, found ${extra.join(", ")}`);
      if (fm.okf_version !== OKF_VERSION) fail(file, `okf_version should be "${OKF_VERSION}"`);
    }
    continue;
  }
  if (name === "log.md") {
    const dates = [...text.matchAll(/^## (.*)$/gm)].map((m) => m[1].trim());
    for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) fail(file, `log heading '${d}' must be a YYYY-MM-DD date alone`);
    if (dates.some((d, i) => i > 0 && d >= dates[i - 1])) fail(file, "log dates must be newest first, one heading per date");
    continue;
  }

  const fm = frontmatter(text);
  if (!fm) {
    fail(file, "missing frontmatter");
    continue;
  }
  const block = text.match(/^---\n([\s\S]*?)\n---\n/)[1];
  checkTimestamps(file, block);
  checkPlainScalars(file, block);
  checkFootnotes(file, block, text.slice(block.length + 8));
  checkTrust(file, block, fm.status);
  for (const key of ["type", "title", "description"]) {
    if (!fm[key]?.trim()) fail(file, `frontmatter needs a non-empty '${key}'`);
  }
  if (fm.status && !["draft", "stable", "deprecated"].includes(fm.status)) fail(file, `status '${fm.status}' is not draft, stable or deprecated`);
  if (!/^\*\*TL;DR:\*\*/m.test(text)) fail(file, "missing a '**TL;DR:**' line");
  if (text.length > MAX_DOC_CHARS) fail(file, `${text.length} chars exceeds ${MAX_DOC_CHARS}; split it`);

  const index = join(dirname(file), "index.md");
  if (!existsSync(index)) fail(file, "its folder has no index.md");
  else {
    const line = readFileSync(index, "utf8").split("\n").find((l) => l.includes(`(${name})`));
    const desc = (fm.description ?? "").trim().replace(/\.$/, "").toLowerCase();
    if (!line) fail(file, `not listed in ${relative(ROOT, index)}`);
    else if (desc && !line.toLowerCase().includes(desc)) warn(file, `its line in ${relative(ROOT, index)} does not carry its description verbatim`);
  }
}

// Every folder index is reachable from its parent's index.
for (const file of files.filter((f) => f.endsWith("/index.md") && dirname(f) !== BUNDLE)) {
  const parent = join(dirname(dirname(file)), "index.md");
  const folder = dirname(file).split("/").pop();
  if (!existsSync(parent) || !readFileSync(parent, "utf8").includes(`(${folder}/index.md)`)) {
    fail(file, `not linked from ${relative(ROOT, parent)}`);
  }
}

// AGENTS.md is the one instruction file; every vendor file is a short pointer to it.
const agents = join(ROOT, AGENTS_FILE);
if (!existsSync(agents)) fail(agents, "missing");
else {
  const text = readFileSync(agents, "utf8");
  if (text.split("\n").length > MAX_AGENTS_LINES) fail(agents, `over ${MAX_AGENTS_LINES} lines`);
  checkLinks(agents, text);
}
for (const rel of POINTER_FILES) {
  const f = join(ROOT, rel);
  if (!existsSync(f)) {
    fail(f, "missing pointer file");
    continue;
  }
  const text = readFileSync(f, "utf8");
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
  if (body.split("\n").filter((l) => l.trim()).length > MAX_POINTER_LINES || !text.includes(AGENTS_FILE)) {
    fail(f, `must be a short pointer to ${AGENTS_FILE}`);
  }
}

for (const w of warnings) console.error(w);
if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\nvalidate-okf FAILED (${errors.length} problem${errors.length > 1 ? "s" : ""})`);
  process.exit(1);
}
console.log(`validate-okf OK (${files.length} docs)`);
