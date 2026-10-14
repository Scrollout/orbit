// Docs consistency for the plugin repo. Zero dependencies.
//   node <plugin>/scripts/check-docs.mjs [--root .]
// (okf files are skipped: their links are examples.) Checks: plugin.json version == the top CHANGELOG heading == README's `Version: x.y.z` line; relative Markdown links and
// src/srcset attributes in README, CHANGELOG, commands, skills and refs resolve; backticked repo paths in the README exist.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const i = args.indexOf("--root");
const root = resolve(i >= 0 ? args[i + 1] : ".");
const problems = [];
const read = (f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : "");

const plugin = JSON.parse(read(".claude-plugin/plugin.json") || "{}").version;
const changelog = read("CHANGELOG.md").match(/^## (\d+\.\d+\.\d+)/m)?.[1];
const readme = read("README.md").match(/^Version: (\d+\.\d+\.\d+)/m)?.[1];
if (plugin !== changelog) problems.push(`version: plugin.json ${plugin}, CHANGELOG ${changelog}`);
if (!readme) problems.push("README has no `Version:` line");
else if (readme !== plugin) problems.push(`version: plugin.json ${plugin}, README says ${readme}`);

const walk = (d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)).flatMap((f) => { const p = join(d, f); return statSync(join(root, p)).isDirectory() ? walk(p) : [p]; }) : []);
const docs = ["README.md", "CHANGELOG.md", ...["commands", "skills", "refs"].flatMap(walk).filter((f) => f.endsWith(".md") && !f.includes("okf"))].filter((f) => existsSync(join(root, f)));
for (const f of docs) {
  const text = read(f);
  const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]);
  for (const t of targets) {
    if (/^(https?:|mailto:|#)/.test(t) || /[<{$]/.test(t)) continue;
    if (!existsSync(resolve(root, dirname(f), t.split("#")[0]))) problems.push(`${f}: broken link: ${t}`);
  }
}
for (const m of read("README.md").matchAll(/`((?:scripts|rules|refs|skills|hooks|templates|commands|agents)\/[\w./-]+\.(?:mjs|json|md|sh))`/g)) {
  if (!existsSync(join(root, m[1]))) problems.push(`README.md: missing path: ${m[1]}`);
}
for (const p of problems) console.log(p);
process.exit(problems.length ? 1 : 0);
