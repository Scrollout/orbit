// Release checks for OPR-09, read-only: it never changes a setting, a file or a tag. Zero dependencies.
//   node <plugin>/scripts/release-check.mjs --repo [--root .] [--slug owner/name] [--profile p]
//     The forge's guard rails (GitHub, read through `gh api`): required status checks and no force push on the base
//     (branch protection or a ruleset), an active tag ruleset covering `v*` that blocks update and deletion, immutable
//     releases, a CI workflow (one that runs on tags when `release_via: ci`) and local tag signing. Each `gap:` comes
//     with a `fix:` line for the owner; settings are the owner's to change.
//   node <plugin>/scripts/release-check.mjs --next [--root .] [--bump major|minor|patch] [--notes <file>]
//     [--version-files a,b] [--changelog CHANGELOG.md] [--profile p]
//     The release about to be cut: the last stable `v*` tag reachable from HEAD, the bump the commits since then need
//     (Conventional Commits: `type!:` or `BREAKING CHANGE:` major, `feat` minor, other types patch; a major is a
//     minor while 0.y.z), the version the version files declare (all must agree), the changelog's top `## X.Y.Z` or
//     `## [X.Y.Z]` section (an `Unreleased` section is skipped), and that the tag does not exist yet. With `--notes`
//     it writes that section plus the compare link. Flags override the profile's `version_files` and `changelog`.
// Exit codes: 0 no gap, 1 gaps, 64 usage, 70 git or gh unavailable. `ORBIT_GH_STUB` (tests only): a .mjs file run
// with node in place of `gh`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadProfile } from "./profile.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const die = (code, m) => { console.error(`release-check: ${m}`); process.exit(code); };
const mode = args.includes("--repo") ? "repo" : args.includes("--next") ? "next" : null;
if (!mode || (args.includes("--repo") && args.includes("--next"))) die(64, "usage: release-check.mjs --repo [--root .] [--slug o/n] | --next [--root .] [--bump major|minor|patch] [--notes f] [--version-files a,b] [--changelog f]");
const root = resolve(flag("root") ?? ".");
const { data: profile } = loadProfile(root, flag("profile"));
const P = profile ?? {};
const usable = (v) => v !== undefined && v !== "" && !/^TODO\b/i.test(String(v));
const gaps = [], warns = [];
const gap = (m, fix) => gaps.push(fix ? `gap: ${m}\n  fix: ${fix}` : `gap: ${m}`);

const git = (...a) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });

const SEMVER = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function finish() {
  for (const w of warns) console.log(`warn: ${w}`);
  for (const g of gaps) console.log(g);
  process.exit(gaps.length ? 1 : 0);
}

if (mode === "repo") {
  const gh = (...a) => {
    const stub = process.env.ORBIT_GH_STUB;
    const r = stub ? spawnSync(process.execPath, [stub, ...a], { encoding: "utf8" }) : spawnSync("gh", a, { encoding: "utf8" });
    if (r.error) die(70, `cannot run gh: ${r.error.message}`);
    const status = r.status === 0 ? 200 : Number((r.stderr.match(/HTTP (\d{3})/) ?? [])[1] ?? 0);
    let json = null;
    try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
    return { ok: r.status === 0, status, json };
  };
  let slug = flag("slug");
  if (!slug) {
    const r = gh("repo", "view", "--json", "nameWithOwner");
    if (!r.ok || !r.json?.nameWithOwner) die(70, "cannot read the repository with gh (gh auth status; or pass --slug owner/name)");
    slug = r.json.nameWithOwner;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) die(64, `bad slug ${slug}`);
  let base = usable(P.base_branch) ? P.base_branch : null;
  if (!base) {
    const r = gh("api", `repos/${slug}`);
    base = r.json?.default_branch;
    if (!base) die(70, `cannot read repos/${slug}`);
  }
  const settings = `https://github.com/${slug}/settings`;

  // Base branch: rules from rulesets (any source) plus classic protection.
  const rules = gh("api", `repos/${slug}/rules/branches/${encodeURIComponent(base)}`);
  const types = new Set(rules.ok && Array.isArray(rules.json) ? rules.json.map((x) => x.type) : []);
  const classic = gh("api", `repos/${slug}/branches/${encodeURIComponent(base)}/protection`);
  if (!classic.ok && classic.status !== 404) warns.push(`cannot read classic branch protection of ${base} (HTTP ${classic.status || "?"}; needs admin): only rulesets were checked`);
  const cp = classic.ok ? classic.json : null;
  const checks = types.has("required_status_checks") || (cp?.required_status_checks?.contexts?.length ?? 0) + (cp?.required_status_checks?.checks?.length ?? 0) > 0;
  const noForce = types.has("non_fast_forward") || (cp && cp.allow_force_pushes?.enabled === false);
  const noDelete = types.has("deletion") || (cp && cp.allow_deletions?.enabled === false);
  if (!checks) gap(`base ${base} has no required status checks`, `${settings}/rules/new?target=branch (target ${base}; require status checks to pass, block force pushes and deletion)`);
  if (!noForce) gap(`base ${base} allows force pushes`, `${settings}/rules/new?target=branch (block force pushes on ${base})`);
  if (!noDelete) gap(`base ${base} can be deleted`, `${settings}/rules/new?target=branch (restrict deletions on ${base})`);

  // Tags: an active tag ruleset covering refs/tags/v* with update and deletion rules.
  const list = gh("api", `repos/${slug}/rulesets?includes_parents=true`);
  if (!list.ok) warns.push(`cannot list rulesets (HTTP ${list.status || "?"})`);
  const covers = (inc) => (inc ?? []).some((p) => ["~ALL", "refs/tags/*", "refs/tags/**/*", "refs/tags/v*"].includes(p) || /^refs\/tags\/v[\d*]/.test(p) && p.endsWith("*"));
  let tagOk = false;
  for (const rs of list.ok && Array.isArray(list.json) ? list.json : []) {
    if (rs.target !== "tag" || rs.enforcement !== "active") continue;
    const d = gh("api", `repos/${slug}/rulesets/${Number(rs.id)}`);
    if (!d.ok) { warns.push(`cannot read tag ruleset ${rs.id}`); continue; }
    const t = new Set((d.json.rules ?? []).map((x) => x.type));
    if (covers(d.json.conditions?.ref_name?.include) && t.has("update") && t.has("deletion")) tagOk = true;
  }
  if (!tagOk) gap("no active tag ruleset protects v* tags from update and deletion", `${settings}/rules/new?target=tag (include refs/tags/v*; restrict updates, restrict deletions)`);

  const imm = gh("api", `repos/${slug}/immutable-releases`);
  if (imm.ok && imm.json?.enabled === true) { /* ok */ }
  else if (imm.ok || imm.status === 404) gap("immutable releases are off (a published release's tag and assets can change)", `gh api -X PUT repos/${slug}/immutable-releases`);
  else warns.push(`cannot read the immutable releases setting (HTTP ${imm.status || "?"})`);

  // CI: a workflow on disk; with release_via ci, one that runs on tag pushes.
  const wf = join(root, ".github", "workflows");
  const files = existsSync(wf) ? readdirSync(wf).filter((f) => /\.ya?ml$/.test(f)) : [];
  if (!files.length) gap("no CI workflow in .github/workflows (tagging a green commit cannot be checked)", "add a workflow that runs the profile's full check on pushes to the base and on pull requests");
  else if (P.release_via === "ci" && !files.some((f) => /^\s*tags\s*:/m.test(readFileSync(join(wf, f), "utf8"))))
    gap("release_via is ci but no workflow runs on tag pushes", "adapt the plugin's templates/release.yml to .github/workflows/release.yml");

  const cfg = (k) => git("config", "--get", k).stdout.trim();
  if (cfg("tag.gpgSign") !== "true" || !cfg("user.signingkey"))
    gap("tags are not signed (tag.gpgSign and user.signingkey unset)", "git config --global gpg.format ssh && git config --global user.signingkey ~/.ssh/id_ed25519.pub && git config --global tag.gpgSign true && gh ssh-key add ~/.ssh/id_ed25519.pub --type signing");
  console.log(`repo: ${slug} base: ${base}`);
  finish();
}

// --next
const cmp = (a, b) => { for (let i = 1; i <= 3; i++) { const d = Number(a[i]) - Number(b[i]); if (d) return d; } return 0; };
if (git("rev-parse", "--git-dir").status !== 0) die(70, `${root} is not a git repository`);
const tags = git("tag", "--merged", "HEAD", "--list", "v*").stdout.split("\n").map((t) => t.trim()).filter((t) => SEMVER.test(t) && !SEMVER.exec(t)[4]);
tags.sort((a, b) => cmp(SEMVER.exec(b), SEMVER.exec(a)));
const last = tags[0] ?? null;
const RANK = { none: 0, patch: 1, minor: 2, major: 3 };
let computed = "none", conventional = 0, total = 0;
const log = git("log", "--no-merges", "--format=%s%x1f%b%x1e", ...(last ? [`${last}..HEAD`] : ["HEAD"]));
if (log.status !== 0 && last) die(70, "git log failed");
for (const c of (log.stdout ?? "").split("\x1e").map((x) => x.trim()).filter(Boolean)) {
  total++;
  const [subject, body = ""] = c.split("\x1f");
  const m = subject.match(/^(\w+)(?:\([^)]*\))?(!)?:\s/);
  let level = null;
  if (m) { conventional++; level = m[2] ? "major" : m[1] === "feat" ? "minor" : "patch"; }
  if (/^BREAKING[ -]CHANGE:/m.test(body)) { level = "major"; if (!m) conventional++; }
  if (level && RANK[level] > RANK[computed]) computed = level;
}
const forced = flag("bump");
if (forced && !["major", "minor", "patch"].includes(forced)) die(64, `bad --bump ${forced}`);
const lastV = last ? SEMVER.exec(last) : ["", "0", "0", "0"];
const unstable = Number(lastV[1]) === 0;
const bumpOf = (v) => (Number(v[1]) > Number(lastV[1]) ? "major" : Number(v[2]) > Number(lastV[2]) ? "minor" : Number(v[3]) > Number(lastV[3]) ? "patch" : "none");
const apply = (lvl) => {
  const [M, m, p] = [1, 2, 3].map((i) => Number(lastV[i]));
  if (lvl === "major" && !unstable) return `v${M + 1}.0.0`;
  if (lvl === "major" || lvl === "minor") return `v${M}.${m + 1}.0`;
  return `v${M}.${m}.${p + 1}`;
};
const need = forced ?? (computed === "none" ? null : unstable && computed === "major" ? "minor" : computed);

const list = (s) => (Array.isArray(s) ? s : String(s ?? "").split(",")).map((x) => x.trim()).filter((x) => x && !/^TODO\b/i.test(x));
const vfiles = list(flag("version-files") ?? P.version_files);
const declared = [];
for (const f of vfiles) {
  const p = resolve(root, f);
  if (!existsSync(p)) { gap(`version file ${f} does not exist`); continue; }
  const text = readFileSync(p, "utf8");
  let v;
  if (f.endsWith(".json")) { try { v = JSON.parse(text).version; } catch { /* not JSON */ } }
  v ??= (text.match(/^\s*(?:"?version"?|Version)\s*[:=]\s*["']?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/im) ?? [])[1];
  if (!v) gap(`no version found in ${f}`); else declared.push([f, `v${String(v).replace(/^v/, "")}`]);
}
const versions = [...new Set(declared.map(([, v]) => v))];
if (versions.length > 1) gap(`version files disagree: ${declared.map(([f, v]) => `${f} ${v}`).join(", ")}`);
const decl = versions.length === 1 ? versions[0] : null;
if (decl && !SEMVER.test(decl)) gap(`declared version ${decl} is not SemVer`);

const clog = flag("changelog") ?? (usable(P.changelog) ? P.changelog : null);
let section = null, clogVersion = null;
if (clog) {
  const p = resolve(root, clog);
  if (!existsSync(p)) gap(`changelog ${clog} does not exist`);
  else {
    const heads = [...readFileSync(p, "utf8").matchAll(/^## \[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)];
    if (!heads.length) gap(`changelog ${clog} has no ## X.Y.Z section`);
    else { clogVersion = `v${heads[0][1]}`; section = heads[0][2].trim(); }
  }
}

const next = decl ?? (need ? apply(need) : null);
if (last) console.log(`last: ${last}`); else console.log("last: none");
console.log(`commits: ${total}, conventional: ${conventional}, computed bump: ${computed}${unstable && computed === "major" ? " (minor while 0.y.z)" : ""}`);
if (!total) gap(`no commits since ${last}: nothing to release`);
if (vfiles.length && decl) {
  const nv = SEMVER.exec(decl);
  if (nv && last && cmp(nv, lastV) <= 0) gap(`version files declare ${decl}, not above ${last} (bump them in the change)`);
  else if (nv && need && !nv[4] && RANK[bumpOf(nv)] < RANK[need]) gap(`${decl} is a ${bumpOf(nv)} bump but the changes since ${last ?? "the start"} need ${need}`);
}
if (!vfiles.length) warns.push("no version files (profile version_files or --version-files): the version is computed only");
if (!conventional && !forced) warns.push(`no Conventional Commit types since ${last ?? "the start"}: bump not derived from the commits${decl ? `, ${decl} taken from the version files` : ""}`);
if (clog && clogVersion && next && clogVersion !== next) gap(`changelog top section is ${clogVersion}, the release is ${next}`);
if (next && git("rev-parse", "-q", "--verify", `refs/tags/${next}`).status === 0) gap(`tag ${next} already exists (never move a published tag; bump again)`);
if (next) console.log(`next: ${next}${SEMVER.exec(next)?.[4] ? " (pre-release: --prerelease, never --latest)" : ""}`);
else gap("cannot tell the next version: no version files, no Conventional Commits and no --bump");

const notes = flag("notes");
if (notes && next) {
  const url = git("remote", "get-url", "origin").stdout.trim().replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
  const link = /^https:\/\//.test(url) ? (last ? `**Full changelog**: ${url}/compare/${last}...${next}` : `**Full changelog**: ${url}/commits/${next}`) : null;
  if (!link) warns.push("origin is not an https or ssh URL: no compare link");
  if (!section) warns.push("no changelog section: notes hold only the compare link; add highlights and the issues closed");
  writeFileSync(resolve(notes), [section, link].filter(Boolean).join("\n\n") + "\n");
  console.log(`notes: ${notes}`);
}
finish();
