import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "tracker.mjs");

// A stub gh on PATH: the tracked executable fixtures/gh-stub.sh (sh, so it starts fast under load), linked into each repo's .bin.
// It lives in the checkout, not a temp file: CI mounts /tmp noexec, so a stub written there cannot run. It answers
// <key>.out / <key>.code from GH_STUB and logs each call.
const STUB = join(here, "fixtures", "gh-stub.sh");
const ALL = {
  auth: { code: 0, out: "github.com\n  Logged in to github.com\n  Token scopes: 'gist', 'project', 'repo'\n" },
  repo: { out: { has_issues: true, owner: { login: "acme", type: "Organization" } } },
  labels: { out: [{ name: "bug" }] },
  milestones: { out: [] },
  types: { out: { data: { organization: { issueTypes: { nodes: [{ name: "Bug" }] } } } } },
  projects: { out: { data: { repository: { projectsV2: { totalCount: 0 } } } } },
};
const PROFILE = "base_branch: main\nsecurity_paths: [ci/]\nreview_trailer: none\nlabels: [bug, feature, chore]\nissue_tracker: github\nbase_pusher: agent\nci_policy: ci-only";

function setup({ stub = ALL, remote = "git@github.com:acme/app.git", extra = "", gh = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "trk-"));
  spawnSync("git", ["init", "-q", root]);
  if (remote) spawnSync("git", ["-C", root, "remote", "add", "origin", remote]);
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents", "project.md"), "# P\n\n```yaml orbit-profile\n" + PROFILE + (extra ? "\n" + extra : "") + "\n```\n");
  const bin = join(root, ".bin");
  mkdirSync(bin);
  if (gh) { symlinkSync(STUB, join(bin, "gh")); }
  mkdirSync(join(root, ".stub"));
  for (const [k, r] of Object.entries(stub)) {
    writeFileSync(join(root, ".stub", `${k}.out`), typeof r.out === "string" ? r.out : JSON.stringify(r.out));
    writeFileSync(join(root, ".stub", `${k}.code`), String(r.code ?? 0));
  }
  return root;
}
// Only git and cat on PATH besides the stub: a real gh on the host is never reached (no network in tests).
const tools = mkdtempSync(join(tmpdir(), "trk-tools-"));
for (const t of ["git", "cat"]) symlinkSync(spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim(), join(tools, t));
const run = (root, ...a) => spawnSync(process.execPath, [script, "--root", root, ...a], {
  encoding: "utf8", env: { PATH: [join(root, ".bin"), tools].join(":"), GH_STUB: join(root, ".stub"), GH_LOG: join(root, ".log"), HOME: root },
});
const calls = (root) => (existsSync(join(root, ".log")) ? readFileSync(join(root, ".log"), "utf8").trim().split("\n").filter(Boolean) : []);
const cache = (root) => JSON.parse(readFileSync(join(root, ".orbit", "tracker.json"), "utf8"));
const on = (root) => cache(root).features;

test("no GitHub remote: features off, no gh call", () => {
  const root = setup({ remote: "https://gitlab.com/acme/app.git" });
  const r = run(root, "--detect");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^tracker: no GitHub remote/);
  assert.deepEqual(calls(root), []);
});

test("all present: every feature detected, cache written and self-ignored, one line", () => {
  const root = setup({ extra: "github_projects: on" });
  const r = run(root, "--detect");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(on(root), { issues: true, labels: true, milestones: true, issue_types: true, projects: true });
  assert.equal(cache(root).repo, "acme/app");
  assert.ok(!Number.isNaN(Date.parse(cache(root).checked_at)));
  assert.equal(readFileSync(join(root, ".orbit", ".gitignore"), "utf8"), "*\n");
  assert.equal(r.stdout, "tracker: GitHub acme/app, on: issues, labels, milestones, issue types, projects\n");
  assert.ok(calls(root).every((c) => /^(auth status|api )/.test(c)), "read-only calls only");
  assert.ok(!calls(root).some((c) => /\bmutation\b|-X|--method/.test(c)), "no write");
});

test("absent features: issues disabled, user repo, no project scope", () => {
  let root = setup({ stub: { ...ALL, repo: { out: { has_issues: false, owner: { login: "acme", type: "Organization" } } } } });
  run(root, "--detect");
  assert.deepEqual(on(root), { issues: false, labels: false, milestones: false, issue_types: false, projects: true });
  root = setup({ stub: { ...ALL, repo: { out: { has_issues: true, owner: { login: "acme", type: "User" } } } } });
  run(root, "--detect");
  assert.equal(on(root).issue_types, false);
  assert.ok(!calls(root).some((c) => c.includes("issueTypes")), "no org query for a user repo");
  root = setup({ stub: { ...ALL, auth: { code: 0, out: "Token scopes: 'repo'" } } });
  run(root, "--detect");
  assert.equal(on(root).projects, false);
  root = setup({ stub: { ...ALL, types: { out: { data: { organization: { issueTypes: { nodes: [] } } } } } } });
  run(root, "--detect");
  assert.equal(on(root).issue_types, false);
});

test("erroring features turn off alone; no gh or no auth turns all off", () => {
  let root = setup({ stub: { ...ALL, labels: { code: 1, out: "" }, types: { code: 0, out: { errors: [{ message: "x" }] } }, projects: { code: 1, out: "" } } });
  run(root, "--detect");
  assert.deepEqual(on(root), { issues: true, labels: false, milestones: true, issue_types: false, projects: false });
  root = setup({ stub: { ...ALL, milestones: { code: 0, out: "not json" } } });
  run(root, "--detect");
  assert.equal(on(root).milestones, false);
  root = setup({ stub: { ...ALL, auth: { code: 1, out: "" } } });
  run(root, "--detect");
  assert.deepEqual(on(root), { issues: false, labels: false, milestones: false, issue_types: false, projects: false });
  root = setup({ gh: false });
  const r = run(root, "--detect");
  assert.equal(r.status, 0);
  assert.equal(on(root).issues, false);
});

test("the deadline is one budget: once spent, every later call is skipped and its feature is off", async () => {
  const { detect } = await import("./tracker.mjs");
  const seen = [];
  const f = detect({ owner: "acme", name: "app" }, (args, ms) => { seen.push(ms); return { status: null, stdout: "" }; }, Date.now() - 1);
  assert.deepEqual(f, { issues: false, labels: false, milestones: false, issue_types: false, projects: false });
  assert.deepEqual(seen, [], "no call after the deadline");
});

test("profile no beats detection; github_projects defaults to off", () => {
  let root = setup({ extra: "milestones: no\nissue_types: no" });
  let r = run(root, "--detect");
  assert.equal(r.stdout, "tracker: GitHub acme/app, on: issues, labels; projects available (github_projects: off)\n");
  root = setup({ extra: "github_projects: on" });
  writeFileSync(join(root, ".agents", "project.md"), readFileSync(join(root, ".agents", "project.md"), "utf8").replace("issue_tracker: github", "issue_tracker: none"));
  r = run(root, "--detect");
  assert.equal(r.stdout, "tracker: GitHub acme/app, on: none\n");
});

test("cache: fresh is reused without gh, older than 7 days or --detect re-checks", () => {
  const root = setup();
  run(root, "--detect");
  const n = calls(root).length;
  run(root);
  assert.equal(calls(root).length, n, "fresh cache, no call");
  const c = cache(root);
  c.checked_at = new Date(Date.now() - 8 * 86400000).toISOString();
  writeFileSync(join(root, ".orbit", "tracker.json"), JSON.stringify(c));
  run(root);
  assert.ok(calls(root).length > n, "stale cache re-detects");
  const m = calls(root).length;
  run(root, "--detect");
  assert.ok(calls(root).length > m, "--detect always re-detects");
});

test("intent step 8 plan: issues with labels, milestone, type; a Project only when on", () => {
  let root = setup({ extra: "areas: [cli, docs]" });
  let r = run(root, "--plan", "M3 It's big");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gh api repos\/acme\/app\/milestones -f title='M3 It'\\''s big'/);
  assert.match(r.stdout, /gh issue create --repo acme\/app .*--label <type> --label <area: cli\|docs> --milestone 'M3 It'\\''s big'/);
  assert.match(r.stdout, /updateIssueIssueType/);
  assert.doesNotMatch(r.stdout, /gh project|--project/);
  r = run(root, "--plan", "M3 It's big", "--project");
  assert.match(r.stdout, /gh project create --owner acme --title 'M3 It'\\''s big'/);
  assert.match(r.stdout, /gh project link <number> --owner acme --repo acme\/app/);
  assert.match(r.stdout, /Board layout, grouped by Status: Todo, In progress, In review, Done/);
  assert.match(r.stdout, /--project 'M3 It'\\''s big'/);
  root = setup({ stub: { ...ALL, auth: { code: 0, out: "Token scopes: 'repo'" } }, extra: "github_projects: on\nmilestones: no" });
  r = run(root, "--plan", "M4 X");
  assert.doesNotMatch(r.stdout, /gh project|--project|milestone/, "projects unavailable: skipped silently");
  root = setup({ remote: "" });
  r = run(root, "--plan", "M4 X");
  assert.equal(r.stdout, "tracker: no GitHub remote; no tracker commands\n");
});
