// Orbit #17, #18: what claude.ai accepts from the plugin. plugin.json holds only documented manifest keys (an unknown one, such
// as `icon`, is stripped with a warning); every command, agent and skill description is at most 500 characters (claude.ai cuts
// it); every frontmatter parses as YAML (the portal blocks the plugin otherwise); at most 512 tracked files (the portal holds a
// bigger plugin for a person to review).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const md = (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`) : []);
const skills = readdirSync(join(root, "skills")).map((s) => `skills/${s}/SKILL.md`).filter((f) => existsSync(join(root, f)));

test("the checks catch what claude.ai rejects", () => {
  assert.deepEqual(unknownKeys({ name: "x", version: "1", icon: "./a.svg" }), ["icon"]);
  assert.equal(description("---\nname: x\ndescription: \"" + "a".repeat(501) + "\"\n---\n").length, 501);
  assert.equal(description("no frontmatter"), null);
  assert.match(yamlProblem("---\ndescription: the line `Mode: fix-round` here\n---\n"), /quote it/);
  assert.match(yamlProblem("---\nargument-hint: [path] [name]\n---\n"), /quote it/);
  assert.equal(yamlProblem("---\ndescription: \"a: b\"\nargument-hint: \"[x]\"\nversion: 1.0.0\n---\n"), null);
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
