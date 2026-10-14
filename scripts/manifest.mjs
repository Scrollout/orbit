// Content hash and version per skill and command, so an edit without a version bump is caught. Zero dependencies.
//   node <plugin>/scripts/manifest.mjs [--root .] --check | --update | --print
// An entry is a core file (commands/*.md, skills/*/SKILL.md) plus its refs (refs/<command>/ or skills/<skill>/refs/).
// The version is the `version:` line of the core's frontmatter; the hash covers the core and its refs.
// --check: exit 1 if an entry is missing, has no version, was edited without a version bump, or the manifest is stale.
// --update: rewrite skills/MANIFEST.json; refuses an entry whose content changed but whose version did not.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const root = resolve(flag("root") ?? ".");
const manifestPath = join(root, "skills", "MANIFEST.json");

const ls = (d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)).sort() : []);
export function entries() {
  const out = [];
  for (const f of ls("commands").filter((f) => f.endsWith(".md"))) out.push({ core: `commands/${f}`, refs: `refs/${f.slice(0, -3)}` });
  for (const s of ls("skills")) if (existsSync(join(root, "skills", s, "SKILL.md"))) out.push({ core: `skills/${s}/SKILL.md`, refs: `skills/${s}/refs` });
  return out.map((e) => {
    const files = [e.core, ...ls(e.refs).filter((f) => f.endsWith(".md")).map((f) => `${e.refs}/${f}`)];
    const h = createHash("sha256");
    for (const f of files) h.update(`${f}\n${readFileSync(join(root, f), "utf8").replace(/\r\n/g, "\n")}\n`);
    const v = readFileSync(join(root, e.core), "utf8").match(/^---\n[\s\S]*?^version:[ \t]*(\S+)[ \t]*$[\s\S]*?^---/m);
    return { core: e.core, files, version: v?.[1], hash: h.digest("hex") };
  });
}

const old = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).entries ?? {} : {};
const now = entries();
if (args.includes("--print")) {
  for (const e of now) console.log(`${e.hash}  ${e.version ?? "-"}  ${e.core}`);
} else if (args.includes("--update")) {
  const bad = now.filter((e) => !e.version || (old[e.core] && old[e.core].hash !== e.hash && old[e.core].version === e.version));
  for (const e of bad) console.log(`${e.core}: ${e.version ? "edited without a version bump" : "no version"}`);
  if (bad.length) process.exit(1);
  const entriesOut = {};
  for (const e of now) entriesOut[e.core] = { version: e.version, hash: e.hash, files: e.files };
  writeFileSync(manifestPath, JSON.stringify({ entries: entriesOut }, null, 2) + "\n");
} else if (args.includes("--check")) {
  let bad = 0;
  const say = (c, m) => { console.log(`${c}: ${m}`); bad++; };
  for (const e of now) {
    const o = old[e.core];
    if (!e.version) say(e.core, "no version");
    else if (!o) say(e.core, "not in manifest (run --update)");
    else if (o.hash !== e.hash) say(e.core, o.version === e.version ? "edited without a version bump" : "manifest stale (run --update)");
    else if (o.version !== e.version) say(e.core, "version changed without content change; run --update");
  }
  for (const k of Object.keys(old)) if (!now.some((e) => e.core === k)) say(k, "in manifest but missing");
  process.exit(bad ? 1 : 0);
} else {
  console.error("usage: manifest.mjs [--root .] --check | --update | --print");
  process.exit(64);
}
