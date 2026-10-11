# Project profile: acme-shop (fictional example)

## Summary
Small web service (HTTP API + worker) for a fictional shop. Owner: the maintainer.

## Principles
.agents/principles.md

## Branches and merge rules
- Default branch: `main`. Base branch: `develop`. Never work on either.
- Merge into `develop` with `--no-ff` after merging `develop` into the topic branch and pushing it; green CI on that merge commit; then check `git rev-parse HEAD^{tree} <branch>^{tree}`. Push `develop` alone.
- After merge: remove the worktree, delete the branch locally and on the remote.

## Worktree convention
- Create: `git fetch && git worktree add ../acme-shop-<topic> -b <topic> origin/develop`; one per session, before any edit.
- Setup: `git config core.hooksPath .githooks`.

## Build and test entry points
- Full run: `make check`. Targeted: `make test-one PKG=./internal/cart/`.
- Generated, skipped by reviewers: `api/openapi.yaml`.

## CI
- GitHub Actions. CI is the only full run: coders run targeted checks, push, report without waiting.

## Review trailer
- `Reviewed-By: <who> - <pointer>` on the merge commit, in the same last paragraph as `Co-Authored-By`.
- Check: `git log -1 --format='%(trailers:key=Reviewed-By,valueonly)'`

## Issues
- Releases: each milestone merged into `main` is `v0.<milestone>.0`; the owning session tags and releases after the owner's go.
- GitHub issues via `gh`; the PM opens and closes them. Labels: `bug`, `test`, `review`, `enhancement` (at least one), plus `security`, `deferred`. Issue type: Bug for `bug`, `test`, `review`; Feature for `enhancement`; Task otherwise.
- `Fixes #n` only when a commit fully closes the issue, else `Refs #n`.

## Docs
- `docs/`, entry `docs/index.md`. Update docs in the same commit as the behaviour.

## OKF docs
- Bundle: none.

## Decision records
`docs/decisions/` (index `docs/decisions/index.md`).

## Security
- Sensitive paths: `internal/auth/`, `internal/payments/`, `migrations/`.
- Threat model: `docs/threat-model.md`.
- Production-like environment: `prod` (payments, destructive operations) needs a policy check and an audit record.

## Non-negotiable rules
- Never log or commit secrets. No hardcoded URLs or hosts; use config. Never bypass git hooks.
