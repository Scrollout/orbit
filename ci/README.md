# CI for the Orbit repo

**TL;DR:** `make ci` runs vet, quality and security inside a pinned toolbox image (host needs git, make, docker) and prints a Markdown report; GitHub Actions runs the same and publishes it as the job summary. Everything lives under `ci/`, plus the root `Makefile` and `.github/workflows/ci.yml`; no plugin file is touched or needed by CI.

## Targets
| Target | Does |
|---|---|
| `make help` | lists targets |
| `make toolbox` | builds `orbit-ci-toolbox:dev` from `ci/Dockerfile` (context `ci/` only) |
| `make vet` | shellcheck, `node --check` on every `.mjs`, JSON validity, actionlint (workflows and `templates/*.yml`), hadolint, report self-test |
| `make quality` | eslint (`ci/eslint.config.mjs`), `npm test` |
| `make security` | gitleaks on the tree and the history, eslint-plugin-security (`ci/eslint.security.mjs`, `--max-warnings 0`), dependency check |
| `make report` | prints the Markdown report of the last run |
| `make report-test` | renderer self-test on `ci/fixtures/` (pass, fail, skipped, oversize); also run by `make vet` |
| `make ci` | vet, quality, security; every check runs even after a failure; prints the report; exit status is the failure |

A check prints `<target>/<check>: pass|fail|skipped`, a target `PASS`/`FAIL`.

## The container
`ci/scripts/in-toolbox.sh` runs it as the calling user, with the repository mounted read-only, `ci/out/` writable (the report), a tmpfs `/tmp`, a read-only root filesystem, `--network none`, `--cap-drop ALL`, no secrets, no docker socket. No Docker-in-Docker: no check builds or runs a container; only `make toolbox` talks to docker, on the host. The network is needed only to build the image.

## Report
Each check appends one JSON line to `ci/out/<target>.jsonl` (gitignored, truncated per run); `ci/scripts/report.mjs` renders them: a table per target, totals, a collapsed `<details>` per failing check, truncated below 1 MiB with a note. The workflow appends it to `$GITHUB_STEP_SUMMARY` and uploads the JSON as artifact `ci-report` (7 days).

| Field | Meaning |
|---|---|
| `check`, `target` | check name; `vet`, `quality` or `security` |
| `status` | `pass`, `fail`, `skipped` |
| `duration_s` | seconds |
| `tool`, `version` | the tool and its pinned version |
| `findings` | on fail, the lines starting `path:line` (else all output lines) |
| `excerpts` | at most 20 of them, 300 characters each |
| `note` | optional reason (skipped) |

## Add a check
In the target's script under `ci/scripts/`: `check <name> <tool> <version> <command...>` (exit non-zero to fail; print `path:line message` lines for findings) or `skip <name> <tool> <version> <why>`. Install the tool in `ci/Dockerfile` and export its version in the `ENV` line.

## Pinned versions and bumping
Base images are pinned by version and digest; binaries by version and the release's sha256; eslint packages by `ci/package-lock.json`. Each version is at least two weeks old when pinned (the `acorn` override keeps a transitive one that old). Debian `git` and `ca-certificates` are the distribution's current ones, not pinned.

| Tool | Version |
|---|---|
| node (base image) | 24.21.0 |
| shellcheck | 0.11.0 |
| gitleaks | 8.30.1 |
| actionlint | 1.7.12 |
| hadolint | 2.14.0 |
| eslint, @eslint/js | 9.39.5 |
| eslint-plugin-security | 4.0.1 |

To bump: change the `ARG` version and sha256 (from the release's checksum file) or the digest in `ci/Dockerfile`, the `ENV` version, and this table; for npm, edit `ci/package.json` and run `npm install --package-lock-only` in `ci/`. Then `make ci`.

## Tuning
Rule suppressions are in `ci/eslint*.mjs` and `-e` flags in `ci/scripts/vet.sh`, each with its reason; findings left unfixed on purpose are reported to the owner, not hidden. Semgrep is not used: it needs a Python stack with no hash-pinned install here; eslint-plugin-security and shellcheck cover the JS and shell.
