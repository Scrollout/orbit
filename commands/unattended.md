---
description: Owner only, typed: open, close or show an unattended go for this session. Orbit's prompt hook handles it before the model sees it; under the go only the pinned base push of a verified merge and the delete of a merged topic branch run without the owner
argument-hint: on [duration, default 12h, at most 24h] | confirm <code> | off | status
disable-model-invocation: true
version: 1.0.0
---
This command is handled by Orbit's UserPromptSubmit hook (`hooks/unattended.mjs`), which blocks the prompt, so this text reaches you only when that hook did not run (node missing, the plugin's hooks off, or the command came through a tool). Then no go opened: do nothing for it, open no go, write no state file, and tell the owner in one line that the unattended go is not open because Orbit's prompt hook did not handle the command. Arguments: $ARGUMENTS

How it works (for the owner; README, Unattended go):
- `on [8h|90m]`: a one-time code appears on your terminal (not in the conversation), valid 2 minutes; nothing opens yet.
- `confirm <code>`: opens the go for this session, until the duration ends (at most 24 h). One wrong code clears it.
- `off`: closes it, from any source. `status`: shows it.
- The go counts only in `bypassPermissions` mode and only for this session's main thread. Under it the guard allows two shared actions: `git [-C <merge worktree>] push origin <40-hex merge sha>:refs/heads/<base>` when the merge proves itself on GitHub and in git, and `git push origin --delete <topic>` for a branch already merged into the base. Every other shared action is denied with "needs the owner"; destructive ones stay denied.
