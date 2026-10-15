// Prints gitleaks' JSON report as `file:line rule (commit)` lines; never the secret or the match.
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8") || "[]");
for (const f of r) console.log(`${f.File}:${f.StartLine} ${f.RuleID} (commit ${String(f.Commit || "").slice(0, 12) || "tree"})`);
