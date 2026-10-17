# Tracker

Detail of the `operator` skill (`skills/operator/SKILL.md`); the numbered rules live there. Load when opening issues, or when a plan uses a GitHub Project.

## What the project has
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/tracker.mjs"` prints one line of the features on (the SessionStart handoff shows it): issues, labels, milestones, issue types, projects. It detects with read-only `gh` calls under one deadline (a failure turns that feature off) and caches `.orbit/tracker.json` in the main checkout (self-ignored), re-detected after 7 days; `--detect` re-detects now (after `gh auth refresh -s project`, a new milestone or label).
- The profile wins: `issue_tracker: none`, `milestones: no`, `issue_types: no` turn theirs off; Projects need `github_projects: on` (default `off`). Detection never turns on what the profile turns off.
- A feature that is off is skipped silently, never worked around.

## Issues
One issue per finding round (not per finding), per red run, per carried or deferred item, with whichever is on:
- a type label (the profile's `labels`), plus an area label when the profile lists `areas`;
- the current release milestone (`--milestone`);
- the issue type (Bug for a defect, Feature for a capability, Task otherwise): `gh api graphql` `updateIssueIssueType` with the issue's and the type's node ids.

## Projects (large, complex work only)
Never for a single change set. With `github_projects: on`, or the owner's yes to `/orbit:intent`'s offer for that milestone, the intent milestone has one Project (`tracker.mjs --plan "<milestone>" [--project]` prints the commands): created or reused by title, the repo linked, every step issue added, a Board (Kanban) view grouped by Status: Todo, In progress, In review, Done (the owner sets the layout and adds the In review option once on the Project page; `gh` has no view command).
- At dispatch the operator moves the step's item to In progress, when review starts to In review; closing the issue moves it to Done. `gh project item-list <n> --owner <o> --format json` gives the item id, `gh project field-list <n> --owner <o> --format json` the Status field and option ids, then `gh project item-edit --id <item> --project-id <project id> --field-id <status id> --single-select-option-id <option id>`.
- Projects unavailable (no `project` scope, not readable): skip silently.
