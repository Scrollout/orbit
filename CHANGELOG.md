# Changelog

## 0.12.1
- Fix round for the drift guard: ref pointers use `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SKILL_DIR}` (tested); rules restored to the prose and extended (DEC-10, DEC-12 to DEC-20; OPR-02, OPR-03, OPR-07 reworded); triage uses the three-dot diff with renames, reports profile gaps and rejects a bad `--kind`; the profile parser reports a scalar where a list is expected and warns on duplicate keys; the audit checks per-workflow CI, review and fix-round order, sha links between merge, base push and issue close, ts, the pusher and model rules; the manifest also hashes the rules, tracks and scripts; `scripts/check-docs.mjs` checks version and link consistency. The delivery-reviewer default is per topic (`ci_run` carries `branch`), and the audit warns on a review branch with no triage topic.

## 0.12.0
- Drift guard: numbered rule ids (`DEC-xx` in /decide, `OPR-xx` in the operator skill) tagged `script`, `hook` or `judgment`; a machine-readable `orbit-profile` block in the profile and `scripts/profile.mjs` (reports `profile gap: <field>`); `scripts/decide-triage.mjs` (security globs force the yes line, prints track, caps, coder model); an append-only session ledger with `scripts/ledger.mjs` and `scripts/audit-ledger.mjs`; skill versions and `skills/MANIFEST.json` with `scripts/manifest.mjs --check`; `npm test` runs all tests.
- Long files split: `commands/decide.md` and `skills/operator/SKILL.md` are now a short core (rules and flow) plus `refs/` files loaded when needed; wording moved verbatim, behaviour unchanged. `scripts/check-size.mjs` fails a file over 10000 characters or 100 lines.

## 0.11.0
- Fresh worker per task: the operator starts a new worker for every task and resumes one only to finish its own open branch (fix round, catch-up, merge build, cleanup, review findings), because a resumed worker re-reads its whole context each message and its cost grows. Delivered workers are retired. The profile's `Worker reuse: fresh-per-task / resume-ok` field (default `fresh-per-task`) controls it; `resume-ok` restores the old behaviour.

## 0.10.0
- Optional pull requests per project: the profile's `Pull requests: yes` makes the coder open a PR after the push, reviewers start on a PR only after CI is green on its head SHA, the operator posts each review summary as a PR comment and uses its id in the review trailer. Default and fallback is the issue-comment flow (`no`); the merge is the verified local `--no-ff` merge in both modes, never the GitHub merge button.
- Profile templates carry the new `Pull requests` field.
