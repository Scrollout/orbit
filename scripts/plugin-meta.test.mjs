// Orbit #17, #18, #23: what claude.ai accepts from the plugin (#23 adds the marketplace, plugin.json, skill name, frontmatter key and model, hooks.json and portal file checks). plugin.json holds only documented manifest keys (an unknown one, such
// as `icon`, is stripped with a warning); every command, agent and skill description is at most 500 characters (claude.ai cuts
// it); every frontmatter parses as YAML (the portal blocks the plugin otherwise); at most 512 tracked files (the portal holds a
// bigger plugin for a person to review).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The plugin manifest keys Claude Code documents (plugins reference: metadata and component paths).
const MANIFEST_KEYS = new Set(["name", "version", "description", "author", "homepage", "repository", "license", "keywords",
  "commands", "agents", "skills", "hooks", "mcpServers", "outputStyles", "lspServers"]);
const MAX_DESCRIPTION = 500;
const MAX_FILES = 512;

export const unknownKeys = (manifest) => Object.keys(manifest).filter((k) => !MANIFEST_KEYS.has(k));
// The frontmatter description of a markdown file, unquoted; null without one.
export function description(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const line = fm?.split(/\r?\n/).find((l) => l.startsWith("description:"));
  if (line === undefined) return null;
  const v = line.slice("description:".length).trim();
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v;
}
// YAML problems of a frontmatter that holds only one-line `key: value` pairs (all Orbit uses): a value is a plain scalar
// (no leading indicator, no ": " or " #" inside, no trailing ":"), a double-quoted string (JSON-compatible escapes) or a
// single-quoted one (' doubled). Returns the first problem, or null.
export function yamlProblem(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (fm === undefined) return "no frontmatter";
  for (const line of fm.split(/\r?\n/)) {
    const i = line.indexOf(":"), key = line.slice(0, i);
    if (i < 1 || !/^[A-Za-z][\w-]*$/.test(key) || (line.length > i + 1 && line[i + 1] !== " ")) return `not a key: value line: ${line.slice(0, 40)}`;
    const m = [line, key, line.slice(i + 1)];
    const v = m[2].trim();
    if (v.startsWith('"')) {
      if (!v.endsWith('"') || v.length < 2) return `${m[1]}: unclosed double quote`;
      try { JSON.parse(v); } catch { return `${m[1]}: bad double-quoted string`; }
    } else if (v.startsWith("'")) {
      if (!v.endsWith("'") || v.length < 2 || /'(?!')/.test(v.slice(1, -1).replaceAll("''", ""))) return `${m[1]}: bad single-quoted string`;
    } else if (/^[[\]{}#&*!|>%@`,]/.test(v) || /^[-?:](\s|$)/.test(v) || v.includes(": ") || v.includes(" #") || v.endsWith(":")) {
      return `${m[1]}: plain value YAML reads differently (quote it)`;
    }
  }
  return null;
}
// #23: the rest of what the plugin docs and claude.ai require. Each returns a list of problems, empty when it complies.
// The frontmatter fields of a markdown file as key -> unquoted value (one-line `key: value` pairs, as yamlProblem allows).
export function fields(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const out = new Map();
  for (const line of fm?.split(/\r?\n/) ?? []) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const v = line.slice(i + 1).trim();
    let u = v;
    if (v.startsWith('"')) { try { u = JSON.parse(v); } catch { u = v; } } else if (v.startsWith("'") && v.endsWith("'") && v.length > 1) u = v.slice(1, -1).replaceAll("''", "'");
    out.set(line.slice(0, i), u);
  }
  return out;
}
const isObj = (o) => o !== null && typeof o === "object" && !Array.isArray(o);
export function marketplaceProblems(m, plugin) {
  if (!isObj(m)) return ["marketplace.json is not a JSON object"];
  const p = [];
  if (typeof m.name !== "string" || !m.name) p.push("marketplace: no name");
  if (!isObj(m.owner)) p.push("marketplace: no owner");
  if (!Array.isArray(m.plugins) || !m.plugins.length) return [...p, "marketplace: no plugins"];
  const e = m.plugins.find((x) => isObj(x) && x.name === plugin?.name);
  if (!e) p.push(`marketplace: no entry named ${plugin?.name}`);
  else if (e.source !== "./") p.push(`marketplace: entry source ${JSON.stringify(e.source)}, not "./"`);
  return p;
}
// MAJOR.MINOR.PATCH, an optional -pre-release and +build (split, not one regex: no nested quantifiers).
const isSemver = (v) => {
  if (typeof v !== "string") return false;
  const [core, build, ...more] = v.split("+"), i = core.indexOf("-");
  const ids = /^[0-9A-Za-z.-]+$/;
  return !more.length && /^\d+\.\d+\.\d+$/.test(i < 0 ? core : core.slice(0, i)) && (i < 0 || ids.test(core.slice(i + 1))) && (build === undefined || ids.test(build));
};
export function pluginProblems(pl, changelog, market) {
  if (!isObj(pl)) return ["plugin.json is not a JSON object"];
  const p = [];
  const n = pl.name;
  if (typeof n !== "string" || !/^[a-z0-9-]+$/.test(n) || n.startsWith("-") || n.endsWith("-") || n.includes("--")) p.push(`plugin name ${JSON.stringify(n)} is not kebab-case`);
  if (!isSemver(pl.version)) p.push(`plugin version ${JSON.stringify(pl.version)} is not SemVer`);
  const top = /^## (\S+)/m.exec(changelog ?? "")?.[1];
  if (top !== pl.version) p.push(`plugin version ${pl.version} is not the CHANGELOG top entry ${top}`);
  const e = Array.isArray(market?.plugins) ? market.plugins.find((x) => isObj(x) && x.name === n) : undefined;
  if (e?.version !== undefined && e.version !== pl.version) p.push(`marketplace entry version ${e.version} is not ${pl.version}`);
  if (!isObj(pl.author) || typeof pl.author.name !== "string" || !pl.author.name) p.push("plugin: no author.name");
  if (typeof pl.license !== "string" || !pl.license) p.push("plugin: no license");
  return p;
}
export const skillNameProblems = (entries) => entries.filter(([dir, text]) => fields(text).get("name") !== dir).map(([dir]) => `skills/${dir}: frontmatter name is not ${dir}`);
// The documented frontmatter keys per kind (version is allowed everywhere; Claude Code ignores it). Skill keys as Claude
// Code 2.1.302 reads them; commands and agents as Orbit #23 lists them.
const FM_KEYS = {
  commands: ["description", "argument-hint", "disable-model-invocation", "model", "allowed-tools"],
  skills: ["name", "description", "when_to_use", "argument-hint", "disable-model-invocation", "user-invocable", "allowed-tools", "model", "effort", "context", "agent", "hooks", "paths", "shell"],
  agents: ["name", "description", "model", "tools"],
};
const MODELS = new Set(["sonnet", "opus", "haiku", "fable", "inherit"]);
export function frontmatterProblems(kind, text) {
  const keys = new Set([...FM_KEYS[kind], "version"]);
  const f = fields(text), p = [];
  for (const k of f.keys()) if (!keys.has(k)) p.push(`undocumented ${kind} frontmatter key ${k}`);
  const m = f.get("model");
  if (m !== undefined && !MODELS.has(m) && !/^claude-[a-z0-9-]+$/.test(m)) p.push(`model ${m} is not a documented value`);
  return p;
}
// Hook events as Claude Code 2.1.302 documents them (its hook event list).
const HOOK_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "Notification", "UserPromptSubmit",
  "UserPromptExpansion", "SessionStart", "SessionEnd", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
  "PreModelSwitch", "PostModelSwitch", "PermissionRequest", "PermissionDenied", "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted",
  "Elicitation", "ElicitationResult", "ConfigChange", "WorktreeCreate", "WorktreeRemove", "InstructionsLoaded", "CwdChanged", "FileChanged",
  "DirectoryAdded", "MessageDisplay"]);
const ROOT_VAR = "${CLAUDE_PLUGIN_ROOT}";
export function hooksProblems(h, exists) {
  if (!isObj(h) || !isObj(h.hooks)) return ["hooks.json is not a JSON object with hooks"];
  const p = [];
  for (const [ev, groups] of Object.entries(h.hooks)) {
    if (!HOOK_EVENTS.has(ev)) p.push(`undocumented hook event ${ev}`);
    for (const g of Array.isArray(groups) ? groups : [null]) {
      for (const x of isObj(g) && Array.isArray(g.hooks) ? g.hooks : [null]) {
        if (!isObj(x)) { p.push(`${ev}: a hook group or handler is malformed`); continue; }
        if (x.type !== "command") p.push(`${ev}: handler type ${x.type}, not command`);
        if ("timeout" in x && !(Number.isInteger(x.timeout) && x.timeout > 0)) p.push(`${ev}: timeout ${JSON.stringify(x.timeout)} is not a positive integer`);
        const c = typeof x.command === "string" ? x.command : "";
        if (c.replaceAll(ROOT_VAR, "").includes("CLAUDE_PLUGIN_ROOT")) p.push(`${ev}: CLAUDE_PLUGIN_ROOT not written as "${ROOT_VAR}"`);
        for (let i = c.indexOf(ROOT_VAR); i >= 0; i = c.indexOf(ROOT_VAR, i + 1)) {
          let quotes = 0;
          for (let k = 0; k < i; k++) if (c[k] === '"' && c[k - 1] !== "\\") quotes++;
          if (quotes % 2 === 0) p.push(`${ev}: ${ROOT_VAR} is not double-quoted in ${c}`);
          let j = i + ROOT_VAR.length + 1;
          while (j < c.length && c[j] !== '"' && c[j] !== " ") j++;
          const rel = c.slice(i + ROOT_VAR.length + 1, j);
          if (c[i + ROOT_VAR.length] === "/" && rel && !exists(rel)) p.push(`${ev}: ${rel} does not exist`);
        }
      }
    }
  }
  return p;
}
// The portal's file rules: tracked files ({ path, mode from git ls-files -s, size }) at most 256 KiB, no symlinks, no
// Windows-reserved names, colons, trailing dots or spaces in any segment, no paths equal but for case; README.md and LICENSE.
const MAX_FILE = 256 * 1024;
const RESERVED = new Set(["con", "prn", "aux", "nul", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((d) => [`com${d}`, `lpt${d}`])]);
export function portalProblems(files) {
  const p = [], seen = new Map();
  for (const { path, mode, size } of files) {
    if (size > MAX_FILE) p.push(`${path}: ${size} bytes, over 256 KiB`);
    if (mode === "120000") p.push(`${path}: a symlink`);
    const segs = path.split("/");
    for (const s of segs) {
      if (RESERVED.has(s.split(".")[0].toLowerCase())) p.push(`${path}: Windows-reserved name ${s}`);
      if (s.includes(":")) p.push(`${path}: a colon`);
      if (s.endsWith(".") || s.endsWith(" ")) p.push(`${path}: a trailing dot or space`);
    }
    for (let i = 1; i <= segs.length; i++) {
      const pre = segs.slice(0, i).join("/"), low = pre.toLowerCase();
      if (seen.has(low) && seen.get(low) !== pre) p.push(`${pre}: differs from ${seen.get(low)} only by case`);
      else seen.set(low, pre);
    }
  }
  for (const f of ["README.md", "LICENSE"]) if (!files.some((x) => x.path === f)) p.push(`${f} is missing`);
  return p;
}
const md = (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`) : []);
const skills = readdirSync(join(root, "skills")).map((s) => `skills/${s}/SKILL.md`).filter((f) => existsSync(join(root, f)));

test("the checks catch what claude.ai rejects", () => {
  assert.deepEqual(unknownKeys({ name: "x", version: "1", icon: "./a.svg" }), ["icon"]);
  assert.equal(description("---\nname: x\ndescription: \"" + "a".repeat(501) + "\"\n---\n").length, 501);
  assert.equal(description("no frontmatter"), null);
  assert.match(yamlProblem("---\ndescription: the line `Mode: fix-round` here\n---\n"), /quote it/);
  assert.match(yamlProblem("---\nargument-hint: [path] [name]\n---\n"), /quote it/);
  assert.equal(yamlProblem("---\ndescription: \"a: b\"\nargument-hint: \"[x]\"\nversion: 1.0.0\n---\n"), null);
  // #23: each check fails on a planted-bad case.
  const plugin = { name: "orbit", version: "1.2.3", author: { name: "A" }, license: "MIT" };
  const market = { name: "m", owner: { name: "A" }, plugins: [{ name: "orbit", source: "./" }] };
  assert.deepEqual(marketplaceProblems(market, plugin), []);
  assert.ok(marketplaceProblems(null, plugin).length, "marketplace not JSON");
  for (const k of ["name", "owner", "plugins"]) assert.ok(marketplaceProblems({ ...market, [k]: undefined }, plugin).length, `marketplace without ${k}`);
  assert.ok(marketplaceProblems({ ...market, plugins: [{ name: "other", source: "./" }] }, plugin).length, "entry name differs");
  assert.ok(marketplaceProblems({ ...market, plugins: [{ name: "orbit", source: "./x" }] }, plugin).length, "source not ./");
  const log = "# Changelog\n\n## 1.2.3\n- x\n\n## 1.2.2\n";
  assert.deepEqual(pluginProblems(plugin, log, market), []);
  assert.ok(pluginProblems({ ...plugin, name: "Orbit_x" }, log, market).length, "name not kebab-case");
  assert.ok(pluginProblems({ ...plugin, version: "1.2" }, "## 1.2\n", market).length, "version not SemVer");
  assert.ok(pluginProblems({ ...plugin, version: "1.2.4" }, log, market).length, "version differs from the CHANGELOG");
  assert.ok(pluginProblems(plugin, log, { ...market, plugins: [{ name: "orbit", source: "./", version: "1.2.2" }] }).length, "marketplace version differs");
  assert.ok(pluginProblems({ ...plugin, author: {} }, log, market).length, "no author.name");
  assert.ok(pluginProblems({ ...plugin, license: undefined }, log, market).length, "no license");
  assert.deepEqual(skillNameProblems([["okf", "---\nname: okf\ndescription: x\n---\n"]]), []);
  assert.ok(skillNameProblems([["okf", "---\nname: okf-x\ndescription: x\n---\n"]]).length, "skill name differs from its dir");
  assert.ok(skillNameProblems([["okf", "---\ndescription: x\n---\n"]]).length, "skill without name");
  assert.deepEqual(frontmatterProblems("agents", "---\nname: a\ndescription: x\nmodel: inherit\ntools: Read\nversion: 1.0.0\n---\n"), []);
  assert.ok(frontmatterProblems("commands", "---\ndescription: x\nname: c\n---\n").length, "command with an undocumented key");
  assert.ok(frontmatterProblems("agents", "---\nname: a\ndescription: x\nicon: y\n---\n").length, "agent with an undocumented key");
  assert.ok(frontmatterProblems("skills", "---\nname: a\ndescription: x\ntools: Read\n---\n").length, "skill with an undocumented key");
  assert.ok(frontmatterProblems("agents", "---\nname: a\ndescription: x\nmodel: gpt-4\n---\n").length, "an undocumented model");
  const hooks = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "sh \"${CLAUDE_PLUGIN_ROOT}/hooks/g.sh\"", timeout: 10 }] }] } };
  const has = (f) => f === "hooks/g.sh";
  assert.deepEqual(hooksProblems(hooks, has), []);
  const hk = (o, ev = "PreToolUse") => ({ hooks: { [ev]: [{ matcher: "Bash", hooks: [{ ...hooks.hooks.PreToolUse[0].hooks[0], ...o }] }] } });
  assert.ok(hooksProblems(null, has).length, "hooks.json not JSON");
  assert.ok(hooksProblems(hk({}, "PreToolUsee"), has).length, "an undocumented event");
  assert.ok(hooksProblems(hk({ type: "prompt" }), has).length, "a handler type other than command");
  for (const t of [0, -1, 1.5, "10"]) assert.ok(hooksProblems(hk({ timeout: t }), has).length, `timeout ${t}`);
  assert.ok(hooksProblems(hk({ command: "sh ${CLAUDE_PLUGIN_ROOT}/hooks/g.sh" }), has).length, "an unquoted plugin root");
  assert.ok(hooksProblems(hk({ command: "sh \"${CLAUDE_PLUGIN_ROOT}/hooks/gone.sh\"" }), has).length, "a missing script");
  const ok = [{ path: "README.md", mode: "100644", size: 1 }, { path: "LICENSE", mode: "100644", size: 1 }, { path: "a/b.md", mode: "100644", size: 262144 }];
  assert.deepEqual(portalProblems(ok), []);
  const bad = (f) => portalProblems([...ok, { mode: "100644", size: 1, ...f }]).length;
  assert.ok(bad({ path: "big.bin", size: 262145 }), "a file over 256 KiB");
  assert.ok(bad({ path: "l", mode: "120000" }), "a symlink");
  for (const p of ["con", "a/NUL.txt", "Com1.md", "lpt9"]) assert.ok(bad({ path: p }), `reserved name ${p}`);
  for (const p of ["a:b.md", "a./b", "b. ", "c "]) assert.ok(bad({ path: p }), `bad name ${JSON.stringify(p)}`);
  for (const p of ["readme.md", "A/b.md"]) assert.ok(bad({ path: p }), `case-only collision ${p}`);
  assert.ok(portalProblems(ok.slice(1)).length, "no README.md");
  assert.ok(portalProblems([ok[0], ok[2]]).length, "no LICENSE");
});

test("plugin.json has only documented manifest keys", () => {
  assert.deepEqual(unknownKeys(JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"))), []);
});

test("every command, agent and skill description is at most 500 characters", () => {
  const files = [...md("commands"), ...md("agents"), ...skills];
  assert.ok(files.length > 5, files.join(" "));
  const over = files.map((f) => [f, description(readFileSync(join(root, f), "utf8"))]).filter(([, d]) => d === null || d.length > MAX_DESCRIPTION);
  assert.deepEqual(over.map(([f, d]) => `${f}: ${d === null ? "no description" : d.length}`), []);
});

test("every agent, command and skill frontmatter parses as YAML", () => {
  const files = [...md("commands"), ...md("agents"), ...skills];
  assert.deepEqual(files.map((f) => [f, yamlProblem(readFileSync(join(root, f), "utf8"))]).filter(([, p]) => p).map(([f, p]) => `${f}: ${p}`), []);
});

test("the plugin has at most 512 tracked files", () => {
  const r = spawnSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const n = r.stdout.split("\n").filter(Boolean).length;
  assert.ok(n <= MAX_FILES, `${n} tracked files`);
});

const json = (f) => { try { return JSON.parse(readFileSync(join(root, f), "utf8")); } catch { return null; } };
const read = (f) => readFileSync(join(root, f), "utf8");

test("marketplace.json is valid and names the plugin at ./", () => {
  assert.deepEqual(marketplaceProblems(json(".claude-plugin/marketplace.json"), json(".claude-plugin/plugin.json")), []);
});

test("plugin.json: kebab-case name, SemVer version equal to the CHANGELOG and marketplace, author.name and license", () => {
  assert.deepEqual(pluginProblems(json(".claude-plugin/plugin.json"), read("CHANGELOG.md"), json(".claude-plugin/marketplace.json")), []);
});

test("every skill's frontmatter name equals its directory", () => {
  assert.ok(skills.length >= 4, skills.join(" "));
  assert.deepEqual(skillNameProblems(skills.map((f) => [f.split("/")[1], read(f)])), []);
});

test("frontmatter keys are documented for their kind and model is a documented value", () => {
  const all = [...md("commands").map((f) => ["commands", f]), ...md("agents").map((f) => ["agents", f]), ...skills.map((f) => ["skills", f])];
  assert.deepEqual(all.flatMap(([k, f]) => frontmatterProblems(k, read(f)).map((p) => `${f}: ${p}`)), []);
});

test("hooks/hooks.json: documented events, command handlers, positive integer timeouts, quoted plugin root, scripts exist", () => {
  assert.deepEqual(hooksProblems(json("hooks/hooks.json"), (f) => existsSync(join(root, f))), []);
});

test("tracked files follow the portal's file rules; README.md and LICENSE are present", () => {
  const r = spawnSync("git", ["-C", root, "ls-files", "-s", "-z"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const files = r.stdout.split("\0").filter(Boolean).map((l) => {
    const [meta, path] = l.split("\t");
    return { path, mode: meta.split(" ")[0], size: lstatSync(join(root, path)).size };
  });
  assert.deepEqual(portalProblems(files), []);
});
