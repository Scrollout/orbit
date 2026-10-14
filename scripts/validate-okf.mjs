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
import { checkDoc, frontmatter } from "./okf-lib.mjs";

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

  const doc = checkDoc(text, { maxChars: MAX_DOC_CHARS });
  for (const m of doc.errors) fail(file, m);
  for (const m of doc.warnings) warn(file, m);
  if (!doc.fm) continue;

  const index = join(dirname(file), "index.md");
  if (!existsSync(index)) fail(file, "its folder has no index.md");
  else {
    const line = readFileSync(index, "utf8").split("\n").find((l) => l.includes(`(${name})`));
    const desc = doc.description.replace(/\.$/, "").toLowerCase();
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

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\nvalidate-okf FAILED (${errors.length} problem${errors.length > 1 ? "s" : ""})`);
  if (warnings.length) console.error(`\nWarnings (not failures):\n${warnings.join("\n")}`);
  process.exit(1);
}
for (const w of warnings) console.error(w);
console.log(`validate-okf OK (${files.length} docs)`);
