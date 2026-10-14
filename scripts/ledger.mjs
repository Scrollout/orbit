// Append one event to a session ledger (JSONL, one event per line). Zero dependencies.
//   node <plugin>/scripts/ledger.mjs [--ledger <file>] --session <id> [--root .] <kind> key=value ... key:=<json> ...
// The ledger defaults to the profile's `ledger_path` (default .agents/ledger.jsonl, resolved from --root; keep it
// untracked). Stamps `ts` (UTC) and `rule_version` (the manifest versions of /decide, the operator skill and the
// rules/scripts, read from this plugin's own skills/MANIFEST.json). `key=value` is a string; `key:=<json>` is typed
// (true, false, numbers, arrays). ts, session, kind and rule_version cannot be set by a field. Exit 64 on bad usage.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile } from "./profile.mjs";

const die = (m) => { console.error(`ledger: ${m}`); process.exit(64); };
const args = process.argv.slice(2);
const take = (n) => { const i = args.indexOf(`--${n}`); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
let ledger = take("ledger");
const session = take("session"), root = resolve(take("root") ?? ".");
const [kind, ...pairs] = args;
if (!session || !kind) die("usage: ledger.mjs [--ledger f] --session id [--root .] <kind> key=value key:=json");
if (!ledger) ledger = resolve(root, loadProfile(root).data?.ledger_path || ".agents/ledger.jsonl");

const rule_version = {};
const mf = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "MANIFEST.json");
if (existsSync(mf)) {
  const m = JSON.parse(readFileSync(mf, "utf8")).entries;
  for (const [k, name] of [["commands/decide.md", "decide"], ["skills/operator/SKILL.md", "operator"], ["rules/rules.json", "rules"]]) if (m[k]) rule_version[name] = m[k].version;
}
const event = { ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"), session, rule_version, kind };
const RESERVED = ["ts", "session", "kind", "rule_version", "__proto__"];
for (const p of pairs) {
  const typed = p.match(/^([\w-]+):=(.*)$/s), plain = p.match(/^([\w-]+)=(.*)$/s);
  const m = typed ?? plain;
  if (!m) die(`bad field: ${p}`);
  if (RESERVED.includes(m[1])) die(`field ${m[1]} is reserved`);
  if (typed) { try { event[m[1]] = JSON.parse(m[2]); } catch { die(`bad JSON for ${m[1]}`); } }
  else event[m[1]] = m[2];
}
mkdirSync(dirname(ledger), { recursive: true });
appendFileSync(ledger, JSON.stringify(event) + "\n");
