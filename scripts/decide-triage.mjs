// Triage and track for /decide, computed instead of remembered. Zero dependencies.
//   node <plugin>/scripts/decide-triage.mjs --root . --base <ref> --branch <ref>
//     [--lines sec=yes|no,door=yes|no,prod=yes|no] [--kind small|design|incident] [--profile path]
// A branch whose `git diff --name-only <base>..<branch>` touches a profile security glob forces sec=yes.
// Prints the track, the per-role call caps (rules/tracks.json) and the coder model; a line left unset is a
// `triage gap` (exit 2), never a guess. `prod` is skipped when the profile has no production_env.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile, matchesAny } from "./profile.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const root = resolve(flag("root") ?? ".");
const base = flag("base"), branch = flag("branch");
if (!base || !branch) { console.error("usage: decide-triage.mjs --root . --base <ref> --branch <ref> [--lines sec=..,door=..,prod=..] [--kind small|design|incident]"); process.exit(64); }

const { data: profile } = loadProfile(root, flag("profile"));
if (!profile?.security_paths?.length) { console.log("profile gap: security_paths"); process.exit(1); }
const d = spawnSync("git", ["diff", "--name-only", `${base}..${branch}`], { cwd: root, encoding: "utf8" });
if (d.status !== 0) { console.error(d.stderr); process.exit(1); }
const files = d.stdout.split("\n").filter(Boolean);
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

const kind = flag("kind");
const gapsOut = [];
const anyYes = Object.values(lines).includes("yes");
if (!anyYes) {
  for (const k of ["sec", "door", "prod"]) if (!lines[k]) gapsOut.push(k);
  if (!kind && !gapsOut.length) gapsOut.push("kind");
}
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
console.log(`coder model: ${anyYes ? "opus" : "sonnet"}`);
