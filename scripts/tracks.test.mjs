import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const real = () => ({ T: JSON.parse(readFileSync(join(repo, "rules/tracks.json"), "utf8")), text: readFileSync(join(repo, "refs/decide/team-tracks.md"), "utf8") });

// Differences between the Track table of team-tracks.md and rules/tracks.json, one string each; empty when they agree.
function drift(T, text) {
  const out = [];
  const rows = text.split("\n").filter((l) => /^\| (Just do it|Light review|Full review|Incident) /.test(l));
  if (rows.length !== 4) out.push(`${rows.length} track rows, expected 4`);
  const range = (c) => { if (c.trim() === "-") return [0, 0]; const lo = /^\d+/.exec(c)?.[0]; if (lo === undefined) return null; const hi = /^-(\d+)/.exec(c.slice(lo.length))?.[1]; return [Number(lo), Number(hi ?? lo)]; };
  for (const row of rows) {
    const c = row.split("|").slice(1, -1).map((x) => x.trim());
    const name = c[0].toLowerCase();
    const want = T.tracks[name];
    if (!want) { out.push(`track ${name} not in tracks.json`); continue; }
    const got = { analyst: range(c[2]), engineer: range(c[3]), reviewer: range(c[4]), security: range(c[5]), techlead: range(c[6]), max: Number(c[7]) };
    if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${name}: table ${JSON.stringify(got)} but tracks.json ${JSON.stringify(want)}`);
  }
  for (const name of Object.keys(T.tracks)) if (!rows.some((r) => r.toLowerCase().startsWith(`| ${name} `))) out.push(`track ${name} has no row in the table`);
  return out;
}

test("rules/tracks.json equals the Track table in refs/decide/team-tracks.md", () => {
  const { T, text } = real();
  assert.deepEqual(drift(T, text), []);
});

test("drift check: a cap changed in the table, a cap changed in the json, a missing row and an unknown track are all caught", () => {
  const { T, text } = real();
  assert.match(drift(T, text.replace("| Full review | any line yes | 0-1 | 1-2 | 1 | 1 | 1 | 5 |", "| Full review | any line yes | 0-1 | 1-2 | 1 | 1 | 1 | 6 |"))[0], /full review: table .*"max":6/);
  assert.match(drift(T, text.replace("| 1-2 | 1 | 1 | 1 | 5 |", "| 1-3 | 1 | 1 | 1 | 5 |"))[0], /full review: table/);
  const edited = JSON.parse(JSON.stringify(T)); edited.tracks.incident.security = [0, 1];
  assert.match(drift(edited, text)[0], /incident: table .* but tracks\.json/);
  assert.match(drift(T, text.split("\n").filter((l) => !l.startsWith("| Incident ")).join("\n")).join("\n"), /3 track rows, expected 4[\s\S]*track incident has no row/);
  const extra = JSON.parse(JSON.stringify(T)); delete extra.tracks["light review"];
  assert.match(drift(extra, text).join("\n"), /track light review not in tracks\.json/);
  assert.match(drift(T, text.replace("| 0-1 | 1 | - | - | 1 | 3 |", "| 0-1 | x | - | - | 1 | 3 |")).join("\n"), /light review: table/);
});
