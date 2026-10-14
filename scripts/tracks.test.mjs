import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

test("rules/tracks.json equals the Track table in refs/decide/team-tracks.md", () => {
  const T = JSON.parse(readFileSync(join(repo, "rules/tracks.json"), "utf8"));
  const text = readFileSync(join(repo, "refs/decide/team-tracks.md"), "utf8");
  const rows = text.split("\n").filter((l) => /^\| (Just do it|Light review|Full review|Incident) /.test(l));
  assert.equal(rows.length, 4);
  const range = (c) => { if (c.trim() === "-") return [0, 0]; const m = c.match(/^(\d+)(?:-(\d+))?/); return [Number(m[1]), Number(m[2] ?? m[1])]; };
  for (const row of rows) {
    const c = row.split("|").slice(1, -1).map((x) => x.trim());
    const name = c[0].toLowerCase();
    const want = T.tracks[name];
    assert.ok(want, `track ${name} in tracks.json`);
    const got = { analyst: range(c[2]), engineer: range(c[3]), reviewer: range(c[4]), security: range(c[5]), techlead: range(c[6]), max: Number(c[7]) };
    assert.deepEqual(got, want, name);
  }
});
