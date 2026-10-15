// Appends one result record (a JSON line) for a check. Called by lib.sh; schema in ci/README.md.
// Usage: node record.mjs <file> <target> <check> <tool> <version> <status> <seconds> <logfile> [note]
import { appendFileSync, readFileSync } from "node:fs";

export const MAX_LINES = 20, MAX_LINE_CHARS = 300;
const [file, target, check, tool, version, status, seconds, logfile, note] = process.argv.slice(2);
// A finding is a log line that starts with path:line (shellcheck -f gcc, eslint -f unix, node --check, gitleaks).
const lines = readFileSync(logfile, "utf8").split("\n").filter((l) => l.trim() !== "");
const located = lines.filter((l) => /^[^\s:]+:\d+/.test(l));
const findings = status === "fail" ? (located.length || lines.length || 1) : 0;
const shown = status === "fail" ? (located.length ? located : lines) : [];
const record = {
  check, target, status, duration_s: Number(seconds), tool, version, findings,
  excerpts: shown.slice(0, MAX_LINES).map((l) => l.slice(0, MAX_LINE_CHARS)),
};
if (note) record.note = note;
appendFileSync(file, JSON.stringify(record) + "\n");
