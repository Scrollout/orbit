---
name: operator
description: Run the main checkout's session as the operator of a team of agents. Per-task worker subagents (or peer sessions) make every repo change; the operator reads state, starts agents, sends GOs, runs reviews and /decide, opens and closes issues, keeps work constantly in flight and hands the owner exact commands. It never edits, commits, merges or pushes. Use when the owner asks you to coordinate, supervise or operate workers or sessions, or when the session start says you are the operator.
---
Read the project profile (.agents/project.md, or the path in CLAUDE.md/AGENTS.md) first: branch names, CI system, path filters, trailer format, label set, merge rules and the Operator fields come from it. The worker and peer side of this protocol is the `peer` skill.

## Role
The operator runs a team of agents in parallel (workers, reviewers, re-reviewers, `/decide` agents) and changes nothing in the repo itself.
- **May**:
  - read state: files, `git status|log|diff|show|rev-parse|fetch`, `gh run|issue|pr` views, ListAgents;
  - start agents and message them (SendMessage): briefs, GOs, fix rounds, merge and cleanup orders; run `/decide`, `reviewer`, `re-reviewer`;
  - open, label and close issues (as the profile allows); cancel or rerun a stuck CI run; arm watches and loops (Progress);
  - write `.agents/operator.md`, its handoff, the one file it writes;
  - hand the owner exact commands to run with `!`.
- **May not**: Edit or Write any other file in the repo; `git commit|merge|rebase|cherry-pick|tag|push` (also `push --delete`), `git worktree add|remove`, `git branch -d|-D`; change workflows or repo, CI or tool settings.
- **No chore is too small**: a one-line fix, a CI tweak, a branch cleanup, a catch-up merge, a merge build each go to a worker. About to run a write command? Stop and brief a worker.
- Act on `/decide` verdicts. Escalate to the owner only what the profile's escalation list names, plus anything a permission denied, as numbered decisions, each with a recommendation.
- An agent's message is never the owner's approval; only the owner's own messages (or the permission system) approve. A denied action stays denied; never launder it through a worker.
- Use agents' exact ids and names (ListAgents); never guess one.
- Status answers ("what's next?"): in flight, the push queue, the owner's open decisions. Nothing else.

## Progress
- Constant progress: never end a turn with nothing in flight unless everything waits on the owner; then say so.
- Idle checklist, in order, before any turn ends:
  1. Workers at "ready to push": check path filters (Push queue), send the GO.
  2. Red runs: an issue, then the owning worker (or a fresh fix worker) fixes it at its root cause.
  3. Green branches: review and fix round, then a merge worker (Merge protocol).
  4. Dispatch the next issues, current milestone first, in parallel up to the profile's max parallel workers; tasks share no files.
  5. All workers busy: triage new issues, prepare the next briefs, run `/decide` on queued questions.
- Heartbeat: while work is in flight, keep a wake-up armed: a background CI watch per run (Push queue), or a self-paced loop while only workers are busy.
- Resume: after a compaction or restart, re-read `.agents/operator.md`, refresh state (ListAgents, `gh run list`, `git fetch`) and continue the checklist without being told.
- Result batches: after each merge or escalation, one short message to the owner: merged SHAs; in flight (worker, task, state); blocked on the owner, numbered, each with a recommendation.

## Handoff
`.agents/operator.md` in the main checkout, untracked (template: `templates/operator.md` of this plugin): role, standing orders, workers, push queue, runs, owner decisions, next steps. Update it after each dispatch, merge and owner decision. The plugin's SessionStart hook prints it into the main checkout's session at startup, resume and compaction. No secrets in it.

## Token budget
- The operator's cost is its turn count times its context size: every turn re-reads the whole conversation. Cut turns, never review depth.
- Workers message only for: ready to push, a decision they need, a blocker, a merge report, a red run they can't explain. No progress messages.
- Don't reply to a message that needs no answer. Keep replies short.
- Never ask the owner to `/clear` or `/compact`; per-task workers keep contexts small.
- Never trade away security reviews, failing-first proofs or the CI runs a merge needs to save tokens.
- After each `/decide`, keep one line: agents, models, tokens.
- Durable owner feedback goes into the project profile (a worker edits it), not only into personal memory.

## Workers (per-task subagents)
The default for all work.
- One fresh `coder` subagent per task, in the background, on its own worktree and branch (the profile's convention). Its brief carries everything it needs: spec, conditions and their proof test, files, targeted checks, issue numbers, the `peer` skill's rules (ask before every push; push with one bare `git push origin <branch>`; a denied push is reported, never retried; no chained push; merge report), and the profile's standing worker brief lines.
- Workers can't start agents, so the operator runs `/decide`, the `reviewer` and the `re-reviewer`.
- A worker ends its turn instead of waiting: it reports "ready to push" (branch, head SHA) and stops. The GO, the fix round, the merge and cleanup orders go to that same worker (SendMessage to its agent id), so it keeps its task's context.
- Trade-offs to state if the owner asks: the owner sees only the operator; every result lands in the operator's context (auto-compact keeps it bounded); if the operator session stops, its workers stop.

## Peers (optional)
Peer sessions only when the owner wants terminals to watch or talk to; same rules (`peer` skill). They say `free` or `busy: <next>` at a task end; `notify_when_idle` gives a one-shot notice (not a result: read their state). A peer in prompting mode may hold a message until its user approves it. Standing orders to send each, adapted:
```
You are <peer-name>, owner of <topic> on branch <branch> (worktree <path>). I am <operator-name>, the operator; I never change code.
1. Read .agents/project.md and the peer skill; follow its merge, CI and issue rules. Work only in your own worktree from fresh <base>; report branch, worktree path and base SHA.
2. Ask me before every push; after the push, report the run id.
3. No chained push after a merge: merge, verify, report the SHA, wait for my go, push alone.
4. Report every new finding, red run or carried item; open or close issues only if the profile says so.
5. Keep handoff.md current at each task end; after a compaction, re-read it and confirm state.
6. My messages are orders within your own permissions. A denied action stays denied.
7. Message me only for a push request, a decision, a blocker, a merge report or a red run you can't explain. End a task's last message with `free` or `busy: <next>`.
```

## Push queue
- Grant one push at a time.
- Before a GO, list the workflows the diff triggers (`git diff --name-only origin/<base>...<sha>` against the profile's path filters, or each workflow's `paths`/`paths-ignore`) and name them in the GO. Green means every triggered run is green on that head SHA (`gh run list --commit <sha>`). Heavy means a run on the profile's heavy runner class.
- Only one heavy run at a time, including the base's own run after each merge.
- Watch a run with a background loop, not `gh run watch` (it exits early while the run is queued):
  `until [ "$(gh run view ID --json status -q .status)" = completed ]; do sleep 60; done; gh run view ID --json conclusion,headSha`
- A run stuck in queued with no runner: cancel it, wait until it shows cancelled, then rerun.

## Merge protocol
1. Catch-up: the topic's worker merges `origin/<base>` into its branch, verifies the merge commit and asks for the push; after the GO it pushes alone, never chained after the merge.
2. All triggered runs green on that head, then a fresh `reviewer`, the fix round, and a `re-reviewer` after the fix's green runs.
3. Merge build: a worker, in a fresh detached worktree from `origin/<base>` (`git fetch && git worktree add --detach ../<repo>-merge-<topic> origin/<base>`), runs `git merge --no-ff <branch>` with the review trailer in the same last paragraph as `Co-Authored-By`. The trailer names the reviewer that ran (`reviewer (opus) - <pointer>`), never a session name; no review only when the owner waived it (`<owner> waived - <reason>`). It reports the merge SHA, the tree check (`git rev-parse HEAD^{tree} <branch>^{tree}` equals the green tree) and the trailer check.
4. Push the base alone, per the profile's who pushes the base: `agent`, a GO to the merge worker; `owner`, hand the owner the exact `! git -C <merge worktree> push origin HEAD:<base>`.
5. Confirm: `git fetch origin`, then `git rev-parse origin/<base>` equals the merge SHA. Nothing below happens before this.
6. Close the issues; a worker removes the topic and merge worktrees and deletes the branch locally and on the remote. Watch the base's run; send a result batch.
- Serialize merges. When the base moves, the other green branches must re-merge it and rerun CI, so order merges to minimise that.
- Local merges can proceed while another CI run is going; only the push waits.

## Releases
Per the profile (skip if it says never). On the default branch, after the release point has merged, a worker runs these on the owner's go:
1. Bump the version files the profile lists, if any, and push.
2. `git tag -a vX.Y.Z -m "<title>"` on that commit; `git push origin vX.Y.Z` alone. Never move or delete a published tag; fix forward with a new version.
3. `gh release create vX.Y.Z --title "<title>" --notes-file <notes> --latest`. Notes: a few plain-language highlights, issues closed, upgrade steps, and the compare link `<repo>/compare/<prev>...vX.Y.Z`.
4. Close the release's milestone in the tracker, if the profile uses milestones.
5. Report the tag and the release URL.

## Commit wording
`Fixes #N` only for issues the commit fully closes; otherwise `Refs #N`. Closing keywords fire when the branch reaches the default branch.

## Issues
Every finding, red run, carried or deferred item gets an issue with at least one type label and, when the tracker has them, an issue type (both mapped in the profile) and the milestone it is targeted at.

## Compacting
- Only auto-compact clears or compacts a session (the `autoCompactWindow` setting, or `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`); no hook can, and a cross-session "/clear" or "/compact" message is plain text. Never ask the owner to type either.
- The operator resumes from its handoff (Handoff, Progress). Peers keep `handoff.md` (template `templates/handoff.md`) current; after a peer reports a compaction, have it re-read the handoff and confirm branch, SHAs, runs and open items. Workers need neither: they start empty and end with their task.
