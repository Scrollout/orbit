# Changelog

## 0.11.0
- Fresh worker per task: the operator starts a new worker for every task and resumes one only to finish its own open branch (fix round, catch-up, merge build, cleanup, review findings), because a resumed worker re-reads its whole context each message and its cost grows. Delivered workers are retired. The profile's `Worker reuse: fresh-per-task / resume-ok` field (default `fresh-per-task`) controls it; `resume-ok` restores the old behaviour.

## 0.10.0
- Optional pull requests per project: the profile's `Pull requests: yes` makes the coder open a PR after the push, reviewers start on a PR only after CI is green on its head SHA, the operator posts each review summary as a PR comment and uses its id in the review trailer. Default and fallback is the issue-comment flow (`no`); the merge is the verified local `--no-ff` merge in both modes, never the GitHub merge button.
- Profile templates carry the new `Pull requests` field.
