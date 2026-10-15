// Triage and track for /decide, computed instead of remembered. Zero dependencies.
//   node <plugin>/scripts/decide-triage.mjs --root . (--base <ref> --branch <ref> | --files a,b)
//     [--lines sec=yes|no,door=yes|no,prod=yes|no] [--kind small|design|incident] [--profile path]
// A branch whose `git diff --name-only <base>...<branch>` (three dots) touches a profile security glob forces sec=yes.
// Prints the track, the per-role call caps (rules/tracks.json), the coder model and tdd (DEC-21, DEC-22: record it on the triage event); a line left unset is a
// `triage gap` (exit 2), never a guess: a forced security yes does not fill the door or prod lines, the one-way-door
// question is separate. `prod` is skipped when the profile has no production_env. `--files` triages planned paths when
// there is no branch yet (step 2 of /decide). Exit codes: 0 ok, 1 profile gap, 2 triage gap, 64 usage, 70 git failure.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gaps, loadProfile, matchesAny, RELEASE_FIELDS } from "./profile.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const root = resolve(flag("root") ?? ".");
const base = flag("base"), branch = flag("branch"), planned = flag("files");
if (!planned && (!base || !branch)) { console.error("usage: decide-triage.mjs --root . --base <ref> --branch <ref> | --files a,b [--lines sec=..,door=..,prod=..] [--kind small|design|incident]"); process.exit(64); }

const { data: profile } = loadProfile(root, flag("profile"));
// production_env TODO is not a profile gap here: it just means the prod= line must be given (or the field set to none).
// Release fields and test_first_commit do not affect triage; tdd is printed for the triage event, and an invalid tdd (or tdd: yes
// without targeted_test) is a profile gap, never a silent no.
const pg = gaps(profile).filter((g) => g !== "production_env" && g !== "test_first_commit" && !RELEASE_FIELDS.includes(g));
if (pg.length) { for (const g of pg) console.log(`profile gap: ${g}`); process.exit(1); }
const kind = flag("kind");
if (kind !== undefined && !["small", "design", "incident"].includes(kind)) { console.error(`bad --kind: ${kind} (small, design or incident)`); process.exit(64); }
// Three dots: the branch's own changes since it left the base. --no-renames lists both paths of a rename; -z avoids quoting.
let files;
if (planned) files = planned.split(",").map((f) => f.trim()).filter(Boolean);
else {
  for (const r of [base, branch]) if (r.startsWith("-")) { console.error(`decide-triage: refusing ref ${r} (starts with -)`); process.exit(64); }
  const d = spawnSync("git", ["diff", "--no-renames", "-z", "--name-only", `${base}...${branch}`, "--"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (d.error || d.status !== 0) {
    const why = d.error?.code === "ENOBUFS" ? "output over 64 MB" : (d.stderr || String(d.error)).trim().split("\n")[0];
    console.error(`decide-triage: git diff failed: ${why}`);
    process.exit(70);
  }
  files = d.stdout.split("\0").filter(Boolean);
}
const touched = files.filter((f) => matchesAny(f, profile.security_paths));

const lines = {};
for (const kv of (flag("lines") ?? "").split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  if (!["sec", "door", "prod"].includes(k) || !["yes", "no"].includes(v)) { console.error(`bad --lines entry: ${kv}`); process.exit(64); }
  lines[k] = v;
}
const hasProd = profile.production_env && !/^(none|todo)/i.test(profile.production_env);
if (!hasProd && !/^todo/i.test(profile.production_env ?? "")) lines.prod ??= "no";
let secText = lines.sec ?? "unset";
if (touched.length) { lines.sec = "yes"; secText = `yes (forced: ${touched.join(", ")})`; }

const gapsOut = [];
const anyYes = Object.values(lines).includes("yes");
for (const k of ["sec", "door", "prod"]) if (!lines[k]) gapsOut.push(k);
if (!anyYes && !kind && !gapsOut.length) gapsOut.push("kind");
if (gapsOut.length) { for (const g of gapsOut) console.log(`triage gap: ${g}`); process.exit(2); }

const T = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "rules", "tracks.json"), "utf8"));
const track = kind === "incident" ? "incident" : anyYes ? "full review" : kind === "design" ? "light review" : "just do it";
const caps = T.tracks[track];
console.log(`security: ${secText}`);
console.log(`door: ${lines.door ?? "unset"}`);
console.log(`prod: ${lines.prod ?? "unset"}`);
console.log(`files: ${files.length}`);
console.log(`track: ${track}`);
console.log(`caps: ${T.roles.map((r) => `${r} ${caps[r][0] === caps[r][1] ? caps[r][0] : caps[r].join("-")}`).join(", ")}`);
console.log(`max calls: ${caps.max}`);
console.log(`coder model: ${anyYes || kind === "incident" ? "opus" : "sonnet"}`);
console.log(`tdd: ${profile.tdd === "yes" ? "yes" : "no"}`);
