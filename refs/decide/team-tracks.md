# Team and tracks

Detail of the `/decide` command (`commands/decide.md`); the numbered rules and the flow live there. Load when naming calls, choosing models, or fixing the track and its caps.

| Role | Agent | Model |
|---|---|---|
| analyst | `explorer`; `general-purpose` for the web | Haiku to find or quote lines; Sonnet to explain how code behaves, re-check hypotheses or search the web |
| engineer | `designer`, role engineer | Sonnet for a focus of normal complexity; Opus only for a high one (concurrency, failure ordering, a trust boundary, a data migration, or several components interacting), said on the call's line |
| reviewer | `designer`, role reviewer | Opus |
| security officer | `security` | Fable |
| tech lead | `architect` | Fable |

2. **Track.** The cheapest that is safe; say which. Caps are agent calls at most; research and the answer after it, the one-way-door re-check of hypotheses (step 3), a missing-fact round, the rebuttal and delivery are outside them. A narrow question uses fewer.
   Compute it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/decide-triage.mjs" --root . --files <planned paths> --lines sec=..,door=..,prod=.. --kind small|design|incident` (`--kind`: `small` a small change with every line no, `design` a design, decision-record or roadmap question with every line no, `incident` starts from a security finding or incident). Once a branch exists use `--base <base> --branch <branch>` instead of `--files`, and run it again before the reviewer starts and whenever the changed files change (a branch that touches a security path stays yes).

| Track | When | Analysts | Engineers | Reviewers | Security | Tech lead | Max |
|---|---|---|---|---|---|---|---|
| Just do it | every line no, a small change | - | - | - | - | - | 0 |
| Light review | every line no, a design, decision-record or roadmap question | 0-1 | 1 | - | - | 1 | 3 |
| Full review | any line yes | 0-1 | 1-2 | 1 | 1 | 1 | 5 |
| Incident | starts from a security finding or an incident | 0-1 | 1 | 1 | 1, first | 1 | 5 |
