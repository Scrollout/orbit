# Pull requests

Detail of the `operator` skill (`skills/operator/SKILL.md`); the numbered rules live there. Load when the profile says `Pull requests: yes`, or before the first task to check PR readiness.

## Pull requests (optional)
Per the profile's `Pull requests:` field (`no` when absent). Both modes keep every other rule: CI green on the head SHA before any reviewer, the verified local `--no-ff` merge, the trailer.

| | `no` (default and fallback) | `yes` |
|---|---|---|
| Opened | no PR | by the worker after the push: `gh pr create --base <base> --head <branch>`, body from the profile's PR template, `Refs #n`, body file outside the worktree |
| Reviewer starts | all triggered runs green on the head SHA | the same; the prompt names the PR, the head SHA and the green run ids |
| Review record | the operator posts each summary as an issue comment | the operator posts each summary as a PR comment (reviewers are read-only) |
| Trailer pointer | `comment <id> on issue #n` | `comment <id> on PR #n` |
| Merge | local merge, pushed per the profile | the same, pushed by the operator so GitHub marks the PR merged; never the merge button or `gh pr merge` (it skips the tree check and the trailer) |

- Check once, before the first task: the profile says `yes`, `gh auth status` works and `origin` is a GitHub remote. If a PR cannot be opened (`gh pr create` denied or failing, no GitHub remote), use `no` for that task and tell the owner once; never block.
- Branch protection is optional and the profile says whether it exists; the convention is the control. `gh pr create` may need a permission allow rule, which only the owner adds.
