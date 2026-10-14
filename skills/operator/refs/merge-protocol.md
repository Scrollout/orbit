# Merge protocol, releases, issues

Detail of the `operator` skill (`skills/operator/SKILL.md`); the numbered rules live there. Load when a branch is green and ready for review and merge, on a release, or when opening or closing issues.

## Merge protocol
1. Catch-up: the topic's worker merges `origin/<base>` into its branch, verifies the merge commit and asks for the push; after the GO it pushes alone, never chained after the merge.
2. All triggered runs green on that head, then a fresh `reviewer`, the fix round, and a `re-reviewer` after the fix's green runs (records and pointers per Pull requests).
3. Merge build: a worker, in a fresh detached worktree from `origin/<base>` (`git fetch && git worktree add --detach ../<repo>-merge-<topic> origin/<base>`), runs `git merge --no-ff <branch>` with the review trailer in the same last paragraph as `Co-Authored-By`. The trailer names the reviewer that ran (`reviewer (opus) - <pointer>`), never a session name; no review only when the owner waived it (`<owner> waived - <reason>`). It reports the merge SHA, the tree check (`git rev-parse HEAD^{tree} <branch>^{tree}` equals the green tree) and the trailer check.
4. Push the base alone, per the profile's who pushes the base: `agent`, a GO to the merge worker; `owner`, hand the owner the exact `! git -C <merge worktree> push origin HEAD:<base>`.
5. Confirm: `git fetch origin`, then `git rev-parse origin/<base>` equals the merge SHA. Nothing below happens before this.
6. Close the issues; a worker removes the topic and merge worktrees and deletes the branch locally and on the remote. Watch the base's run; send a result batch.
- Serialize merges. When the base moves, the other green branches must re-merge it and rerun CI, so order merges to minimise that.
- Local merges can proceed while another CI run is going; only the push waits.

## Releases
Per the profile (skip if it says never). After the release point has merged into the default branch, on the owner's go:
1. A worker bumps the version files the profile lists, if any, on a topic branch, merged by the Merge protocol.
2. A worker tags the confirmed merge commit: `git tag -a vX.Y.Z -m "<title>" <sha>`. The tag is pushed alone, `git push origin vX.Y.Z`, by whoever the profile's who pushes the base names (owner: hand over `! git -C <worktree> push origin vX.Y.Z`); confirm with `git ls-remote origin refs/tags/vX.Y.Z`. Never move or delete a published tag; fix forward with a new version.
3. A worker runs `gh release create vX.Y.Z --title "<title>" --notes-file <notes> --latest`. Notes: a few plain-language highlights, issues closed, upgrade steps, and the compare link `<repo>/compare/<prev>...vX.Y.Z`.
4. Close the release's milestone in the tracker, if the profile uses milestones.
5. Report the tag and the release URL.

## Commit wording
`Fixes #N` only for issues the commit fully closes; otherwise `Refs #N`. Closing keywords fire when the branch reaches the default branch.

## Issues
Every finding, red run, carried or deferred item gets an issue with at least one type label and, when the tracker has them, an issue type (both mapped in the profile) and the milestone it is targeted at.
