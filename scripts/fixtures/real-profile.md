# Project profile

Read by every role agent, `/decide` and the operator/peer skills. Keep it short; link to docs instead of copying them. Mark unknowns `TODO`, never guess.

## Summary
A multi-tenant platform for brokers (trading first; insurance and real estate later), regions EU, UK, US. Docs and code say "the platform", never the project name ([neutral naming](../docs/okf/conventions/neutral-naming.md)). Repo: GitHub `Scrollout/portfolio-manager` (private). Stack: Go (control plane, gateways, controllers), TypeScript/React (UI), Python (strategies, analytics). Owner: TODO.

## Principles
[docs/okf/constitution/principles.md](../docs/okf/constitution/principles.md)

## Branches and merge rules
- Default branch: `main`. Base/integration branch: `main`; topic branches merge here. Never work on `main` directly (the bootstrap commit was the only exception).
- Merge into the base: `--no-ff` only, after merging the base into the topic branch and pushing it, green CI on that merge commit, then verify the merged tree equals the green tree (`git rev-parse HEAD^{tree} <branch>^{tree}`). Push the base alone, never chained after the merge.
- After merge: close issues, remove the worktree, delete the branch locally and on the remote.
- Other rules (merge gate, hooks, protected branches): TODO.

## Worktree convention
- Create: `git fetch && git worktree add ../portfolio-manager-<topic> -b <topic> origin/main`
- Location and naming: `../portfolio-manager-<topic>`, branch `<topic>`.
- Setup in a new worktree (hooks, env, deps): TODO.

## Build and test entry points
- Full run: TODO (no code yet).
- Targeted single-package run: TODO.
- Entry point: `make help` lists every target; `make ci-checks` and `make ci-ui` run the CI steps locally ([make](../docs/okf/conventions/make.md)).
- Formatters/linters/docs check per touched area: docs: `node /home/marius/orbit/scripts/validate-okf.mjs --root .`; naming: `make naming` (config `.agents/naming.json`); code: TODO.
- API contract: `api/control-plane.openapi.yaml` (OpenAPI 3.1, lint config `api/redocly.yaml`; [OpenAPI contract](../docs/okf/architecture/resource-model/openapi.md)).
- Generated files and copies reviewers skip: `docs/diagrams/c4-views.md` (from `workspace.dsl` by `make c4-render`; CI fails if stale); others TODO.

## CI
- System: GitHub Actions. Checks run on GitHub-hosted runners (`runs-on: ubuntu-24.04`). Lab-bound jobs (integration on k3s, image builds) use the lab runner scale set `platform-lab` in k3s-ci, `runs-on: platform-lab` (1-2 runners, this repository only, observed 2026-10-10T09:02:49Z; see [lab](../docs/okf/architecture/lab-gitops.md)).
- Every step calls a make target (`make help`); any new command a person or CI runs gets a make target first. Images are pinned in `ci/images.mk` (Playwright: `web/e2e-image.txt`), not in workflows; the one exception until the sandbox follow-up is `GO_IMAGE` in `sandbox.yml`.
- Agents writing `\uXXXX` escapes through the Write or Edit tools can silently store the raw character; `make bidi` is the guard. In tests, build such characters with `String.fromCodePoint`.
- Every job ends with an `if: always()` step that appends `make -s summary` to `$GITHUB_STEP_SUMMARY` (rows per target: pass/fail, counts, seconds; never secret, canary or output text); `make workflow-summary` enforces it.
- Runs: `.github/workflows/checks.yml`, one job per push and on manual runs (`workflow_dispatch`): workflow lint (actionlint, pinned by digest), naming check tests, trigger regex tests (`make triggers-test`: `ui.yml` three browsers, `checks.yml` C4, mermaid, API, reserved), neutral naming, gitleaks tests, gitleaks over the pushed commits ([secret scanning](../docs/okf/conventions/secret-scanning.md)), no bidi, format or invisible characters in tracked paths and blobs (`make bidi`, with its tests; [hidden-character check](../docs/okf/conventions/bidi-check.md)), pinned-images and workflow-summary check tests, images pinned by digest (none in workflows), a summary step ending every job, and, when `docs/okf/architecture/`, `docs/diagrams/`, `scripts/render-c4.sh`, `.github/workflows/`, `ci/images.mk`, `Makefile` or `scripts/summary.sh` changed in the range, C4 validate and export; when a Markdown file, `scripts/render-c4.sh`, `scripts/check-mermaid.sh`, a workflow, `ci/images.mk`, `Makefile` or `scripts/summary.sh` changed, every mermaid block in `*.md` and `*.markdown` is rendered with a pinned mermaid-cli (`scripts/check-mermaid.sh`; fails on an empty or unclosed block, a glued fence or a parse error; parsing in mermaid-cli 11.4.2 does not prove GitHub's own Mermaid build shows it); when `api/`, `web/tokens/generated/brand-pack.schema.json` (referenced by the spec), `scripts/test-write-needs-read.sh`, `.github/workflows/`, `ci/images.mk` or `Makefile` changed, OpenAPI lint (`make openapi-lint`, Redocly pinned in `ci/images.mk`) and the tests of its write-contract rule (`make write-contract-test`; decision 0010). When `api/`, `built-in-roles.json`, `reserved-actions.json`, `scripts/check-reserved.mjs` or its test script, the workflows, `ci/images.mk` or `Makefile` changed, the reserved-action check and its tests (`make reserved`, `make reserved-test`; `scripts/check-reserved.mjs`, run with node inside the pinned Redocly image for its YAML parser; decision 0011). On a branch a newer push replaces an older run; on `main` every push gets its own run (no concurrency group shared between runs).
- `.github/workflows/ui.yml` (on `web/**` changes): install, typecheck, tests, build and checks on the runner, then Playwright in the pinned Playwright image via `make e2e-container` ([Playwright in a container](../docs/okf/ui/e2e-container.md)).
- Actions are pinned by commit SHA (Refs #19); images by digest.
- Is CI the only full run? Yes: coders run only the targeted checks, push, report without waiting; the operator watches CI.
- Runner limits: on the lab runners (`platform-lab`), one heavy run at a time; hosted runners have no such limit.

## Review trailer
- Format: `Reviewed-by: <reviewer> - <pointer>` on the merge commit.
- It must share the last paragraph with `Co-Authored-By` (no blank line between them), or git does not parse it as a trailer.
- Check: `git log -1 --format='%(trailers:key=Reviewed-by,valueonly)'`
- Who may waive it: the owner.

## Issues
- Tracker: GitHub issues on `Scrollout/portfolio-manager` via `gh`. Who opens/closes: the operator; peers propose issues to the operator and never open or close them.
- Label set: `bug`, `feature`, `chore`, `docs`, `ci`, `research`, `security`, `decision`. Every issue gets at least one type label.
- What gets an issue: every review finding, red run, carried or deferred item.
- Commit wording: `Fixes #n` only when the commit fully closes the issue, else `Refs #n`.

## Docs
- Location and entry point: [docs/okf/index.md](../docs/okf/index.md). Format rules: [doc-rules.md](../docs/okf/constitution/doc-rules.md).
- Rule: update docs in the same commit as the behaviour.

## OKF docs (optional)
- Bundle: `docs/okf`. Config: `.agents/okf.json`.
- Check: `node /home/marius/orbit/scripts/validate-okf.mjs --root .`. Skill: `okf`.
- Project additions to the doc rules: none.

## Decision records
- Location and index: `docs/okf/decisions` (index.md), only for one-way doors. Format: TODO.

## Security
- Threat model: [docs/okf/security/index.md](../docs/okf/security/index.md).
- Security-sensitive paths (exist now): `.gitleaks.toml`, `.gitignore`, `.github/workflows/`, `scripts/check-*`, `scripts/test-*`, `scripts/e2e-*.sh`, `scripts/summary.sh`, `Makefile`, `ci/images.mk`, `.agents/project.md`, `.agents/naming.json`, `docs/okf/decisions/`, `docs/okf/architecture/resource-model/`, `docs/okf/security/`.
- Security-sensitive paths (planned, TODO until the code exists): resource ID parsing, authn/authz, policy, store, vault/signer interface, adapters, order path.
- Production-like environment(s): TODO (no live connections yet).
- Extra one-way doors: TODO.

## Decisions and approvals
- Peers run `orbit:decide` themselves for each one-way door and send the verdict to the operator.
- The operator accepts a verdict when security and the tech lead agree with no block (medium confidence is enough), recorded as "accepted by operator under owner's autonomy rule, <date>".
- These still escalate to the owner via the operator: a security block or a security/tech-lead disagreement; money, accounts, credentials, legal or terms; repo or org settings; deleting remote state; anything touching live (real-money) trading.
- The operator never overrides a rule the reviewer, security and tech lead agreed on; such a change needs a new `orbit:decide` or the owner.

## Non-negotiable rules
- No secrets in the repo (`.env*` is ignored).

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
review_trailer: Reviewed-by
labels: [bug, feature, chore, docs, ci, research, security, decision]
issue_tracker: github
base_pusher: owner
production_env: TODO
ci_policy: ci-only
```
