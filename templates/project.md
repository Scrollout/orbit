# Project profile

Read by every role agent, `/decide` and the operator/peer skills. Keep it short; link to docs instead of copying them. Mark unknowns `TODO`, never guess.

## Summary
<!-- what the project is, stack, owner, one paragraph -->

## Principles
<!-- path to the principles doc (see templates/principles.md) -->

## Branches and merge rules
- Default branch: <main>. Base/integration branch: <name; topic branches merge here>. Never work on either directly.
- Merge into the base: `--no-ff` only, after merging the base into the topic branch and pushing it, green CI on that merge commit, then verify the merged tree equals the green tree (`git rev-parse HEAD^{tree} <branch>^{tree}`). Push the base alone, never chained after the merge.
- After merge: close issues, remove the worktree, delete the branch locally and on the remote.
- Other rules (merge gate, hooks, protected branches): <...>

## Worktree convention
<!-- one per session, created before any edit from the fresh base; work only inside it (peer skill: Start) -->
- Create: <e.g. `git fetch && git worktree add ../<repo>-<topic> -b <topic> origin/<base>`>
- Location and naming: <../<repo>-<topic>, branch <topic>>
- Setup in a new worktree (hooks, env, deps): <commands or none>

## Build and test entry points
- Full run: <command>
- Targeted single-package run: <command, with the variables it takes>
- Formatters/linters/docs check per touched area: <commands>
- Generated files and copies reviewers skip (review their sources): <paths>

## CI
- System: <GitHub Actions / ...>. Runs: <what>.
- Is CI the only full run? <yes/no>. If yes: coders run only the targeted checks, push, report without waiting; the PM/operator watches CI.
- Runner limits (shared host, one heavy run at a time): <...>

## Review trailer
- Format: `<Trailer-Key>: <who> - <pointer>` on the merge commit, or `none`.
- It must share the last paragraph with `Co-Authored-By` (no blank line between them), or git does not parse it as a trailer.
- Check: `git log -1 --format='%(trailers:key=<Trailer-Key>,valueonly)'`
- Who may waive it: <owner>

## Issues
- Tracker: <GitHub issues via `gh`, ...>. Who opens/closes: <PM opens, closes on merge into the base; agents never>.
- Label set: <type labels, extras>. Every issue gets at least one type label.
- Issue types: <tracker types and their mapping, e.g. GitHub Bug for defects, Feature for new capabilities, Task otherwise; or "none">. Every issue gets one when the tracker has them.
- Milestones: <tracker milestones matching the roadmap, or "none">. Every issue gets the milestone it is targeted at; moving it later is a carry, with a comment. The milestone closes when its release is published.
- What gets an issue: every review finding, red run, carried or deferred item.
- Commit wording: `Fixes #n` only when the commit fully closes the issue, else `Refs #n` (closing keywords fire when the branch reaches the default branch).

## Releases
- When: <each milestone merged into the default branch / each change set / never>.
- Version: SemVer `vMAJOR.MINOR.PATCH` (0.y.z while unstable; MINOR for features, PATCH for fixes and docs). Version files to bump: <path or none>.
- Who: <the owning session, after the owner's go>.

## Docs
- Location and entry point: <path>. Format rules: <path or summary>.
- Rule: update docs in the same commit as the behaviour.

## OKF docs (optional)
- Bundle: <docs/okf, or `none`>. Config: `.agents/okf.json` (bundle, maxDocChars, maxAgentsLines, agentsFile, pointerFiles, maxPointerLines), or defaults.
- Check: `node <orbit>/scripts/validate-okf.mjs --root .` (also run by the plugin hook after edits, and optionally by `.githooks/pre-commit`). Skill: `okf`; scaffold: `/orbit:okf-init`.
- Project additions to the doc rules: <...>

## Decision records
- Location and index: <path>. Format: <...>.

## Security
- Security-sensitive paths: <path to list, or globs>.
- Threat model: <path>.
- Production-like environment(s) and what needs a policy check plus audit record: <...>, or `none`.
- Extra one-way doors beyond data, migrations, API contract, security boundary, money/destructive operations: <...>

## Non-negotiable rules
<!-- secrets, hardcoded values, hooks, entry points, ... -->
