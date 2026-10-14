# Push queue

Detail of the `operator` skill (`skills/operator/SKILL.md`); the numbered rules live there. Load before granting a push GO or watching a CI run.

## Push queue
- Grant one push at a time.
- Before a GO, predict the workflows the push triggers and name them in the GO: `git diff --name-only origin/<branch>..<sha>` (push path filters compare with the branch's previous push; for a first push, `origin/<base>...<sha>`) against the profile's path filters, or each workflow's `paths`/`paths-ignore`. A catch-up merge brings the base's changes into that diff, so it can make a push heavy. Green means every triggered run is green on that head SHA (`gh run list --commit <sha>`). Heavy means a run on the profile's heavy runner class.
- Only one heavy run at a time, including the base's own run after each merge.
- Watch a run with a background loop, not `gh run watch` (it exits early while the run is queued):
  `until [ "$(gh run view ID --json status -q .status)" = completed ]; do sleep 60; done; gh run view ID --json conclusion,headSha`
- A run stuck in queued with no runner: cancel it, wait until it shows cancelled, then rerun.
