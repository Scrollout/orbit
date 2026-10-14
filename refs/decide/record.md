# Decision record

Detail of the `/decide` command (`commands/decide.md`); the numbered rules and the flow live there. Load when writing step 8, the decision record.

8. **Decision record.** Always, in this shape. Verdicts: security `accept`, `conditions` or `block`; engineers and reviewers `for <proposal>` or `against <proposal>`; tech lead and PM `adopt <proposal>` or `reject <proposal>`.

| Call | Model | Verdict | Confidence | Key reason | Conditions | Tokens |
|---|---|---|---|---|---|---|
| PM | ... | ... | ... | ... | ... | - |
| `<role>:<focus>` | ... | ... | ... | ... | ... | ... |

   A row per call that ran, the rebuttal included. Then the three triage lines, **Decision**, **Track and why**, **Lenses** (yours, one line each: economics - build, run and token cost, owner time; risk and fit - blast radius, reversibility, fit with the decision records), **Actions taken**, **Open risks and revisit trigger**, and **Cost**: one line, the agents that ran, their models and the total tokens as the agent results report them.
