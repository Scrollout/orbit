<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo.svg" alt="Orbit logo: an operator at the centre of three peers" width="96">
</picture>

# Orbit

Version: 0.12.1 (see [CHANGELOG](CHANGELOG.md)).

## Why Orbit
Orbit gives one person working with Claude Code the habits of a small, careful software team.
- **A team, not a single assistant**: an explorer, a designer, a tech lead, a security officer, a coder and two reviewers each do one job, so every change is thought through, built, then checked by someone fresh.
- **Decisions made the way good teams make them**: `/decide` sizes the process to the question. A small fix just gets done; anything touching security or hard-to-undo choices gets proposals, a security review and a sign-off, with a written record of why.
- **Parallel work without session upkeep**: one operator coordinates and never edits; every chore runs in a fresh worker subagent on its own branch (or in a peer session you can watch), work stays in flight, the operator resumes on its own after a compaction or restart, and nothing reaches the shared branch without passing its checks.
- **Lower cost**: cheaper models do the reading and routine building, and the strongest models are kept for judgment. Sessions message each other only when a decision is needed.
- **Docs that stay small and current**: optional checks keep project docs short, indexed and updated alongside the code.
- **Works in any project**: everything specific to a project lives in one profile file.

## Contents in brief
Personal Claude Code plugin: seven role agents (`explorer`, `designer`, `architect`, `security`, `coder`, `reviewer`, `re-reviewer`), an `operator` main-session agent, the `/decide` PM command, and two skills for coordinating parallel work (`operator`, `peer`). Projects may opt in to pull requests per topic branch (`Pull requests: yes` in the profile); the merge stays a verified local `--no-ff` merge. A fresh worker starts every task; a worker is resumed only for its own open branch (profile `Worker reuse: fresh-per-task`, default; `resume-ok` opts out). Everything project-specific lives in a per-project profile.

## Install
Clone it once (the templates used in "Adopt in a project" come from the clone):
```
git clone https://github.com/Scrollout/orbit.git ~/orbit
```
Then, in Claude Code:
```
/plugin marketplace add ~/orbit
/plugin install orbit@scrollout
```
Agents appear as `orbit:<name>`, the command as `/orbit:decide`.

**Update** to a new [release](https://github.com/Scrollout/orbit/releases):
```
git -C ~/orbit pull
```
then `/plugin marketplace update scrollout` and `/plugin update orbit@scrollout` in Claude Code, then `/reload-plugins` in each running session (or restart it; a running session keeps the definitions it loaded).

## Adopt in a project
1. `mkdir -p .agents && cp ~/orbit/templates/project.md .agents/project.md` and fill it in (TODO for unknowns). See `templates/project.example.md` for a filled one.
2. Optionally `cp templates/principles.md .agents/principles.md` and `templates/AGENTS.md ./AGENTS.md`.
3. Point `CLAUDE.md` or `AGENTS.md` at it: `@.agents/project.md` and `@.agents/principles.md` (Claude Code imports with `@` lines). If the profile lives elsewhere, state its path there; agents read `.agents/project.md` or that path first.
4. To run the main checkout's session as the operator: `cp ~/orbit/templates/operator.md .agents/operator.md` and `echo .agents/operator.md >> .git/info/exclude` (it stays untracked). Its SessionStart hook then hands that file (only while untracked and git-ignored, capped at 8000 bytes, git 2.31+; silent on older git) to the main checkout's session at startup, resume, clear and compaction, so the operator resumes without being told; sibling worktrees get nothing. Or start it directly as the operator with `claude --agent orbit:operator`.

## Contents
- `agents/`, `commands/decide.md`: the team and its process; models: architect and security on fable, reviewer and re-reviewer on opus, the rest on sonnet.
- `skills/operator`, `skills/peer`: coordinating per-task worker subagents or peer sessions (push queue, merge protocol, auto-compaction, no manual `/clear` or `/compact`).
- `refs/decide/`, `skills/operator/refs/`: detail (tables, templates, per-step procedures) split out of the two long files; each core file keeps the numbered rules and the flow and says when to load each ref.
- `scripts/`, `rules/`, `skills/MANIFEST.json`: the drift guard (see Drift guard below).
- `hooks/operator-context.sh`: the operator's SessionStart hook (self-test: `sh hooks/operator-context.test.sh`).
- `templates/`: `project.md`, `project.example.md`, `operator.md`, `handoff.md`, `principles.md`, `AGENTS.md`.

## Drift guard
Keeps the skills and the sessions from drifting. Zero dependencies (Node built-ins, Node 20+); `npm test` runs every test and check below plus the hook self-test. Commands and skills call the scripts as `node "${CLAUDE_PLUGIN_ROOT}/scripts/<name>.mjs"` (scripts are plugin files, so always the plugin root; a skill's own refs use `${CLAUDE_SKILL_DIR}`); from a shell, run `node <orbit clone>/scripts/<name>.mjs`. Known limit: that variable expansion follows the official Claude Code docs but has not been verified live here.

### Layout and rules
- **Rule ids.** `/decide` (`DEC-01..`) and the `operator` skill (`OPR-01..`) each carry a numbered rule list, every rule tagged `script` (an orbit script checks it), `hook` (a hook or git check can enforce it; not built yet) or `judgment`. The prose and the refs explain the rules; the ids are stable. `rules/rules.json` registers them; a test checks each id appears once in its core and nowhere in a ref.
- **Core plus refs.** A file over 10000 characters (about 2500 tokens) or 100 lines is split: the core keeps the rules and the flow, `refs/decide/` and `skills/operator/refs/` hold detail, loaded when the core's "load when" line says so. Pointers use `${CLAUDE_PLUGIN_ROOT}` (commands) and `${CLAUDE_SKILL_DIR}` (skills), which Claude Code substitutes; a test resolves every one. `node scripts/check-size.mjs` fails over the threshold and lists the largest files.
- **Versions.** Each command and skill has `version:` in its frontmatter. `skills/MANIFEST.json` records version and a content hash for each core plus its refs, and one shared entry for `rules/*.json` and the scripts (versioned by `version` in `rules/rules.json`). `node scripts/manifest.mjs --check` fails on an edit without a version bump; after bumping, `--update` rewrites the manifest (it refuses an unbumped edit); `--print` lists hashes. Claude Code ignores unknown frontmatter keys. On other surfaces (claude.ai upload, the Skills API) unknown keys may be rejected: there the manifest is the source of truth, and the `version:` line can be stripped.
- **Docs.** `node scripts/check-docs.mjs` checks that plugin.json, the CHANGELOG and the `Version:` line above agree and that links and referenced paths resolve.

### Project profile block
`templates/project.md` ends with a fenced code block whose info string is `yaml orbit-profile`: `base_branch`, `security_paths` (globs anchored at the repo root: `*`, `**`, `**/Makefile` for any depth, a trailing `/` for a directory; no braces), `review_trailer`, `labels`, `issue_tracker`, `base_pusher` (`agent` or `owner`), `ci_policy` (`ci-only` or `local-full`) and optional `production_env`, optional `standing_waivers` (review-waived classes such as `docs-only`; `merge_built.waived` must cite one or be `owner` with a reason) and optional `ledger_path` (default `.agents/ledger.jsonl`, untracked).
- `node scripts/profile.mjs --root .` prints `profile gap: <field>` for each missing, empty, TODO, wrongly typed or out-of-enum field (exit 1), warns on duplicate keys, and never guesses. `--json` prints the parsed block.

### Triage and track
- `node scripts/decide-triage.mjs --root . --base <ref> --branch <ref> [--lines sec=yes|no,door=yes|no,prod=yes|no] [--kind small|design|incident]`
- It lists `git diff --no-renames --name-only <base>...<branch>` (three dots: the branch's own changes; both paths of a rename), forces security yes when a path matches a profile glob, and prints the track, the per-role caps (`rules/tracks.json`, checked against the Track table) and the coder model (opus if any line is yes or the kind is incident). `--files a,b` triages planned paths before a branch exists. A line left unset is a `triage gap` (exit 2), even when a security glob forces security yes (the one-way-door question is separate); exit 64 is bad usage (an option-like ref is refused), 70 a git failure; `production_env: TODO` needs `prod=` on every run; an unfilled profile reports `profile gap`.

### Session ledger and audit
- Append events: `node scripts/ledger.mjs --ledger L.jsonl --session S <kind> key=value key:=<json> ...` (adds `ts` and `rule_version`). Replay: `node scripts/audit-ledger.mjs L.jsonl --profile .agents/project.md` prints violations by rule id (exit 1; also for an empty ledger or a profile gap).
- One JSON object per line; common fields `ts` (ISO 8601 with offset, non-decreasing per session), `session`, `rule_version`, `kind`. `topic` must equal the branch name: fix-round and re-review tracking join `triage`, `agent_start` and `review_start` on it, and the audit prints a non-fatal `warn:` line for a `review_start` whose branch has no `triage` topic.

| kind | fields |
|---|---|
| `triage` | `topic`, `sec`, `door`, `prod`, `track`, `files` (changed paths) |
| `agent_start` | `role`, `model`, `topic`; `resumed` (a resumed worker keeps its model), `worker` (an id for the worker session: a later coder event with the same id and another model is a violation even without `resumed`; a fresh coder gets a new id), `reason` (`ci-failed-twice` needs opus); `phase` (`design`, `build`, `fix`, `delivery`; a reviewer defaults to `delivery` once a `ci_run` with that `branch` exists); `fix_scope` (`tests-docs` or `code`); `cap_reason`, or `outside_cap` (excludes the call from the caps; needs a `cap_reason`) |
| `ci_run` | `branch` (= topic; a run without it counts for no topic's phase default), `sha`, `workflow` (default `default`), `state` (`green`, `red`, `pending`) or `conclusion` (`success`, `failure`, ...); the latest run per workflow counts |
| `review_start` | `branch`, `sha`, `ci_state`, `role` (`reviewer` or `re-reviewer`) |
| `merge_built` | `branch` (required), `merge_sha`, `tree_equal`, `ci_state` (of the catch-up merge), `waived` (a `standing_waivers` class of the profile, or `owner` with `waiver_reason`) |
| `push` | `ref` (`main`, `HEAD:main`, `origin/main`, `refs/heads/main` all mean the base), `sha`, `chained`, `by` (`agent` or `owner`) |
| `issue_close` | `n`, `origin_base_sha`, `merge_sha` |

The audit covers the `script` rules: reviews only on green CI of every recorded workflow and never on a red one, no second review of a sha without a fix, one re-reviewer per fix round on a new sha, security glob matches sticky, caps (delivery reviewers excluded), coder and reviewer models, merge only for a reviewed branch (or an owner waiver) with tree equality and green catch-up CI, base push alone, by the profile's pusher and only for a built merge, issue close after that push with `origin/<base>` equal to the merge sha. The ledger is self-reported: it finds drift, it does not prove honesty.

### Next steps (not built yet)
- Hooks: block repo writes and `git commit|merge|push` in the operator session (OPR-01); check the trailer paragraph on the merge commit (DEC-08).
- Golden scenarios: scripted ledgers and briefs with expected tracks and violations, run in `npm test`, so a skill edit that changes behaviour fails.
- Cross-project diff: compare two profile blocks and flag the fields that differ.
- Decision-record lint: parse the decision-record table for columns, verdict words and the three triage lines.
- Condition ledger: `condition` events so every security condition has a proof test before the merge.
- Ledger auto-capture: hooks append `agent_start` and `push` events so the ledger does not depend on the operator remembering.

## OKF docs
Optional docs automation for projects that keep docs as an [Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing) (OKF) v0.2 bundle (default `docs/okf`).
- `/orbit:okf-init` scaffolds the bundle (index, log, constitution, doc rules, a `roadmap/` folder with the milestones and the M1 plan, AGENTS.md/CLAUDE.md pointers, `.agents/okf.json`) and never overwrites.
- `node ~/orbit/scripts/validate-okf.mjs --root .` lints it (zero dependencies; settings from flags or `.agents/okf.json`; defaults: bundle `docs/okf`, 4000 chars per doc, AGENTS.md at most 80 lines, pointer files CLAUDE.md, GEMINI.md, .github/copilot-instructions.md, .cursor/rules/agents.mdc). Skill `okf` has the rules.
- `hooks/hooks.json` runs the validator after Write/Edit under the bundle (silent without node or a bundle). `templates/githooks/pre-commit` is a commit-time snippet.

## Agents sync
Instead of vendoring agent copies into `.claude/` (and keeping them in sync), install this plugin: the agents, command and skills load in every project. A project may still vendor its own copies in `.claude/agents`.

## License
[MIT](LICENSE)
