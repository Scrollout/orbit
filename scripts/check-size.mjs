// Size guard for the instruction files orbit ships. Zero dependencies.
//   node <plugin>/scripts/check-size.mjs [--root .] [--max-chars 10000] [--max-lines 100]
// Checks agents/*.md, commands/*.md, skills/*/SKILL.md and every file under a refs/ folder.
// Threshold (about 2500 tokens at 4 characters per token, or 100 lines): a file over either moves its detail
// (tables, templates, per-step procedures) to refs/ files and keeps the rules and flow in the core.
// Prints the files largest first with approximate tokens; exit 1 if any is over.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const root = resolve(flag("root", "."));
const maxChars = Number(flag("max-chars", 10000)), maxLines = Number(flag("max-lines", 100));

const md = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".md")).map((d) => join(dir, d.name)) : []);
// Walks real directories only: skips .git and node_modules and never follows a symlink.
const walk = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  if (d.isSymbolicLink() || d.name === ".git" || d.name === "node_modules") return [];
  const p = join(dir, d.name);
  return d.isDirectory() ? walk(p) : [p];
}) : [];
const files = new Set([...md(join(root, "agents")), ...md(join(root, "commands"))]);
for (const s of existsSync(join(root, "skills")) ? readdirSync(join(root, "skills")) : []) {
  const f = join(root, "skills", s, "SKILL.md");
  if (existsSync(f) && !lstatSync(f).isSymbolicLink()) files.add(f);
}
for (const base of [root, join(root, "skills")]) for (const f of walk(base)) if (/(^|\/)refs\//.test(relative(root, f)) && f.endsWith(".md")) files.add(f);

const rows = [...files].map((f) => {
  const t = readFileSync(f, "utf8");
  return { name: relative(root, f), chars: t.length, lines: t.split("\n").length - (t.endsWith("\n") ? 1 : 0) };
}).sort((a, b) => b.chars - a.chars);
console.log(`largest first (limit ${maxChars} chars or ${maxLines} lines):`);
for (const r of rows) console.log(`${String(r.chars).padStart(7)} chars ${String(Math.round(r.chars / 4)).padStart(5)} tokens ${String(r.lines).padStart(4)} lines  ${r.name}`);
const over = rows.filter((r) => r.chars > maxChars || r.lines > maxLines);
for (const r of over) console.log(`over: ${r.name}`);
process.exit(over.length ? 1 : 0);
