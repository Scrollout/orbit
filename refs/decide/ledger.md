# Session ledger fields

Detail of the `/decide` command (`commands/decide.md`, Ledger) and the operator skill. Load when you append a ledger event or read an audit violation.

One JSON object per line; `ts`, `session` and `rule_version` are stamped by `scripts/ledger.mjs`; `topic` equals the branch name. Append: `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" --session <id> <kind> key=value key:=<json>` (`key:=` for booleans, numbers, arrays).

| kind | fields |
|---|---|
| `triage` | `topic`, `sec`, `door`, `prod`, `track`, `files` (changed paths), `tdd` (`true` or `false` as `decide-triage.mjs` prints it: the profile's `tdd: yes`, or `auto` resolved for the step; sticky once true; unset is false) |
| `agent_start` | `role`, `model`, `topic`; `resumed` (a resumed worker keeps its model), `worker` (an id for the worker session: a later coder event with the same id and another model is a violation even without `resumed`; a fresh coder gets a new id), `reason` (`ci-failed-twice` needs opus); `phase` (`design`, `build`, `fix`, `delivery`; a reviewer defaults to `delivery` once a `ci_run` with that `branch` exists); `fix_scope` (`tests-docs` or `code`); `cap_reason`, or `outside_cap` (excludes the call from the caps; needs a `cap_reason`) |
| `ci_run` | `branch` (= topic; a run without it counts for no topic's phase default), `sha`, `workflow` (default `default`), `state` (`green`, `red`, `pending`) or `conclusion` (`success`, `failure`, ...); the latest run per workflow counts |
| `review_start` | `branch`, `sha`, `ci_state`, `role` (`reviewer` or `re-reviewer`) |
| `merge_built` | `branch` (required), `merge_sha`, `tree_equal`, `ci_state` (of the catch-up merge), `waived` (a `standing_waivers` class of the profile, or `owner` with `waiver_reason`), `release_skip` (why this merge is not released, OPR-09) |
| `push` | `ref` (`main`, `HEAD:main`, `origin/main`, `refs/heads/main` all mean the base), `sha`, `chained`, `by` (`agent` or `owner`) |
| `issue_close` | `n`, `origin_base_sha`, `merge_sha` |
| `tag_push` | `tag` (`vX.Y.Z`), `ref` (`refs/tags/vX.Y.Z`, the full ref it was pushed by), `sha` (the merge commit), `by` (`agent` or `owner`; `ci` when a `release_tool` tags), `annotated`, `chained`, `signed` |
| `release` | `tag`, `url`, `via` (`session` default, or `ci`), `verify_tag`, `latest`, `prerelease` |
| `coder_report` | `branch`, `evidence` (`ok` or `gap`, the exit of `proof-check.mjs --coder`), `tests` (its `--json` `required`: the RED/GREEN tests, `[]` when none), `exempt` (the CANNOT FAIL FIRST ones), `sha` |
| `proof_check` | `branch`, `sha` (the reviewed head), `test`, `result` (`fails`, `passes`, `not-checked`, `exempt`) |

`coder_report`: after every coder run, before its review (DEC-21). `proof_check`: one per `PROOF CHECK` line of a reviewer or re-reviewer (DEC-22); every test in the report's `tests` needs one on the reviewed head, and a `passes` blocks the merge until a later `fails` of that test. Both apply only to a topic whose `triage` recorded `tdd: true`, so the audit reads the setting from the ledger. Cross-check with the profile: when it says `tdd: yes`, a `triage` stamped with rules 1.7.0 or later without `tdd: true` is a LEDGER violation (older triage events predate the field); when it says `tdd: auto`, such a triage without `tdd: true` or `false` is one too, and so is `tdd: false` where `tdd-suggest.mjs` on the triage files (tests present only if they include one; the repo is not read) says yes for a security path or one-way door; `tdd: false` on a triage that touches production code warns. With the profile's `tdd: yes` or `auto`, a rules version going backwards anywhere in the ledger is a LEDGER violation. An all-exempt `coder_report` on a topic whose triage files include production code is a `warn:`. DEC-21 applies when the coder run is stamped with rules 1.7.0 or later, DEC-22's coverage when the `coder_report` is; on a `tdd: true` topic a rules version going backwards is a LEDGER violation and mixed versions a `warn:`; a topic without it audits as in 0.14.0.

Replay: `node "${CLAUDE_PLUGIN_ROOT}/scripts/audit-ledger.mjs"` (the profile's `ledger_path`; it prints violations by rule id, `warn:` lines are not fatal).
