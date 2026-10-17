---
description: "Owner only, typed: open, close or show an unattended go for this session. Opening it shows a permission prompt the owner answers; under the go only the pinned base and tag pushes and the release of a verified merge and the delete of a merged topic branch run without the owner"
argument-hint: on [duration, default 12h, at most 24h] | off | status
disable-model-invocation: true
version: 1.1.4
---
Arguments: $ARGUMENTS

Run exactly one Bash call, this command with the arguments as given and nothing added, removed, quoted differently or chained. Write the script as the absolute path of this plugin's `hooks/unattended.mjs` (the literal value of `CLAUDE_PLUGIN_ROOT`), never a shell variable: the guard denies a `$VAR` there.

`node "${CLAUDE_PLUGIN_ROOT}/hooks/unattended.mjs" $ARGUMENTS`

Then report its one output line. Do not retry, rephrase or run it another way: Orbit's guard asks the owner for `on` in every permission mode and denies any other command that may run the script. If the call is denied or the owner declines, say in one line that no go opened.

How it works (for the owner; README, Unattended go):
- `on [8h|90m]`: the guard shows a permission prompt, "open an unattended go of N minutes for this session"; your approval opens the go for this session until the duration ends (default 12 h, at most 24 h). The model can ask for that prompt, never answer it.
- `off`: closes it. `status`: shows it. No argument: the usage. All run without a prompt; a duration out of range is refused with the usage.
- The go counts only in `bypassPermissions` mode and only for this session's main thread. Under it the guard allows, alone in the call, the release steps of a merge that proves itself on GitHub and in git: its base push (`git [-C <dir>] push origin <40-hex merge sha>^{object}:refs/heads/<base>`), its tag push (`git [-C <dir>] push origin <40-hex tag object sha>^{object}:refs/tags/vX.Y.Z`, the tag peeling to the merge) and `gh release create vX.Y.Z` (the tag on origin peeling to the merge; `--notes`, never `-F`); only pinned `<sha>^{object}` (git reads a bare sha as a ref name first): a ref form (`HEAD:<base>`, `vX.Y.Z`) or a bare `<sha>:` is denied with the pinned command to run; and `git push origin --delete <topic>` for a branch already merged into the base. Every other shared action is denied with "needs the owner"; destructive ones stay denied.
