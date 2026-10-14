# Merge protocol, releases, issues

Detail of the `operator` skill (`skills/operator/SKILL.md`); the numbered rules live there. Load when a branch is green and ready for review and merge, on a release, or when opening or closing issues.

## Merge protocol
1. Review first: all triggered runs green on the branch's first pushed head, then a fresh `reviewer`, the fix round, and a `re-reviewer` after the fix's green runs (records and pointers per Pull requests).
2. Catch-up at merge time: the topic's worker merges `origin/<base>` into its branch, verifies the merge commit and asks for the push; after the GO it pushes alone, never chained after the merge. Wait for green CI on that merge commit; if the base moves again, repeat. The catch-up adds only the base's changes, so the review stands.
3. Merge build: a worker, in a fresh detached worktree from `origin/<base>` (`git fetch && git worktree add --detach ../<repo>-merge-<topic> origin/<base>`), runs `git merge --no-ff <branch>` only after step 2's run is green, with the review trailer in the same last paragraph as `Co-Authored-By`. The trailer names the reviewer that ran and the branch head it reviewed (`reviewer (opus) - <pointer>`), never a session name; no review only when it was waived (`<owner> waived - <reason>`). It reports the merge SHA, the tree check (`git rev-parse HEAD^{tree} <branch>^{tree}` equals the catch-up head's tree) and the trailer check.
4. Push the base alone, per the profile's who pushes the base: `agent`, a GO to the merge worker; `owner`, hand the owner the exact `! git -C <merge worktree> push origin HEAD:<base>`.
5. Confirm: `git fetch origin`, then `git rev-parse origin/<base>` equals the merge SHA. Nothing below happens before this.
6. Close the issues; a worker removes the topic and merge worktrees and deletes the branch locally and on the remote. Watch the base's run; send a result batch.
- Serialize merges. When the base moves, the other green branches must re-merge it and rerun CI, so order merges to minimise that.
- Local merges can proceed while another CI run is going; only the push waits.

## Releases
OPR-09, from the profile's `release_when`, `release_via`, `release_tool`, `version_files` and `changelog`. Setting `release_when` is the owner's standing go: no ask per release. The operator never tags or releases (OPR-01): a worker does, and the owner pushes the tag when `base_pusher` is `owner`. Without an operator session the `/decide` session does the worker's part.
0. Guard rails, once per project and when the owner asks: `node "${CLAUDE_PLUGIN_ROOT}/scripts/release-check.mjs" --repo` (branch protection with required checks, a tag ruleset, immutable releases, CI, tag signing). Its gaps go to the owner as one numbered decision with the printed fixes; never change a forge setting, a workflow or a key yourself. With `release_via: ci` and no tag workflow, offer `${CLAUDE_PLUGIN_ROOT}/templates/release.yml`, written only on the owner's go, as a security-path change.
1. Version, in the change itself (`change-set`) or on a release branch merged by the Merge protocol (`milestone`): the worker runs `release-check.mjs --next` on its branch, bumps the version files, writes the changelog's `## X.Y.Z` section (Added, Changed, Fixed, Removed, Security) and re-runs it until no gap, so the reviewer sees the bump with the change. A merge that needs no release records `release_skip` with the reason on `merge_built`. With a `release_tool`, follow the tool (Conventional Commit subjects, a changeset file, merging its release PR); never bump by hand.
2. Confirm, after the base push (Merge protocol step 5): `git merge-base --is-ancestor <merge sha> origin/<base>`, every run on that sha green.
3. Tag: `git tag -a vX.Y.Z -m "<project> X.Y.Z: <title>" <merge sha>` (`-s` when a signing key is configured). Push it alone, by its full ref, as the `base_pusher`: `git push origin refs/tags/vX.Y.Z` (owner: hand over `! git -C <worktree> push origin refs/tags/vX.Y.Z`). Check `git ls-remote --tags origin 'vX.Y.Z^{}'` shows the merge sha. Ledger: `tag_push` (with `ref`, `signed`).
4. Release. `release_via: ci`: the tag starts the release workflow (tests, build, checksums, provenance attestation, release); watch it like any run (Push queue) and report its URL; a red run is an issue, fixed forward. `session` (default): `release-check.mjs --next --notes <file>` (after tagging it takes the tag at HEAD as this release) writes the changelog section and the compare link (no changelog: write highlights, issues closed, upgrade steps), then `gh release create vX.Y.Z --verify-tag --title "<project> X.Y.Z: <title>" --notes-file <file>`, `--latest` only for the highest version (else `--latest=false`), `--prerelease` for `-rc.N`; release files go up with a `SHA256SUMS` file. Ledger: `release`.
5. Close the milestone once its release is published; report the tag, the release URL and the run URL.
- Bad release: never move, delete or re-create a published tag or release; fix forward with a PATCH, and deprecate or yank the bad version where it was published (`npm deprecate`, `cargo yank`, ...).
- Older line: a fix for `X.Y` goes on `release/X.Y`, cut from its last tag, merged there by the Merge protocol (that branch is the base for the merge), released as `vX.Y.(Z+1)` with `--latest=false`.

## Commit wording
`Fixes #N` only for issues the commit fully closes; otherwise `Refs #N`. Closing keywords fire when the branch reaches the default branch.

## Issues
Every finding, red run, carried or deferred item gets an issue with at least one type label and, when the tracker has them, an issue type (both mapped in the profile) and the milestone it is targeted at.
