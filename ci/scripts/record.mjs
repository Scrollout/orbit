// Appends one result record (a JSON line) for a check and caps its log in place. Called by lib.sh; schema in ci/README.md.
// Usage: node record.mjs <file> <target> <check> <tool> <version> <status> <seconds> <logfile> [note]
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

export const MAX_LINES = 20, MAX_LINE_CHARS = 300, LOG_HALF = 128 * 1024; // log kept: first and last 128 KiB
// A finding is a log line that starts with path:line (shellcheck -f gcc, eslint-format.mjs, node --check, gitleaks.sh).
// Some checks print findings in their own shape.
const FINDING = { "npm-test": /^\s*(✖|not ok)\s/ };
const [file, target, check, tool, version, status, seconds, logfile, note] = process.argv.slice(2);
const real = existsSync(logfile) && statSync(logfile).isFile();
let text = real ? readFileSync(logfile, "utf8") : "";
if (real && Buffer.byteLength(text) > 2 * LOG_HALF) {
  const b = Buffer.from(text);
  text = `${b.subarray(0, LOG_HALF).toString()}\n[... log cut by ci/scripts/record.mjs: ${b.length - 2 * LOG_HALF} bytes omitted ...]\n${b.subarray(b.length - LOG_HALF).toString()}`;
  writeFileSync(logfile, text);
}
const lines = text.split("\n").filter((l) => l.trim() !== "");
const located = lines.filter((l) => (FINDING[check] ?? /^[^\s:]+:\d+/).test(l));
const findings = status === "fail" ? (located.length || lines.length || 1) : 0;
// No located lines: the last lines, where tools print the verdict.
const shown = status !== "fail" ? [] : located.length ? located.slice(0, MAX_LINES) : lines.slice(-MAX_LINES);
const record = { check, target, status, duration_s: Number(seconds), tool, version, findings, excerpts: shown.map((l) => l.slice(0, MAX_LINE_CHARS)) };
if (real) record.log = `${target}.${check}.log`;
if (note) record.note = note;
appendFileSync(file, JSON.stringify(record) + "\n");
