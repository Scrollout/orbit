// Tracker awareness (#14): which GitHub tracker features this project can use. Zero dependencies.
//   node <plugin>/scripts/tracker.mjs [--root .] [--detect] [--plan "<milestone title>" [--project]]
// Detect (read-only gh calls under one deadline; any failure turns that feature off): an origin remote on github.com, gh
// authed, the `project` token scope, issues enabled, labels and milestones readable, org issue types (none for a user repo),
// Projects v2 readable. Cached in .orbit/tracker.json of the main checkout (self-ignored by .orbit/.gitignore) with
// checked_at; re-detected when older than 7 days or on --detect. The profile overrides: `issue_tracker: none|no|off` turns
// everything off, `milestones: no` and `issue_types: no` turn theirs off, and Projects are on only with `github_projects: on`
// (default off) or --project (the owner's yes for one milestone). Detection never turns on what the profile turns off.
// Prints one line of the features on (the SessionStart handoff shows it); --plan prints the intent step 8 commands instead.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadProfile } from "./profile.mjs";

const DEADLINE_MS = 7000;              // the whole detection, inside the 10 s SessionStart hook timeout
const MAX_AGE_MS = 7 * 86400000;       // weekly refresh
const FEATURES = ["issues", "labels", "milestones", "issue_types", "projects"];
const off = () => Object.fromEntries(FEATURES.map((f) => [f, false]));

// owner/name of a github.com remote URL (https, ssh or scp form), else null.
export function githubRepo(url) {
  const m = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+)$/.exec(String(url).trim());
  return m ? { owner: m[1], name: m[2].replace(/\.git$/, "") } : null;
}

// The detected features of a repo. run(args, timeoutMs) -> {status, stdout}; no call starts after the deadline.
export function detect(repo, run, deadline) {
  const gh = (...args) => {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    const r = run(args, left);
    return r.status === 0 ? r.stdout : null;
  };
  const json = (...args) => { const out = gh(...args); try { return out === null ? null : JSON.parse(out); } catch { return null; } };
  const f = off();
  const login = gh("auth", "status", "--hostname", "github.com");
  if (login === null) return f;
  const r = `repos/${repo.owner}/${repo.name}`;
  const info = json("api", r);
  f.issues = info?.has_issues === true;
  if (f.issues) {
    f.labels = Array.isArray(json("api", `${r}/labels?per_page=1`));
    f.milestones = Array.isArray(json("api", `${r}/milestones?state=all&per_page=1`));
    if (info.owner?.type === "Organization") {
      const t = json("api", "graphql", "-f", "query=query($o:String!){organization(login:$o){issueTypes(first:1){nodes{name}}}}", "-f", `o=${repo.owner}`);
      f.issue_types = (t?.data?.organization?.issueTypes?.nodes?.length ?? 0) > 0;
    }
  }
  if (login.includes("'project'")) {
    const p = json("api", "graphql", "-f", "query=query($o:String!,$n:String!){repository(owner:$o,name:$n){projectsV2(first:1){totalCount}}}", "-f", `o=${repo.owner}`, "-f", `n=${repo.name}`);
    f.projects = typeof p?.data?.repository?.projectsV2?.totalCount === "number";
  }
  return f;
}

const git = (dir, ...a) => { const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", timeout: 3000 }); return r.status === 0 ? r.stdout.trim() : ""; };
const mainRoot = (root) => { const c = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"); return c && basename(c) === ".git" ? dirname(c) : root; };

// The cached detection of the main checkout, re-detected when missing, stale or forced.
export function tracker(root, force) {
  const main = mainRoot(root), file = join(main, ".orbit", "tracker.json");
  if (!force) {
    try { const c = JSON.parse(readFileSync(file, "utf8")); if (Date.now() - Date.parse(c.checked_at) < MAX_AGE_MS) return { main, cache: c }; } catch { /* no or bad cache: detect */ }
  }
  const repo = githubRepo(git(main, "remote", "get-url", "origin"));
  const run = (args, ms) => spawnSync("gh", args, { encoding: "utf8", timeout: ms, stdio: ["ignore", "pipe", "pipe"] });
  const features = repo ? detect(repo, (a, ms) => { const r = run(a, ms); return { status: r.status, stdout: a[0] === "auth" ? `${r.stdout}${r.stderr}` : r.stdout }; }, Date.now() + DEADLINE_MS) : off();
  const cache = { checked_at: new Date().toISOString(), repo: repo ? `${repo.owner}/${repo.name}` : null, features };
  try {
    mkdirSync(join(main, ".orbit"), { recursive: true });
    writeFileSync(join(main, ".orbit", ".gitignore"), "*\n");
    writeFileSync(file, JSON.stringify(cache, null, 2) + "\n");
  } catch { /* read-only checkout: use the result uncached */ }
  return { main, cache };
}

// The features on after the profile's overrides; projects also when the owner said yes for this milestone (--project).
export function effective(cache, profile, projectYes) {
  const p = profile ?? {}, f = { ...off(), ...cache.features };
  if (/^(none|no|off)$/i.test(String(p.issue_tracker ?? "").trim())) return off();
  if (p.milestones === "no") f.milestones = false;
  if (p.issue_types === "no") f.issue_types = false;
  const available = f.projects;
  f.projects = available && (p.github_projects === "on" || projectYes === true);
  return { ...f, projectsAvailable: available };
}

const NAMES = { issues: "issues", labels: "labels", milestones: "milestones", issue_types: "issue types", projects: "projects" };
export function line(cache, f) {
  if (!cache.repo) return "tracker: no GitHub remote; tracker features off";
  const list = FEATURES.filter((k) => f[k]).map((k) => NAMES[k]);
  return `tracker: GitHub ${cache.repo}, on: ${list.join(", ") || "none"}${f.projectsAvailable && !f.projects ? "; projects available (github_projects: off)" : ""}`;
}

const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
// The intent step 8 commands for milestone `title`: milestone, Project (only when on), one issue per step, its issue type.
export function plan(cache, f, title, areas) {
  if (!cache.repo) return ["tracker: no GitHub remote; no tracker commands"];
  const [owner] = cache.repo.split("/"), t = q(title), out = [];
  if (!f.issues) return [`tracker: issues off on ${cache.repo}; no tracker commands`];
  if (f.milestones) out.push(`gh api repos/${cache.repo}/milestones -f title=${t}   # only when missing (gh api repos/${cache.repo}/milestones?state=all)`);
  if (f.projects) out.push(
    `gh project create --owner ${owner} --title ${t}   # reuse one with this title from: gh project list --owner ${owner}`,
    `gh project link <number> --owner ${owner} --repo ${cache.repo}`,
    `# owner, once, on the Project page: Board layout, grouped by Status: Todo, In progress, In review, Done (add the In review option)`);
  const area = Array.isArray(areas) && areas.length ? ` --label <area: ${areas.join("|")}>` : "";
  out.push(`gh issue create --repo ${cache.repo} --title <step> --body-file <file>${f.labels ? " --label <type>" + area : ""}${f.milestones ? ` --milestone ${t}` : ""}${f.projects ? ` --project ${t}` : ""}   # one per step`);
  if (f.issue_types) out.push(`gh api graphql -f query='mutation($i:ID!,$t:ID!){updateIssueIssueType(input:{issueId:$i,issueTypeId:$t}){issue{number}}}' -f i=<issue node id> -f t=<Bug|Feature|Task type id>`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const root = resolve(flag("root") ?? ".");
  const title = flag("plan");
  if (args.includes("--plan") && (!title || title.startsWith("--"))) { console.error('usage: tracker.mjs [--root .] [--detect] [--plan "<milestone title>" [--project]]'); process.exit(64); }
  const { main, cache } = tracker(root, args.includes("--detect"));
  const profile = loadProfile(main).data;
  const f = effective(cache, profile, args.includes("--project"));
  console.log((title ? plan(cache, f, title, profile?.areas) : [line(cache, f)]).join("\n"));
}
