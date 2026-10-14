# Working on the Orbit repo

- Every change goes on a topic branch and reaches `main` as a `--no-ff` merge with the `Reviewed-by:` trailer (the reviewer that ran and what it reviewed) in the last paragraph with `Co-Authored-By`.
- `npm test` passes before every commit that is merged.
- A behaviour change bumps the version of what it touches (skill or command `version:`, `rules/rules.json` for scripts, hooks, agents, scenarios), then `scenarios/pin.json` after re-reading the scenarios, then `node scripts/manifest.mjs --update` last.

## Releases: every merge to `main` that bumps the plugin version
The version is SemVer (`0.y.z` while unstable: MINOR for features, PATCH for fixes and docs) and is the same in `.claude-plugin/plugin.json`, README `Version:` and the top `CHANGELOG.md` heading; the tag is `v` plus it.
1. Push `main` first, then confirm the merge commit is on it: `git fetch origin && git merge-base --is-ancestor <merge sha> origin/main`. Only a commit on `origin/main` with green `npm test` is tagged.
2. Annotated tag on that merge commit, never a lightweight one: `git tag -a vX.Y.Z -m "Orbit X.Y.Z: <short title>" <merge sha>` (`-s` instead of `-a` once a signing key is configured).
3. Push the tag alone, by its full ref: `git push origin refs/tags/vX.Y.Z`; check `git ls-remote --tags origin 'vX.Y.Z^{}'` shows the merge sha.
4. Release from the tag: `gh release create vX.Y.Z --verify-tag --title "Orbit X.Y.Z: <short title>" --notes-file <notes> --latest`. Notes: the `## X.Y.Z` section of `CHANGELOG.md`, then `**Full changelog**: https://github.com/Scrollout/orbit/compare/v<previous>...vX.Y.Z`. `--latest` only for the highest version; a pre-release (`vX.Y.Z-rc.N`) uses `--prerelease`.
5. `gh release list` shows it as Latest.
- Never move, delete or re-push a published tag or release; fix forward with a new PATCH version.
