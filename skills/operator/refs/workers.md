# Workers and peers

Detail of the `operator` skill (`skills/operator/SKILL.md`); the numbered rules live there. Load when starting, briefing or resuming a worker or peer.

## Workers (per-task subagents)
The default for all work.
- One fresh `coder` subagent per task, in the background, on its own worktree and branch (the profile's convention). Its brief carries everything it needs: spec, conditions and the exact names of their proof tests, when tdd is on for the step (the triage's `tdd` line) the report's red-then-green lines for each (`RED`/`GREEN <test> -- `, or `CANNOT FAIL FIRST <test> -- <reason>`; DEC-21), files, targeted checks, issue numbers, the `peer` skill's rules (ask before every push; push with one bare `git push origin <branch>`; a denied push is reported, never retried; no chained push; merge report), and the profile's standing worker brief lines. A clean tree means `git status --porcelain` prints nothing.
- Workers can't start agents, so the operator runs `/decide`, the `reviewer` (also in fix-round mode).
- A worker ends its turn instead of waiting: it reports "ready to push" (branch, head SHA) and stops. The GO, the fix round, the merge and cleanup orders go to that same worker (SendMessage to its agent id), so it keeps its task's context.
- **Worker reuse** (profile `Worker reuse`, default `fresh-per-task`): a resumed worker re-reads its whole context on every message, so its cost grows. Every new task starts a new worker (new Agent call, full brief). Resume (SendMessage) only to finish that worker's own open branch: fix round, catch-up, merge build, cleanup, a reviewer's findings on it. Once it has delivered (merged, or branch closed) it gets no unrelated work; it is retired. The fresh brief carries everything, since the worker has no history: spec, worktree and branch names, base SHA, checks to run, push protocol, no `git stash`. `resume-ok` restores reuse of delivered workers.
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
