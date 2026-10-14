// Append one event to a session ledger (JSONL, one event per line). Zero dependencies.
//   node <plugin>/scripts/ledger.mjs --ledger <file> --session <id> [--root .] <kind> key=value ... key:=<json> ...
// Stamps `ts` (UTC) and `rule_version` (the manifest versions of /decide and the operator skill).
// `key=value` is a string; `key:=<json>` is typed (true, false, numbers, arrays). Kinds and fields: see README, Session ledger.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const take = (n) => { const i = args.indexOf(`--${n}`); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const ledger = take("ledger"), session = take("session"), root = resolve(take("root") ?? ".");
const [kind, ...pairs] = args;
if (!ledger || !session || !kind) { console.error("usage: ledger.mjs --ledger f --session id [--root .] <kind> key=value key:=json"); process.exit(64); }

const rule_version = {};
const mf = join(root, "skills", "MANIFEST.json");
if (existsSync(mf)) {
  const m = JSON.parse(readFileSync(mf, "utf8")).entries;
  for (const [k, name] of [["commands/decide.md", "decide"], ["skills/operator/SKILL.md", "operator"]]) if (m[k]) rule_version[name] = m[k].version;
}
const event = { ts: new Date().toISOString().replace(/\.\d+Z$/, "Z"), session, rule_version, kind };
for (const p of pairs) {
  const typed = p.match(/^([\w-]+):=(.*)$/s), plain = p.match(/^([\w-]+)=(.*)$/s);
  if (typed) event[typed[1]] = JSON.parse(typed[2]);
  else if (plain) event[plain[1]] = plain[2];
  else { console.error(`bad field: ${p}`); process.exit(64); }
}
appendFileSync(ledger, JSON.stringify(event) + "\n");
