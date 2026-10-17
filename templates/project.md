# Project profile

Read by every role agent, `/decide` and the operator/peer skills. Keep it short; link to docs instead of copying them. Mark unknowns `TODO`, never guess.

## Summary
<!-- what the project is, stack, owner, one paragraph -->

## Principles
<!-- path to the principles doc (see templates/principles.md) -->

## Branches and merge rules
- Default branch: <main>. Base/integration branch: <name; topic branches merge here>. Never work on either directly.
- Merge into the base: `--no-ff` only, after merging the base into the topic branch and pushing it, green CI on that merge commit, then verify the merged tree equals the green tree (`git rev-parse HEAD^{tree} <branch>^{tree}`). Push the base alone, never chained after the merge.
- Merge build: a worker, in a fresh detached worktree from `origin/<base>` (e.g. `git worktree add --detach ../<repo>-merge-<topic> origin/<base>`).
- Who pushes the base: <agent / owner>. `owner`: the operator hands the owner `! git -C <merge worktree> push origin HEAD:<base>`.
- After merge, once `origin/<base>` equals the merge SHA: close issues; a worker removes the worktrees and deletes the branch locally and on the remote.
- Pull requests: <no / yes>. `yes`: the coder opens a PR after the push (PR template: <path>), reviews are recorded as PR comments, the merge stays the local `--no-ff` merge (orbit `operator` skill, Pull requests). Branch protection: <none / ...>.
- Other rules (merge gate, hooks, protected branches): <...>

## Worktree convention
<!-- one per session, created before any edit from the fresh base; work only inside it (peer skill: Start) -->
- Create: <e.g. `git fetch && git worktree add ../<repo>-<topic> -b <topic> origin/<base>`>
- Location and naming: <../<repo>-<topic>, branch <topic>>
- Setup in a new worktree (hooks, env, deps): <commands or none>

## Build and test entry points
- Full run: <command>
- Targeted single-package run: <command, with the variables it takes>. It is the targeted-test command: with `tdd: yes` the coder shows each proof test failing, then passing with it, and reviewers run one proof test with it (DEC-21, DEC-22). Machine field `targeted_test`; with `tdd: yes` it is required (a profile gap otherwise).
- TDD evidence (`tdd`): <no (default) / yes / auto>. `auto`: `decide-triage.mjs` decides per step with `scripts/tdd-suggest.mjs` (a targeted-test command, tests present, production code touched and a proof test named, or a security path or one-way door: yes; docs or config only, or unclear: no). `yes`: the coder shows each proof test failing, then passing, and reviewers check it fails without the change (DEC-21, DEC-22); `no`: proof tests are named and run as before.
- Failing test committed before the fix (`test_first_commit`, only with `tdd: yes`): <no (default) / yes>.
- Formatters/linters/docs check per touched area: <commands>
- Generated files and copies reviewers skip (review their sources): <paths>

## CI
- System: <GitHub Actions / ...>. Runs: <what>.
- Is CI the only full run? <yes/no>. If yes: coders run only the targeted checks, push, report without waiting; the PM/operator watches CI.
- Runner limits (shared host, one heavy run at a time): <...>
- Heavy runner class: <runner label, or the workflows that count as heavy>.
- Path filters: <workflow - the paths that trigger it, or "all paths">. A GO lists the workflows a diff triggers; green means all of them green.

## Operator
- Max parallel workers: <n>.
- Worker reuse: <fresh-per-task (default when absent) / resume-ok>. `fresh-per-task`: every new task gets a new worker; a worker is resumed only to finish its own open branch (orbit `operator` skill, Workers).
- Escalate to the owner (the operator decides the rest or runs `/decide`): <e.g. security blocks, money, legal, settings, production or live actions>.
- Standing worker brief lines, appended to every worker brief: <e.g. never `git stash` (shared across worktrees); no session names in commit trailers; run <check> after committing>.
- Handoff: `.agents/operator.md` in the main checkout (template `templates/operator.md` of the plugin), untracked.

## Review trailer
- Format: `<Trailer-Key>: <who> - <pointer>` on the merge commit, or `none`.
- It must share the last paragraph with `Co-Authored-By` (no blank line between them), or git does not parse it as a trailer.
- Check: `git log -1 --format='%(trailers:key=<Trailer-Key>,valueonly)'`
- `<pointer>` is the id of the operator's review comment on the issue, or on the PR when `Pull requests: yes`.
- `<who>` names the reviewer that ran (agent and model, e.g. `reviewer (opus)`), never a session name. No review only with the waiver: `<waiver holder> waived - <reason>`.
- Who may waive it: <owner>

## Issues
- Tracker: <GitHub issues via `gh`, ...>. Who opens/closes: <PM opens, closes on merge into the base; agents never>.
- Label set: <type labels, extras>. Every issue gets at least one type label.
- Issue types: <tracker types and their mapping, e.g. GitHub Bug for defects, Feature for new capabilities, Task otherwise; or "none">. Every issue gets one when the tracker has them.
- Milestones: <tracker milestones matching the roadmap, or "none">. Every issue gets the milestone it is targeted at; moving it later is a carry, with a comment. The milestone closes when its release is published.
- What gets an issue: every review finding, red run, carried or deferred item.
- Commit wording: `Fixes #n` only when the commit fully closes the issue, else `Refs #n` (closing keywords fire when the branch reaches the default branch).

## Releases
Machine fields `release_when`, `release_via`, `release_tool`, `changelog`, `version_files` (operator rule OPR-09; `release_when` sets the cadence, not a standing go: the guard prompts the owner on the tag push and the release).
- When (`release_when`): `change-set` (every merge to the base, released before the next is pushed), `milestone` (when a tracker milestone closes) or `never`.
- How (`release_via`): `ci` (a tag-triggered workflow builds, attests and publishes; start from the plugin's `templates/release.yml`) or `session` (`gh release create --verify-tag` from a worker). Release tool (`release_tool`): `none`, or the tool that owns versions and notes (`release-please`, `changesets`, `semantic-release`, `goreleaser`, `other`).
- Version: SemVer `vMAJOR.MINOR.PATCH` (0.y.z while unstable: breaking or feature MINOR, fix and docs PATCH), bumped in the change itself. Version files (`version_files`): <paths, or []>. Changelog (`changelog`): <path, Keep a Changelog sections>.
- Guard rails (checked by `release-check.mjs --repo`): required checks on the base, a tag ruleset on `v*` (no update or delete), immutable releases, signed tags.

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

## Machine profile
Read by `scripts/profile.mjs` (reports `profile gap: <field>` for a missing or TODO field) and the triage and audit scripts. Keep it equal to the prose above. Fields: `base_branch`; `security_paths` (globs anchored at the repo root: `*` within a directory, `**` across directories, `**/Makefile` for a file at any depth, a trailing `/` or a plain directory name covers everything below it; no leading slash, no braces; matched against `git diff --name-only <base>...<branch>`, renames count both paths); `review_trailer` (key, or `none`); `labels`; `issue_tracker`; `base_pusher` (`agent` or `owner`; the legacy `operator` reads as `agent` with a warning); `ci_policy` (`ci-only` or `local-full`); optional `production_env` (`none` or a name; `TODO` is allowed but then `decide-triage.mjs` needs `prod=` on every run), optional `standing_waivers` (classes of change the owner waived review for, e.g. `docs-only`; `merge_built.waived` must cite one), optional `ledger_path` (default `.agents/ledger.jsonl`; keep it untracked, e.g. in `.git/info/exclude`), optional `protected_branches` (more branches the guard treats as protected, a trailing `*` matches a prefix; it only adds to the fixed floor `main`, `master`, `release/*`, the target of `origin/HEAD` and `base_branch`, and never loosens it), optional `tdd` (`no` default, `yes`: DEC-21 and DEC-22 apply, or `auto`: decided per step at triage by `tdd-suggest.mjs`; `decide-triage.mjs` prints it for the triage event; an invalid value is a profile gap), `targeted_test` (the targeted-test command, required with `tdd: yes` or `auto`), optional `test_first_commit` (`no` default, or `yes` with `tdd: yes`: the coder commits the failing test alone before the fix, DEC-21; `profile.mjs` warns when it is yes without `tdd: yes`).
```yaml orbit-profile
base_branch: TODO
security_paths: [TODO]
review_trailer: TODO
labels: [TODO]
issue_tracker: TODO
base_pusher: TODO
ci_policy: TODO
production_env: TODO
standing_waivers: []
ledger_path: .agents/ledger.jsonl
protected_branches: []
release_when: TODO
release_via: TODO
release_tool: none
changelog: CHANGELOG.md
version_files: []
tdd: no
test_first_commit: no
```

## Non-negotiable rules
<!-- secrets, hardcoded values, hooks, entry points, ... -->
