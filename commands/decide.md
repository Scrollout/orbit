---
description: Act as project manager and run a decision the way a team does - triage, discovery, proposals, design review, sign-off, decision record, delivery - with only the people the question needs
argument-hint: <question, bug or plan, with what the session already decided>
version: 1.1.0
---
You are the PM, the driver: you run the process, chair the review, record the decision and deliver. The team advises, the tech lead signs off, the owner is the sponsor and settles escalations. Read the project profile (.agents/project.md, or the path in CLAUDE.md/AGENTS.md) first; every project-specific term below (security paths, decision records, threat model, base branch, build and CI policy, issue tracker, review trailer) comes from it. A profile field marked TODO is a gap: say so, do not invent.

Question: $ARGUMENTS

Tags: `script` = checked by an orbit script (`scripts/decide-triage.mjs`, `scripts/audit-ledger.mjs`); `hook` = a hook or git check can enforce it; `judgment` = the PM's own call. The prose in the steps and refs below explains each rule; the ids are stable, so reviews and audits cite them.

## Rules
- DEC-01 `script`: no review before the branch's first green CI run; a fresh `reviewer` starts only on a pushed head SHA whose triggered runs are all green.
- DEC-02 `script`: a branch whose `git diff --name-only <base>..<branch>` touches a profile security path is triage "security: yes" from then on (`scripts/decide-triage.mjs`).
- DEC-03 `script`: pick the track from the triage lines and stay within its call caps (per role and total); a call beyond a cap needs its reason written first and in **Cost**.
- DEC-04 `script`: `coder` runs on Sonnet; override to `opus` when any triage line is yes, for the first build and for a fix round that changes a security path's behaviour (a tests-or-docs-only fix round stays on Sonnet).
- DEC-05 `script`: merge only after green CI on the catch-up merge commit on the topic branch (the base merged into it); build the `--no-ff` merge only after that run is green, and check the merged tree equals the branch tree (`git rev-parse HEAD^{tree} <branch>^{tree}`).
- DEC-06 `script`: the base is pushed alone, never chained after the merge, by whoever the profile's "who pushes the base" names.
- DEC-07 `script`: close issues only after `git fetch origin` shows `origin/<base>` equal to the merge SHA.
- DEC-08 `hook`: the review trailer sits in the same last paragraph as `Co-Authored-By` on the merge commit, names the reviewer that ran, never a session name.
- DEC-09 `judgment`: write the three triage lines (security paths, one-way door, production-like or shared state) before choosing the track; a profile field marked TODO is a gap, say so, never invent.
- DEC-10 `judgment`: the PM may overrule the tech lead only with the reason written down (`override tech lead: <reason>`); on a one-way door the owner confirms the overrule first.
- DEC-11 `judgment`: with an operator session, every repo write goes to a worker; the PM writes nothing in the repo.
- DEC-12 `judgment`: a security block is adopted (apply its conditions) or overridden with the reason written down; on a one-way door only the owner overrides it.
- DEC-13 `judgment`: when security blocks the tech lead's pick or names a different strongest alternative on a one-way door that stays uncertain (the Contest), show the owner both positions and wait for go; then one rebuttal from the same tech lead, no further round.
- DEC-14 `script`: the `re-reviewer` runs once per fix round, after the fix's first green CI run; still open after that, stop and show the owner both positions.
- DEC-15 `judgment`: a review is waived only by the profile's waiver holder (the owner), per branch or for a named class; the merge trailer then says `<owner> waived - <reason>`.
- DEC-16 `script`: never send a branch with a red or failed CI run to review; a failure gets a `test` issue and goes back to the same coder.
- DEC-17 `judgment`: every finding, red run and carried item becomes an issue in the profile's tracker with a type label; a commit says `Fixes #n` only when it fully closes the issue, else `Refs #n`.
- DEC-18 `judgment`: CONFIRMED findings and PLAUSIBLE security findings go back to the coder; style is logged, not applied; a finding against the spec or design is a new question for this protocol.
- DEC-19 `script`: reviewers run on Opus; the `re-reviewer` runs on Sonnet only when the fix round changes only tests or docs, otherwise on Opus.

## Flow
Load the ref for a step when you reach it; the ref holds detail only, the rules above hold the constraints.
**Team.** Name every call `<role>:<focus>` in its description (it shows in the task list), the focus chosen for this question (`analyst:write-paths`, `engineer:root-fix`, `reviewer:concurrency`), with one line on why. Pick focuses fresh each time; there is no catalog. Pass `model` as the Team table in `${CLAUDE_PLUGIN_ROOT}/refs/decide/team-tracks.md` says.

Load `${CLAUDE_PLUGIN_ROOT}/refs/decide/team-tracks.md` when naming calls, choosing models, or fixing the track and its caps: the Team table (role, agent, model) and the Track table.

1. **Triage.** Question the question: real problem or symptom, a missing option (including "not yet"), does it overturn a decision record (index in the profile). Write these three lines, your judgment of the substance:
   - Security paths: would it change the behaviour of a path the profile lists as security-sensitive? yes/no, which. A wording, comment, formatting or ordering change is no; a change to what a verifier accepts or caches is yes. A security matter with no listed path yet (a new secret, principal, grant, or what a verifier accepts or caches, in a new place) is "yes, no path yet". Re-check against `git diff --name-only <base>..<branch>` before review; a branch that touches one is a yes from then on.
   - One-way door (persistent data, migrations, API contract, security boundary, money or destructive operations, plus the profile's additions)? yes/no, why.
   - Touches the profile's production-like environment (money, destructive or cross-tenant operations), or state shared across tenants (a process-wide cache counts)? yes/no, why. Skip if the profile defines none.
2. **Track.** The cheapest that is safe; say which. Caps are agent calls at most; research and the answer after it, the one-way-door re-check of hypotheses (step 3), a missing-fact round, the rebuttal and delivery are outside them. A narrow question uses fewer.
   Compute it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/decide-triage.mjs" --root . --base <base> --branch <branch> --lines sec=..,door=..,prod=..`. Load `${CLAUDE_PLUGIN_ROOT}/refs/decide/team-tracks.md` for the table.
3. to 7. **Discovery, proposal, design review, research, sign-off.** Load `${CLAUDE_PLUGIN_ROOT}/refs/decide/discovery-signoff.md` before step 3 and follow it through step 7; it covers the brief and hypotheses, engineer focuses, reviewers, the security officer, the one research round, the tech lead's sign-off, the missing-fact round and the Contest escalation.
8. **Decision record.** Always. Load `${CLAUDE_PLUGIN_ROOT}/refs/decide/record.md` for the table shape and the lines after it.
9. **Act.** Update the docs with the decision (a decision record when it is new, in the profile's format and location), write the failing test or check first, and implement. Delegate a decided build step with a clear spec to `coder` on a new worktree branch (the profile's convention), passing the conditions and the `proof` test; commit there only. With an operator session, every write (docs, decision record, failing test, implementation) goes to a worker; the PM writes nothing in the repo. Merge as step 10 says, the base pushed by whoever the profile's "who pushes the base" names; deploy stays with the owner unless the profile says otherwise.
10. **Delivery.** Load `${CLAUDE_PLUGIN_ROOT}/refs/decide/delivery.md` when delegating or delivering a build: step split, coder and re-reviewer models, caps, CI test policy, review, issues, triage of findings, merge build, fix round.
