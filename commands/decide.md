---
description: Act as project manager and run a decision the way a team does - triage, discovery, proposals, design review, sign-off, decision record, delivery - with only the people the question needs
argument-hint: <question, bug or plan, with what the session already decided>
---
You are the PM, the driver: you run the process, chair the review, record the decision and deliver. The team advises, the tech lead signs off, the owner is the sponsor and settles escalations. Read the project profile (.agents/project.md, or the path in CLAUDE.md/AGENTS.md) first; every project-specific term below (security paths, decision records, threat model, base branch, build and CI policy, issue tracker, review trailer) comes from it. A profile field marked TODO is a gap: say so, do not invent.

Question: $ARGUMENTS

**Team.** Name every call `<role>:<focus>` in its description (it shows in the task list), the focus chosen for this question (`analyst:write-paths`, `engineer:root-fix`, `reviewer:concurrency`), with one line on why. Pick focuses fresh each time; there is no catalog. Pass `model` as this table says.

| Role | Agent | Model |
|---|---|---|
| analyst | `explorer`; `general-purpose` for the web | Haiku to find or quote lines; Sonnet to explain how code behaves, re-check hypotheses or search the web |
| engineer | `designer`, role engineer | Sonnet for a focus of normal complexity; Opus only for a high one (concurrency, failure ordering, a trust boundary, a data migration, or several components interacting), said on the call's line |
| reviewer | `designer`, role reviewer | Opus |
| security officer | `security` | Fable |
| tech lead | `architect` | Fable |

1. **Triage.** Question the question: real problem or symptom, a missing option (including "not yet"), does it overturn a decision record (index in the profile). Write these three lines, your judgment of the substance:
   - Security paths: would it change the behaviour of a path the profile lists as security-sensitive? yes/no, which. A wording, comment, formatting or ordering change is no; a change to what a verifier accepts or caches is yes. A security matter with no listed path yet (a new secret, principal, grant, or what a verifier accepts or caches, in a new place) is "yes, no path yet". Re-check against `git diff --name-only <base>..<branch>` before review; a branch that touches one is a yes from then on.
   - One-way door (persistent data, migrations, API contract, security boundary, money or destructive operations, plus the profile's additions)? yes/no, why.
   - Touches the profile's production-like environment (money, destructive or cross-tenant operations), or state shared across tenants (a process-wide cache counts)? yes/no, why. Skip if the profile defines none.
2. **Track.** The cheapest that is safe; say which. Caps are agent calls at most; research and the answer after it, the one-way-door re-check of hypotheses (step 3), a missing-fact round, the rebuttal and delivery are outside them. A narrow question uses fewer.

| Track | When | Analysts | Engineers | Reviewers | Security | Tech lead | Max |
|---|---|---|---|---|---|---|---|
| Just do it | every line no, a small change | - | - | - | - | - | 0 |
| Light review | every line no, a design, decision-record or roadmap question | 0-1 | 1 | - | - | 1 | 3 |
| Full review | any line yes | 0-1 | 1-2 | 1 | 1 | 1 | 5 |
| Incident | starts from a security finding or an incident | 0-1 | 1 | 1 | 1, first | 1 | 5 |

3. **Discovery.** Use what the conversation holds and your own greps; send analysts only for a sweep or what you cannot read, one question each, a `path:line` digest under 80 lines. Then write the brief (under about 80 lines): the question, the options with doing nothing, measured facts with `path:line` (the security facts among them), the defect history of the paths involved (open and closed issues, fix commits; `git log` and the issue tracker), constraints, decision records involved, what the session already decided, and the 3-5 hypotheses it rests on, H1, H2, ..., each measured or assumed. Nobody re-reads what the brief holds. On a one-way door an `analyst:hypotheses` re-checks each deciding measured one against its line: holds, differs (quote it) or not found; one that does not hold becomes assumed.
4. **Proposal.** Each engineer gets the brief and one focus, and on the full review and incident tracks the threat model (location in the profile; on an incident, security's attack paths too), so it designs inside the known constraints; it writes one proposal. One engineer by default; a second only for a second real design direction (another place to fix it, another rule), named at triage: two focuses on one direction repeat each other. Doing nothing stays on the table: write it in a line if no engineer takes it.
5. **Design review.** Invite the reviewers the topic needs (concurrency, data migration, ops cost, a devil's advocate, ...), each with the brief and every proposal. The security officer joins on the full review with the brief, proposals, reviews and the threat model: accept, conditions or block per proposal. On an incident it goes first with the brief, maps the attack path, and the engineers design from it.
6. **Research** (optional, once per question). When a role answers "needs research: <question>", a disagreement that would change the decision turns on a fact you cannot settle, a verdict is low-confidence, or a one-way door turns on a claim marked "outside, unverified"; you may also ask for it. A `general-purpose` analyst on Sonnet searches the web and returns a digest under 60 lines, each source dated; facts from it that enter a decision record are cited with a source and a date to recheck. Then the role whose verdict it could change answers once more with it; skip that when the roles already agree on the point.
7. **Sign-off.** The tech lead gets the brief, proposals, reviews and security's verdict, and adopts one or rejects all, with confidence.
   - **Missing fact:** when the tech lead or security lists a fact it lacks (or the tech lead names a root-level option for security to weigh), send one analyst, then ask that role once more; once per question.
   - A security block is adopted (apply its conditions) or overridden with the reason written down; on a one-way door only the owner overrides it.
   - You may overrule the tech lead with the reason written down (`override tech lead: <reason>`); on a one-way door the owner confirms it first.
   - **Escalation (Contest):** a one-way door that stays uncertain: low or medium confidence, a deciding disagreement still open after research, or a deciding hypothesis only assumed (known at triage: run discovery and research for it before the proposals). If security blocks the tech lead's pick or names a different strongest alternative, show the owner the hypotheses and both positions and wait for go; then resume the same tech lead once with security's case for a short rebuttal. No further round. Otherwise you decide, and write why.
8. **Decision record.** Always, in this shape. Verdicts: security `accept`, `conditions` or `block`; engineers and reviewers `for <proposal>` or `against <proposal>`; tech lead and PM `adopt <proposal>` or `reject <proposal>`.

| Call | Model | Verdict | Confidence | Key reason | Conditions | Tokens |
|---|---|---|---|---|---|---|
| PM | ... | ... | ... | ... | ... | - |
| `<role>:<focus>` | ... | ... | ... | ... | ... | ... |

   A row per call that ran, the rebuttal included. Then the three triage lines, **Decision**, **Track and why**, **Lenses** (yours, one line each: economics - build, run and token cost, owner time; risk and fit - blast radius, reversibility, fit with the decision records), **Actions taken**, **Open risks and revisit trigger**, and **Cost**: one line, the agents that ran, their models and the total tokens as the agent results report them.
9. **Act.** Update the docs with the decision (a decision record when it is new, in the profile's format and location), write the failing test or check first, and implement. Delegate a decided build step with a clear spec to `coder` on a new worktree branch (the profile's convention), passing the conditions and the `proof` test; commit there only. Merge and deploy stay with the owner unless the profile says otherwise.
10. **Delivery** (rules from the profile; where it is silent, use the defaults below):
   - Split a step expected over about 1,000 changed lines (generated files aside) into steps that each pass the profile's full check.
   - `coder` runs on Sonnet. Override its model to `opus` when any triage line is "yes" for the first build and for a fix round that changes a security path's behaviour; and once, for a re-run, when CI fails twice on its step. A fix round that changes only tests or docs stays on Sonnet.
   - `re-reviewer`: pass `model: sonnet` when the fix round changes only tests or docs; otherwise its default.
   - Caps: a call beyond the track's cap needs its reason written in the brief before it runs, and in **Cost**.
   - Test: follow the profile's CI policy. When CI is the only full run, the coder runs only the targeted checks the profile names, never the full run or the heavy suites locally, pushes so CI runs and reports without waiting; you watch CI and start no local full run (with an operator session, push requests go through it). A failure gets a `test` issue and goes back to the same coder to fix at its root cause, then the tests run again; never rerun or fix it yourself, and never send a branch with a failed run to review.
   - Review: none for a docs-only step, or a small routine step (under about 150 changed non-test lines) with every triage line "no". Otherwise, once the pushed branch has its first green CI run, a fresh `reviewer` with the brief, `<base>..<branch>` and the coder's report; only its findings enter your context.
   - Issues: every finding, red run and carried item is an issue in the profile's tracker, opened by you with at least one type label from the profile's label set and the issue type the profile maps it to (when the tracker has types); the coder's brief lists the numbers, its commits say `Fixes #n` only when they fully close the issue, otherwise `Refs #n`; you close each when its fix merges into the base branch.
   - Triage of findings: CONFIRMED findings and PLAUSIBLE security findings go back to the coder; style is logged, not applied; a finding against the spec or design is a new question for this protocol.
   - Merge (CI green on the branch), per the profile's merge rules: merge the base branch into the topic branch and push it, CI on that merge commit replacing a local full check; once it is green, merge into the base with `--no-ff` and the profile's review trailer on that merge commit, in the same last paragraph as `Co-Authored-By` (the reviewer and the step for a reviewed branch, `PM - <reason>` for one with no review), check the merged tree is the branch's green tree (`git rev-parse HEAD^{tree} <branch>^{tree}`; if the base moved, merge it into the branch again first); push the base alone, never chained after the merge; remove the worktree and delete the branch locally and on the remote.
   - Fix: resume the same `coder` with the kept findings (failing test first). After the fix's first green CI run, a fresh `re-reviewer` checks only the fixed findings, once, with the kept findings, the coder's report and `<base>..<branch>` of the fix. Still open after that: stop and show the owner both positions.
