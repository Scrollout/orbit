<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo.svg" alt="Orbit logo: an operator at the centre of three peers" width="96">
</picture>

# Orbit

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
- `hooks/operator-context.sh`: the operator's SessionStart hook (self-test: `sh hooks/operator-context.test.sh`).
- `templates/`: `project.md`, `project.example.md`, `operator.md`, `handoff.md`, `principles.md`, `AGENTS.md`.

## Drift guard
Keeps skills and sessions from drifting. Zero dependencies (Node built-ins); `npm test` runs all of it (plus the hook self-test).
- **Rule ids.** `/decide` (`DEC-01..`) and the operator skill (`OPR-01..`) each start with a numbered rule list, every rule tagged `script` (an orbit script checks it), `hook` (a hook or git check can) or `judgment`. `rules/rules.json` registers them; a test checks each id appears exactly once in its core file and is not repeated in refs.
- **Size.** Core files stay short; `node scripts/check-size.mjs` fails a file over 10000 characters (about 2500 tokens) or 100 lines and lists the largest. Move detail to `refs/` files linked from the core with a "load when" line; rules stay in the core.
- **Profile block.** `templates/project.md` ends with a fenced ```` ```yaml orbit-profile ```` block (base branch, security globs, trailer, labels, tracker, who pushes the base, CI policy, optional production environment). `node scripts/profile.mjs --root .` prints `profile gap: <field>` for each missing or TODO field (exit 1); never guessed.
- **Triage.** `node scripts/decide-triage.mjs --root . --base <ref> --branch <ref> [--lines sec=..,door=..,prod=..] [--kind small|design|incident]`: a diff touching a security glob forces security yes; prints the track, per-role caps (`rules/tracks.json`, mirrors the /decide table) and the coder model. An unset line is a `triage gap` (exit 2).
- **Session ledger.** Append-only JSONL, one event per line: `ts`, `session`, `rule_version` (manifest versions of /decide and operator), `kind` and its fields: `triage{topic,sec,door,prod,track,files}`, `agent_start{role,model,topic,phase,fix_scope,cap_reason}`, `ci_run{sha,state}`, `review_start{branch,sha,ci_state}`, `merge_built{merge_sha,tree_equal,ci_state}`, `push{ref,chained}`, `issue_close{n,origin_base_sha,merge_sha}`. Write with `node scripts/ledger.mjs --ledger L --session S <kind> key=value key:=json`; replay with `node scripts/audit-ledger.mjs L --profile .agents/project.md` (violations by rule id, exit 1). The ledger is self-reported: it finds drift, it does not prove honesty.
- **Versions.** Each command and skill has `version:` in its frontmatter; `skills/MANIFEST.json` records the version and a content hash of the core plus its refs. `node scripts/manifest.mjs --check` fails on an edit without a version bump; `--update` rewrites the manifest (refuses an unbumped edit); `--print` lists the hashes.

## OKF docs
Optional docs automation for projects that keep docs as an [Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing) (OKF) v0.2 bundle (default `docs/okf`).
- `/orbit:okf-init` scaffolds the bundle (index, log, constitution, doc rules, a `roadmap/` folder with the milestones and the M1 plan, AGENTS.md/CLAUDE.md pointers, `.agents/okf.json`) and never overwrites.
- `node ~/orbit/scripts/validate-okf.mjs --root .` lints it (zero dependencies; settings from flags or `.agents/okf.json`; defaults: bundle `docs/okf`, 4000 chars per doc, AGENTS.md at most 80 lines, pointer files CLAUDE.md, GEMINI.md, .github/copilot-instructions.md, .cursor/rules/agents.mdc). Skill `okf` has the rules.
- `hooks/hooks.json` runs the validator after Write/Edit under the bundle (silent without node or a bundle). `templates/githooks/pre-commit` is a commit-time snippet.

## Agents sync
Instead of vendoring agent copies into `.claude/` (and keeping them in sync), install this plugin: the agents, command and skills load in every project. A project may still vendor its own copies in `.claude/agents`.

## License
[MIT](LICENSE)
