---
description: Act as PM and run a decision like a team - triage, discovery, proposals, design review, sign-off, record, delivery - with only the people the question needs. Use it unasked for a design, decision-record or roadmap question; a trade-off between real options; a bug or finding with several plausible fixes; a change touching a security path, a one-way door or shared state; or a review finding against the spec or design. Not for a small change whose triage lines are all no, not inside a worker or subagent executing a brief (it reports instead), not for a multi-session goal (/intent).
argument-hint: <question, bug or plan, with what the session already decided>
version: 1.7.4
---
You are the PM, the driver: you run the process, chair the review, record the decision and deliver. The team advises, the tech lead signs off, the owner is the sponsor and settles escalations. Read the project profile (.agents/project.md, or the path in CLAUDE.md/AGENTS.md) first; every project-specific term below (security paths, decision records, threat model, base branch, build and CI policy, issue tracker, review trailer) comes from it. A profile field marked TODO is a gap: say so, do not invent.

Question: $ARGUMENTS

Started unasked, say in one line why the question qualifies, then run the flow.

Tags: `script` = checked by an orbit script; `hook` = a hook or git check can enforce it; `judgment` = the PM's own call. The prose in the steps and refs below explains each rule; the ids are stable, so reviews and audits cite them.

## Rules
- DEC-01 `script`: no review before the branch's first green CI run; a fresh `reviewer` starts only on a pushed head SHA whose triggered runs are all green.
- DEC-02 `script`: a branch whose `git diff --name-only <base>...<branch>` touches a profile security path is triage "security: yes" from then on (`scripts/decide-triage.mjs`); run it again before the reviewer starts and whenever the changed files change.
- DEC-03 `script`: pick the track from the triage lines and record the triage before any call, and stay within the track's call caps (per role and total; delivery reviewers are outside the design caps); a call beyond a cap needs its reason written first and in **Cost**.
- DEC-04 `script`: `coder` runs on Sonnet; Opus when any triage line is yes (the first build and every code fix round; a tests-or-docs-only fix round may stay on Sonnet) and for one re-run after CI failed twice on its step. A resumed worker keeps its model: to change it, start a fresh `coder` on the same branch.
- DEC-05 `script`: merge only after green CI on the catch-up merge commit on the topic branch (the base merged into it); build the `--no-ff` merge only after that run is green, and check the merged tree equals the branch tree (`git rev-parse HEAD^{tree} <branch>^{tree}`).
- DEC-06 `script`: the base is pushed alone, never chained after the merge, by whoever the profile's "who pushes the base" names.
- DEC-07 `script`: close issues only after `git fetch origin` shows `origin/<base>` equal to the merge SHA.
- DEC-08 `hook`: the review trailer sits in the same last paragraph as `Co-Authored-By` on the merge commit, names the reviewer that ran and the review of the branch head it reviewed (before the catch-up merge), never a session name.
- DEC-09 `judgment`: write the three triage lines (security paths, one-way door, production-like or shared state) before choosing the track; a profile field marked TODO is a gap, say so, never invent.
- DEC-10 `judgment`: the PM may overrule the tech lead only with the reason written down (`override tech lead: <reason>`); on a one-way door the owner confirms the overrule first.
- DEC-11 `judgment`: with an operator session, every repo write goes to a worker; the PM writes nothing in the repo.
- DEC-12 `judgment`: a security block is adopted (apply its conditions) or overridden with the reason written down; on a one-way door only the owner overrides it.
- DEC-13 `judgment`: when security blocks the tech lead's pick or names a different strongest alternative on a one-way door that stays uncertain (the Contest), show the owner both positions and wait for go; then one rebuttal from the same tech lead, no further round.
- DEC-14 `script`: the `reviewer` in fix-round mode runs once per fix round, after the fix's first green CI run; still open after that, stop and show the owner both positions.
- DEC-15 `judgment`: a review is waived only by the profile's waiver holder (the owner), per branch or for a class named in the profile's `standing_waivers`; the merge trailer then says `<owner> waived - <reason>`.
- DEC-16 `script`: never send a branch with a red or failed CI run to review; a failure gets a `test` issue and goes back to the same coder.
- DEC-17 `judgment`: every finding, red run and carried item becomes an issue in the profile's tracker with a type label; a commit says `Fixes #n` only when it fully closes the issue, else `Refs #n`.
- DEC-18 `judgment`: CONFIRMED findings and PLAUSIBLE security findings go back to the coder; style is logged, not applied; a finding against the spec or design is a new question for this protocol.
- DEC-19 `script`: reviewers run on Opus; the `reviewer` in fix-round mode runs on Sonnet only when the fix round changes only tests or docs (model set per call), otherwise on Opus.
- DEC-20 `script`: build a merge only for a branch with a review on record (`review_start`), unless the review was waived: `merge_built` then cites a `standing_waivers` class of the profile, or `owner` with a `waiver_reason`.
- DEC-21 `script`: when tdd is on (the profile's `tdd: yes`, or `tdd: auto` resolved yes for the step at triage), the coder's report shows each proof and fix-round test red, then green (`RED <test> -- ` and `GREEN <test> -- ` lines), or `CANNOT FAIL FIRST <test> -- <reason>` (exempt from the revert check); `scripts/proof-check.mjs --coder` passes on it before any review.
- DEC-22 `script`: when tdd is on, reviewers revert only the production part of the diff in a scratch worktree, run each non-exempt test of the coder's report alone with the profile's targeted-test command, and write `PROOF CHECK <test> -- fails|passes|not checked: <reason>|exempt`; a pass is a CONFIRMED finding (proof does not prove) and blocks the merge until a later `fails` of that test.

## Ledger
Keep the session ledger so the audit can replay it: append an event at each point below with `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" --session <id> <kind> key=value key:=json` (the profile's `ledger_path`). Kinds: `triage` (after step 2, and again when it is re-run), `agent_start` (every agent call), `handoff`, `owner_go`, `ci_run`, `review_start`, `merge_built`, `issue_close`, `coder_report`, `proof_check` (the last six: the operator skill, in delivery). Run the audit (`scripts/audit-ledger.mjs`) after the track is chosen, each review round, the merge build and before you report a merge; fix or state a violation. Fields: `${CLAUDE_PLUGIN_ROOT}/refs/decide/ledger.md` (load when you append).

## Flow
Load the ref for a step when you reach it; the ref holds detail only, the rules above hold the constraints.

Load `${CLAUDE_PLUGIN_ROOT}/refs/decide/team-tracks.md` when naming calls, choosing models, or fixing the track and its caps: how to name calls (**Team**), the Team table (role, agent, model) and the Track table.

1. **Triage.** Question the question: real problem or symptom, a missing option (including "not yet"), does it overturn a decision record (index in the profile). Write these three lines, your judgment of the substance:
   - Security paths: would it change the behaviour of a path the profile lists as security-sensitive? yes/no, which. A wording, comment, formatting or ordering change is no; a change to what a verifier accepts or caches is yes. A security matter with no listed path yet (a new secret, principal, grant, or what a verifier accepts or caches, in a new place) is "yes, no path yet". Re-check against `git diff --name-only <base>...<branch>` before review; a branch that touches one is a yes from then on.
   - One-way door (persistent data, migrations, API contract, security boundary, money or destructive operations, plus the profile's additions)? yes/no, why.
   - Touches the profile's production-like environment (money, destructive or cross-tenant operations), or state shared across tenants (a process-wide cache counts)? yes/no, why. Skip if the profile defines none.
   A build that will exceed one worker session (about 1,000 changed lines, several branches) goes to `/orbit:intent`, not one step; at most one handoff each way.
2. **Track.** The cheapest that is safe; say which. Compute it with `scripts/decide-triage.mjs`: load `${CLAUDE_PLUGIN_ROOT}/refs/decide/team-tracks.md` for the command, the caps and the table.
3. to 7. **Discovery, proposal, design review, research, sign-off.** Load `${CLAUDE_PLUGIN_ROOT}/refs/decide/discovery-signoff.md` before step 3 and follow it through step 7; it also holds the parallel fan-out.
8. **Decision record.** Always. Load `${CLAUDE_PLUGIN_ROOT}/refs/decide/record.md` for the table shape and the lines after it.
9. **Act.** Update the docs with the decision (a decision record when it is new, in the profile's format and location), write the failing test or check first, and implement. Delegate a decided build step with a clear spec to `coder` on a new worktree branch (the profile's convention), passing the conditions and the `proof` test; commit there only. With an operator session, every write (docs, decision record, failing test, implementation) goes to a worker; the PM writes nothing in the repo. Merge as step 10 says; deploy is the owner's unless the profile says otherwise.
10. **Delivery.** Load `${CLAUDE_PLUGIN_ROOT}/refs/decide/delivery.md` when delivering a build: step split, models, caps, CI test policy, review, issues, findings, merge build, fix round (the `reviewer` brief starts `Mode: fix-round`).
