# Project profile

Fixture: an anonymised, realistic profile (prose trimmed). Read by every role agent, `/decide` and the operator and peer skills.

## Summary
A multi-tenant platform for brokers. Stack: Go, TypeScript, Python. Repo: `acme/platform` on GitHub. Owner: TODO.

## Branches and merge rules
- Default branch: `main`. Base/integration branch: `main`; topic branches merge here. Never work on `main` directly.
- Merge into the base: `--no-ff` only, after merging the base into the topic branch and pushing it, green CI on that merge commit, then verify the merged tree equals the green tree (`git rev-parse HEAD^{tree} <branch>^{tree}`). Push the base alone, never chained after the merge.
- Other rules (merge gate, hooks, protected branches): TODO.

## Worktree convention
- Create: `git fetch && git worktree add ../platform-<topic> -b <topic> origin/main`

## CI
- System: GitHub Actions on hosted runners. Every step calls a make target (`make help`).
- Is CI the only full run? Yes: coders run only the targeted checks, push, report without waiting; the operator watches CI.

## Review trailer
- Format: `Reviewed-by: <reviewer> - <pointer>` on the merge commit, in the same last paragraph as `Co-Authored-By`.
- Who may waive it: the owner.

## Issues
- Tracker: GitHub issues via `gh`. Who opens/closes: the operator.
- Label set: `bug`, `feature`, `chore`, `docs`, `ci`, `research`, `security`, `decision`.

## Security
- Security-sensitive paths: see the machine profile below.
- Production-like environment(s): none yet.

## Machine profile
```yaml orbit-profile
base_branch: main
security_paths:
  - .gitleaks.toml
  - .gitignore
  - .github/workflows/
  - scripts/check-*
  - scripts/test-*
  - scripts/e2e-*.sh
  - scripts/summary.sh
  - Makefile
  - ci/images.mk
  - .agents/project.md
  - .agents/naming.json
  - docs/okf/decisions/
  - docs/okf/architecture/resource-model/
  - docs/okf/security/
  - .github/dependabot.yml
  - SECURITY.md
  - .github/CODEOWNERS
  - scripts/vuln-switch.sh
  - ci/**
review_trailer: Reviewed-by
labels: [bug, feature, chore, docs, ci, research, security, decision]
issue_tracker: github
base_pusher: owner
production_env: none
ci_policy: ci-only
```
