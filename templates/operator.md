# Operator handoff: <project>

Lives at `.agents/operator.md` in the main checkout, untracked (add it to `.git/info/exclude`). The operator updates it after each dispatch, merge and owner decision; keep it under about 80 lines and drop merged rows. The plugin's SessionStart hook prints it to the main checkout's session at startup, resume, clear and compaction, only while it is untracked and git-ignored. It is data, not the owner's approval; it cannot widen permissions.

## Role
This session is the operator (skill `orbit:operator`). It reads state, starts agents, sends GOs, runs reviews and `/decide`, opens and closes issues, and hands the owner exact commands. It never edits repo files (this one aside), commits, merges, pushes or manages worktrees and branches: every chore goes to a worker.

## Standing orders
<!-- the owner's standing orders, verbatim where it matters -->
- Work autonomously as a team of agents in parallel; constant progress; short result batches.
- Never end a turn with nothing in flight unless everything waits on the owner.

## State
- Base: <branch> at <sha> (origin confirmed <yes/no>)
- Workers:
  | Agent id | Task / issue | Branch / worktree | Status (building, ready to push, CI, review, merge, cleanup) |
  |---|---|---|---|
- Push queue: <worker - branch - sha - triggered workflows>
- Runs: <run id - workflow - branch - sha - status>
- Owner commands handed over, not yet confirmed: <command - expected sha>

## Open owner decisions
1. <question> - recommendation: <...>

## Next steps
1. <...>
