<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img src="assets/logo.svg" alt="Orbit logo: an operator at the centre of three peers" width="96">
</picture>

# Orbit

## Why Orbit
Orbit gives one person working with Claude Code the habits of a small, careful software team.
- **A team, not a single assistant**: an explorer, a designer, a tech lead, a security officer, a coder and two reviewers each do one job, so every change is thought through, built, then checked by someone fresh.
- **Decisions made the way good teams make them**: `/decide` sizes the process to the question. A small fix just gets done; anything touching security or hard-to-undo choices gets proposals, a security review and a sign-off, with a written record of why.
- **Parallel work without session upkeep**: one operator coordinates; each build step runs in a fresh worker subagent on its own branch (or in a peer session you can watch), sessions compact on their own, and nothing reaches the shared branch without passing its checks.
- **Lower cost**: cheaper models do the reading and routine building, and the strongest models are kept for judgment. Sessions message each other only when a decision is needed.
- **Docs that stay small and current**: optional checks keep project docs short, indexed and updated alongside the code.
- **Works in any project**: everything specific to a project lives in one profile file.

## Contents in brief
Personal Claude Code plugin: seven role agents (`explorer`, `designer`, `architect`, `security`, `coder`, `reviewer`, `re-reviewer`), the `/decide` PM command, and two skills for coordinating parallel work (`operator`, `peer`). Everything project-specific lives in a per-project profile.

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

## Contents
- `agents/`, `commands/decide.md`: the team and its process; models: architect and security on fable, reviewer and re-reviewer on opus, the rest on sonnet.
- `skills/operator`, `skills/peer`: coordinating per-task worker subagents or peer sessions (push queue, merge protocol, auto-compaction, no manual `/clear` or `/compact`).
- `templates/`: `project.md`, `project.example.md`, `handoff.md`, `principles.md`, `AGENTS.md`.

## OKF docs
Optional docs automation for projects that keep docs as an [Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing) (OKF) v0.2 bundle (default `docs/okf`).
- `/orbit:okf-init` scaffolds the bundle (index, log, constitution, doc rules, a `roadmap/` folder with the milestones and the M1 plan, AGENTS.md/CLAUDE.md pointers, `.agents/okf.json`) and never overwrites.
- `node ~/orbit/scripts/validate-okf.mjs --root .` lints it (zero dependencies; settings from flags or `.agents/okf.json`; defaults: bundle `docs/okf`, 4000 chars per doc, AGENTS.md at most 80 lines, pointer files CLAUDE.md, GEMINI.md, .github/copilot-instructions.md, .cursor/rules/agents.mdc). Skill `okf` has the rules.
- `hooks/hooks.json` runs the validator after Write/Edit under the bundle (silent without node or a bundle). `templates/githooks/pre-commit` is a commit-time snippet.

## Agents sync
Instead of vendoring agent copies into `.claude/` (and keeping them in sync), install this plugin: the agents, command and skills load in every project. A project may still vendor its own copies in `.claude/agents`.

## License
[MIT](LICENSE)
