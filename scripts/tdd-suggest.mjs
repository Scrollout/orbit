// Suggests tdd yes or no for one step, deterministically (no model), for a profile with `tdd: auto`. Zero dependencies.
//   node <plugin>/scripts/tdd-suggest.mjs --root . (--files a,b | --base <ref> --branch <ref>) [--lines sec=..,door=..] [--proof <test>]...
// decide-triage.mjs runs the same function when the profile says `tdd: auto`, and the triage event records the result as tdd: true/false.
// In order: no targeted_test in the profile -> no; no changed files -> no (unclear); docs or config only (scripts/paths.mjs) -> no;
// no test file in the repo or the change -> no; a security path or a one-way door (sec=yes, door=yes) with code touched -> yes;
// code touched and a proof test named (--proof) -> yes; anything else -> no (unclear). Prints `tdd: yes|no` and `reason: ...`.
// Exit 0, 64 bad usage, 70 git failure.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { classify } from "./paths.mjs";
import { loadProfile } from "./profile.mjs";

export function suggestTdd({ targetedTest, files = [], sec, door, proof = [], repoHasTests = false }) {
  const kinds = files.map(classify), code = kinds.includes("code");
  if (!targetedTest || /^TODO\b/i.test(targetedTest)) return { tdd: false, reason: "no targeted-test command in the profile" };
  if (!files.length) return { tdd: false, reason: "unclear: no changed files" };
  if (kinds.every((k) => k === "docs" || k === "config")) return { tdd: false, reason: "docs or config only" };
  if (!repoHasTests && !kinds.includes("test")) return { tdd: false, reason: "no tests in the repo or the change" };
  if (code && (sec === "yes" || door === "yes")) return { tdd: true, reason: "security path or one-way door" };
  if (code && proof.length) return { tdd: true, reason: "touches production code and names a proof test" };
  return { tdd: false, reason: code ? "unclear: no proof test named" : "unclear: no production code touched" };
}

// Whether the repository at root tracks any test file (git ls-files); false outside a git repo.
export function repoHasTests(root) {
  const r = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 && r.stdout.split("\0").some((f) => f && classify(f) === "test");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const root = resolve(flag("root") ?? ".");
  const base = flag("base"), branch = flag("branch"), planned = flag("files");
  if (!planned && (!base || !branch)) { console.error("usage: tdd-suggest.mjs --root . (--files a,b | --base <ref> --branch <ref>) [--lines sec=..,door=..] [--proof <test>]..."); process.exit(64); }
  let files;
  if (planned) files = planned.split(",").map((f) => f.trim()).filter(Boolean);
  else {
    if ([base, branch].some((r) => r.startsWith("-"))) { console.error("tdd-suggest: refusing a ref that starts with -"); process.exit(64); }
    const d = spawnSync("git", ["-C", root, "diff", "--no-renames", "-z", "--name-only", `${base}...${branch}`, "--"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (d.status !== 0) { console.error(`tdd-suggest: git diff failed: ${(d.stderr || "").trim()}`); process.exit(70); }
    files = d.stdout.split("\0").filter(Boolean);
  }
  const lines = Object.fromEntries((flag("lines") ?? "").split(",").filter(Boolean).map((kv) => kv.split("=")));
  const proof = args.flatMap((a, i) => (a === "--proof" && i + 1 < args.length ? [args[i + 1]] : []));
  const r = suggestTdd({ targetedTest: loadProfile(root, flag("profile")).data?.targeted_test, files, sec: lines.sec, door: lines.door, proof, repoHasTests: repoHasTests(root) });
  console.log(`tdd: ${r.tdd ? "yes" : "no"}\nreason: ${r.reason}`);
}
