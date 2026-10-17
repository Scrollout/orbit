# CI for the Orbit repo

**TL;DR:** `make ci` runs vet, quality, security and sast inside a pinned toolbox image (host needs git, make, docker) and prints a Markdown report; GitHub Actions runs the same as parallel jobs (one toolbox image build; the job `ci` is the required check) once per push, and publishes it as the job summary. Everything lives under `ci/`, plus the root `Makefile` and `.github/workflows/ci.yml`; no plugin file is touched or needed by CI.

## Targets
| Target | Does |
|---|---|
| `make help` | lists targets |
| `make toolbox` | builds `orbit-ci-toolbox:dev` from `ci/Dockerfile` (context `ci/` only) |
| `make vet` | shellcheck, `node --check` on every `.mjs`, JSON validity, actionlint (workflows and `templates/*.yml`), hadolint, report self-test, `claude plugin validate` and its self-test |
| `make plugin-validate` | `claude plugin validate` on `.` (the marketplace) and `.claude-plugin/plugin.json` (the plugin) alone (`ci/scripts/plugin-validate.sh`): offline, no auth; fails on an error or any warning but `CLAUDE.md` at the plugin root, also one in another form (any output line outside the known shapes); `ci/scripts/plugin-validate.test.sh` (in `make vet`) runs it on fixture plugins: clean passes, a planted warning or an error fails |
| `make quality` | eslint (`ci/eslint.config.mjs`), `tsc -p .` (JSDoc types, `ci/tsc-baseline.json`), `npm test` |
| `make security` | gitleaks on the tree and the history (findings as file:line and rule, never the secret), eslint-plugin-security (`ci/eslint.security.mjs`), dependency check |
| `make sast` | Opengrep and Checkov over the tree, offline, against `ci/sast-baseline.json` (see SAST below) |
| `make report` | prints the Markdown report of the last run |
| `make report-test` | renderer self-test on `ci/fixtures/` (pass, fail, skipped, oversize); also run by `make vet` |
| `make ci` | vet, quality, security, sast; every check runs even after a failure; prints the report; exit status is the failure; clears `ci/out` first |
| `make bump V=x.y.z [RULES=x.y.z]` | version ritual: `plugin.json`, optional `rules/rules.json` version, `manifest --update` |

Details of the long-form targets: `make toolbox` rebuilds from the docker layer cache, and `SKIP_TOOLBOX_BUILD=1` reuses an already loaded image (the workflow's jobs do); `make plugin-validate` fails on any warning but `CLAUDE.md` at the root; `make ci` clears `ci/out`, runs vet, quality, security and sast in that order even after a failure, prints the report and fails if any failed; `make bump` sets `plugin.json` (and `rules/rules.json` with `RULES=`), refuses a `V` or `RULES` that is not `X.Y.Z`, and runs `manifest --update`; `scenarios/pin.json` stays by hand.

A check prints `<target>/<check>: pass|fail|skipped`, a target `PASS`/`FAIL`.

## The container
`ci/scripts/in-toolbox.sh` runs it as the calling user, with the repository mounted read-only, `ci/out/` writable (the report), a tmpfs `/tmp` (mounted `exec`: the Opengrep binary unpacks itself there and runs what it unpacked), a read-only root filesystem, `--network none`, `--cap-drop ALL`, no secrets, no docker socket. No Docker-in-Docker: no check builds or runs a container; only `make toolbox` talks to docker, on the host. The network is needed only to build the image.

## Report
Each check appends one JSON line to `ci/out/<target>.jsonl` (gitignored, truncated per run); `ci/scripts/report.mjs` renders them: a table per target, totals, a collapsed `<details>` per failing check, truncated below 1 MiB between whole blocks, with a note. A target with no records (or an empty or missing file) is shown failed ("no result recorded"), a corrupt line as a failed `corrupt record`; excerpts are neutralised (no HTML, fences or backticks). The workflow appends it to `$GITHUB_STEP_SUMMARY` and uploads `ci/out/` (records and logs) as artifact `ci-report` (7 days). Each check's full output is `ci/out/<target>.<check>.log` (first and last 128 KiB if longer); a failing check also prints the tail of its log to the console.

| Field | Meaning |
|---|---|
| `check`, `target` | check name; `vet`, `quality`, `security` or `sast` |
| `status` | `pass`, `fail`, `skipped` |
| `duration_s` | seconds |
| `tool`, `version` | the tool and its pinned version |
| `findings` | on fail, the lines starting `path:line` (npm-test: failing-test lines), else all output lines |
| `excerpts` | at most 20 of them, 300 characters each; with no `path:line` line, the last 20 lines of output |
| `log` | file name of the full log in `ci/out` |
| `note` | optional reason (skipped) |

## Limits
- `ci/out` is writable inside the container, so plugin code run by `npm test` could alter its own report; the repo itself is read-only. Accepted.
- The marketplace installs the whole repo, so `ci/`, the Makefile and the workflow are copied into installs. Accepted: inert there.
- The image supports amd64 and arm64 (a sha256 each; other architectures fail the build). Only amd64 was built and run when this was written; the arm64 sums come from the releases' checksum files.
- `in-toolbox.sh` runs a command directly only when `/etc/orbit-ci-toolbox` (made by the image) exists, not on a host environment variable.

## Add a check
In the target's script under `ci/scripts/`: `check <name> <tool> <version> <command...>` (exit non-zero to fail; print `path:line message` lines for findings) or `skip <name> <tool> <version> <why>`. Install the tool in `ci/Dockerfile` and export its version in the `ENV` line.

## Pinned versions and bumping
Base images are pinned by version and digest; binaries by version and the release's sha256; eslint packages and `@anthropic-ai/claude-code` (installed with `--ignore-scripts`, its platform binary linked) by `ci/package-lock.json`. Each version is at least two weeks old when pinned (the `acorn` override keeps a transitive one that old). Debian `git` and `ca-certificates` are the distribution's current ones, not pinned.

| Tool | Version |
|---|---|
| node (base image) | 24.21.0 |
| shellcheck | 0.11.0 |
| gitleaks | 8.30.1 |
| actionlint | 1.7.12 |
| hadolint | 2.14.0 |
| eslint, @eslint/js | 9.39.5 |
| eslint-plugin-security | 4.0.1 |
| typescript, @types/node | 6.0.3, 24.19.0 |
| @anthropic-ai/claude-code | 2.1.288 |
| opengrep | 1.30.1 |
| opengrep-rules (commit) | f1d2b562b414783763fd02a6ed2736eaed622efa |
| checkov | 3.3.20 (with its dependencies: `ci/checkov-requirements.txt`) |
| python3 (Debian, for Checkov) | bookworm's, 3.11, not pinned |

To bump: change the `ARG` version and sha256 (from the release's checksum file) or the digest in `ci/Dockerfile`, the `ENV` version, and this table; for npm, edit `ci/package.json` and run `npm install --package-lock-only` in `ci/`; for Checkov, regenerate `ci/checkov-requirements.txt` (below). Then `make ci`.

## Tuning and baseline
Rules turned off are in `ci/eslint*.mjs`, each with its reason. Findings still in plugin files are listed per file in `ci/eslint-baseline.json` (reason each, Scrollout/orbit#3 for the regex rules); `ci/scripts/eslint-baseline.mjs` records the expected hit count per file and rule and fails on any other finding, on a count that grows (a new hit in a baselined file) and on one that shrinks (stale), so fixing shrinks the list. The baseline holds one entry today: the reference regexes of `scripts/rx-diff.test.mjs`, kept on purpose as the oracle of its differential test (Scrollout/orbit#3 fixed every plugin finding); add an entry only with a reason. Types: `tsconfig.json` checks `hooks/`, `scripts/` and `ci/scripts/` `.mjs` files from their JSDoc (`npx tsc -p .` with typescript installed, or `make quality`); `ci/scripts/tsc-baseline.mjs` counts findings per file and code in `ci/tsc-baseline.json` like the eslint baseline, and its `skip` list holds files not counted yet. Findings left unfixed on purpose are reported to the owner, not hidden. Semgrep-style rules run in `make sast` (below), next to eslint-plugin-security and shellcheck.

## SAST (make sast)
`ci/scripts/sast.sh`, offline like every lane (`--network none`); GitHub's CodeQL default setup keeps running alongside, outside this workflow.

| Check | Runs | Output in `ci/out` |
|---|---|---|
| `opengrep` | `opengrep scan --taint-intrafile` (intra-file taint) with the rule packs below, over the tree (git-ignored files skipped) | `sast-opengrep.json`, `.sarif` |
| `checkov` | frameworks `dockerfile` and `github_actions` (secrets are gitleaks', `make security`), `--skip-download` | `checkov/results_json.json`, `results_sarif.sarif` |
| `baseline` | `ci/scripts/sast-baseline.mjs` applies `ci/sast-baseline.json` | its log |

- **Rule packs**: from `opengrep/opengrep-rules` (the fork of semgrep-rules kept under LGPL-2.1 with the Commons Clause; current semgrep-rules has a licence that limits use and redistribution): `javascript`, `bash`, `dockerfile`, `yaml/github-actions/security`, `generic/ci/security`, `generic/unicode`; rule files only (test targets dropped), in the image at `/opt/opengrep-rules`, not in the repo (the marketplace installs the repo). No secrets pack (gitleaks), no TypeScript pack (no `.ts` source).
- **Baseline**: an entry is `{ rule, file, count, reason }` and needs a reason. The check fails on a finding not in the baseline, an entry whose count grows (a new finding; all of the pair's are printed) or shrinks (stale), a Checkov parsing error, and a missing or empty result (no file scanned, a framework not reported). Each finding prints as `path:line rule: message`; a failing run prints its whole log to the console and ends with the proposed `ci/sast-baseline.json` (every current finding by rule and file, the reason of a matching entry or an empty one, which fails until written).
- **First run**: the baseline starts empty, so the first run fails and lists the findings; fix them, or copy the proposed block from the CI log into `ci/sast-baseline.json` with a reason for each entry.

| Pin | Source | Verified (2026-10-17) |
|---|---|---|
| opengrep 1.30.1 (2026-09-21) | `https://github.com/opengrep/opengrep/releases/download/v1.30.1/opengrep_manylinux_{x86,aarch64}` | sha256 of the downloaded files, equal to the release assets' GitHub digests (the release has cosign signatures, no checksum file) |
| opengrep-rules f1d2b562 | `https://github.com/opengrep/opengrep-rules/archive/f1d2b562b414783763fd02a6ed2736eaed622efa.tar.gz` | sha256 of the downloaded tarball (GitHub publishes none) |
| checkov 3.3.20 (2026-09-27) and dependencies | PyPI | `pip download --only-binary=:all: --python-version 3.11` for `manylinux*_x86_64` and `_aarch64`, sha256 of each wheel equal to PyPI's digest, each version at least two weeks old |

Regenerate `ci/checkov-requirements.txt`: `pip download` checkov with those flags (one run per architecture, the `--platform manylinux_2_x_<arch>` tags up to bookworm's glibc 2.36), cap any dependency newer than two weeks, then list every wheel as `name==version` with the `--hash=sha256:` of each architecture's wheel.
