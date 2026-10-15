// Prints gitleaks' JSON report as `file:line rule (commit)` lines; never the secret or the match.
// A missing, empty or unparseable report prints nothing (gitleaks.sh says why).
import { readFileSync } from "node:fs";
let r = [];
try { r = JSON.parse(readFileSync(process.argv[2], "utf8") || "[]"); } catch { process.exit(0); }
for (const f of Array.isArray(r) ? r : []) console.log(`${f.File}:${f.StartLine} ${f.RuleID} (commit ${String(f.Commit || "").slice(0, 12) || "tree"})`);
