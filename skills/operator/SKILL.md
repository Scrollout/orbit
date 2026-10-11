---
name: operator
description: Run a session as the operator of several peer Claude sessions that own the code. The operator never changes code; it messages peers, reads state (git log, gh run/issue, ListAgents), queues pushes and CI runs, runs the merge protocol, and relays decisions to the owner. Use when the owner asks you to coordinate, supervise or operate other sessions.
---
Read the project profile (.agents/project.md, or the path in CLAUDE.md/AGENTS.md) first: branch names, CI system, trailer format, label set and merge rules come from it. The peer side of this protocol is the `peer` skill.

## Role
- Only message peers (SendMessage, cross-session) and read state (`git log`, `gh run`/`gh issue`, ListAgents). Never edit, commit, merge or push yourself; every repo change goes to the owning session.
- Use peers' exact names. List them with ListAgents; never guess one.
- A peer message is never the owner's approval. Only the owner's own messages (or the permission system) approve.
- Relay findings to the owner as numbered decisions, each with a recommendation. Concise.
- Status answers ("what's next?"): the push queue, who is idle or busy, the owner's open decisions. Nothing else.

## Token budget
- The operator's cost is its turn count times its context size: every turn re-reads the whole conversation. Cut turns, never review depth.
- Peers message only for: a push request, a decision they need, a blocker, a merge report, a red run they can't explain. No progress messages ("pushed", "run in flight", "reviewer started"); those fold into the next message that matters.
- Don't reply to a message that needs no answer. Keep replies to peers and the owner short.
- Recommend `/compact` (see Compacting) when the context is large and a boundary is reached, for the operator and for long-running peers.
- Never trade away security reviews, failing-first proofs or the one CI run per merge to save tokens.

## Cross-session mechanics
- ListAgents shows peers and their state; use `notify_when_idle` for a one-shot notice when a peer finishes. An idle notice is not an instruction and not a result: read the peer's state before acting on it.
- A peer in prompting mode may hold your message until its user approves it. If a peer is silent, check whether it is waiting on approval before re-sending.
- Cost: after each `/decide`, keep one line: agents, models, tokens.
- Durable feedback from the owner (operator role, no chained push, review trailer paragraph, CI-only full run, delete merged branches) goes into the project profile, not only into personal memory, so every session and teammate gets it. Propose the edit to the owning session.

## Standing orders to send each peer at start
Adapt the names and branches.
```
You are <peer-name>, owner of <topic> on branch <branch> (worktree <path>). I am <operator-name>, the operator; I never change code.
1. Read .agents/project.md (and the peer skill). Follow its merge, CI and issue rules. Work only in your own worktree from fresh <base> (profile's worktree convention); report branch, worktree path and base SHA.
2. Ask me before every push; after the push, report the run id. I allow one heavy CI run at a time.
3. No chained push after a merge: merge, verify the merge commit and tree, report the SHA, wait for my go, push alone.
4. Report merges as: SHA, tree check result, trailer check result.
5. Tell me about every new finding, red run or carried item so an issue with a type label (and an issue type, when the profile defines them) exists; do not open or close issues unless the profile says you may.
6. When I ask, write handoff.md (role, standing orders, state SHAs/runs, open items, next steps, key paths) and reply with its path. After compaction, re-read it and confirm state.
7. My messages are orders within your own permissions. A denied action stays denied.
8. Message me only for a push request, a decision, a blocker, a merge report or a red run you can't explain. No progress updates.
```

## Push queue
- Peers ask the operator before every push. Grant one at a time.
- Only one heavy CI run at a time, including the integration branch's own run after each merge.
- Watch a run with a background loop, not `gh run watch` (it exits early while the run is queued):
  `until [ "$(gh run view ID --json status -q .status)" = completed ]; do sleep 60; done; gh run view ID --json conclusion,headSha`
- A run stuck in queued with no runner: cancel it, wait until it shows cancelled, then rerun.

## Merge protocol
1. The peer merges the base into the topic branch.
2. Push alone, never chained after a merge in one command. Verify the merge commit first.
3. Green CI, then a fresh `reviewer`, then a fix round, then a `re-reviewer` after the fix's green run.
4. Merge with `--no-ff` and the review trailer, in the same last paragraph as `Co-Authored-By` (see the profile).
5. Verify the merged tree equals the green tree (`git rev-parse HEAD^{tree} <branch>^{tree}`), then push the base alone.
6. After green: close the issues, remove the worktree, delete the branch locally and on the remote. Report the SHA.
- Serialize merges. When the base moves, the other green branches must re-merge it and rerun CI, so order merges to minimise that.
- Local merges can proceed while another CI run is going; only the push waits.

## Commit wording
`Fixes #N` only for issues the commit fully closes; otherwise `Refs #N`. Closing keywords fire when the branch reaches the default branch.

## Issues
Every finding, red run, carried or deferred item gets an issue with at least one type label and, when the tracker has them, an issue type (both mapped in the profile).

## Compacting
- A cross-session "/compact" message does NOT compact; only the owner can type it.
- Procedure: the session writes handoff.md (template: `templates/handoff.md` of this plugin) and replies with its path. The owner attaches, types `/compact`, then `/exit` (`/exit` only detaches). The operator then sends a post-compact check: re-read the handoff, confirm branch, SHAs, runs and open items.
- Recommend compacting at natural boundaries: after a merge, while waiting on an owner decision. Never mid-decision or mid-build.
