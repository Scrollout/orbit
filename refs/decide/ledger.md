# Session ledger fields

Detail of the `/decide` command (`commands/decide.md`, Ledger) and the operator skill. Load when you append a ledger event or read an audit violation.

One JSON object per line; `ts`, `session` and `rule_version` are stamped by `scripts/ledger.mjs`; `topic` equals the branch name. Append: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" --session <id> <kind> key=value key:=<json>` (`key:=` for booleans, numbers, arrays).

| kind | fields |
|---|---|
| `triage` | `topic`, `sec`, `door`, `prod`, `track`, `files` (changed paths) |
| `agent_start` | `role`, `model`, `topic`; `resumed` (a resumed worker keeps its model), `worker` (an id for the worker session: a later coder event with the same id and another model is a violation even without `resumed`; a fresh coder gets a new id), `reason` (`ci-failed-twice` needs opus); `phase` (`design`, `build`, `fix`, `delivery`; a reviewer defaults to `delivery` once a `ci_run` with that `branch` exists); `fix_scope` (`tests-docs` or `code`); `cap_reason`, or `outside_cap` (excludes the call from the caps; needs a `cap_reason`) |
| `ci_run` | `branch` (= topic; a run without it counts for no topic's phase default), `sha`, `workflow` (default `default`), `state` (`green`, `red`, `pending`) or `conclusion` (`success`, `failure`, ...); the latest run per workflow counts |
| `review_start` | `branch`, `sha`, `ci_state`, `role` (`reviewer` or `re-reviewer`) |
| `merge_built` | `branch` (required), `merge_sha`, `tree_equal`, `ci_state` (of the catch-up merge), `waived` (a `standing_waivers` class of the profile, or `owner` with `waiver_reason`), `release_skip` (why this merge is not released, OPR-09) |
| `push` | `ref` (`main`, `HEAD:main`, `origin/main`, `refs/heads/main` all mean the base), `sha`, `chained`, `by` (`agent` or `owner`) |
| `issue_close` | `n`, `origin_base_sha`, `merge_sha` |
| `tag_push` | `tag` (`vX.Y.Z`), `sha` (the merge commit), `by` (`agent` or `owner`; `ci` when a `release_tool` tags), `annotated`, `chained`, `signed` |
| `release` | `tag`, `url`, `via` (`session` default, or `ci`), `verify_tag`, `latest`, `prerelease` |

Replay: `node "${CLAUDE_PLUGIN_ROOT}/scripts/audit-ledger.mjs"` (the profile's `ledger_path`; it prints violations by rule id, `warn:` lines are not fatal).
