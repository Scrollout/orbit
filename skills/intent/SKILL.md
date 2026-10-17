---
name: intent
description: Turn a goal too big for one session into an approved milestone plan of small units, written as an OKF roadmap doc and checked by a script, before any build (the Inception step of AI-DLC). Use when the owner states a goal, feature or initiative that needs several worker sessions or branches, or asks to plan or break down a milestone. Not for a single bug, question or small change (use /decide), not for an existing /decide question or issue unless /decide or the operator hands it over as too big for one worker, not inside a worker or subagent executing a brief, and not while /okf-init fills its placeholder roadmap.
version: 1.2.1
---
Read the project profile (.agents/project.md, or the path in CLAUDE.md/AGENTS.md) first. A field marked TODO is a gap: say so, never invent. The plan's units are then built through the usual flow: `/orbit:decide` per unit, or the operator's dispatch.

If the owner did not ask for it, say in one line why the goal is too big for one session, then run the flow (the approval gate in step 7 still applies).

## 1. Size gate
If the goal fits one worker session (about 1,000 changed lines or less, one branch), say so and hand it to `/orbit:decide`, unless it came from `/decide` already (at most one handoff each way: then say so and stop). Stop here.

Ledger: with a ledger in use, append each handoff and each step's end with `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" --session <id> handoff topic=<topic> from=<decide|intent|operator> to=<...>` and `... intent milestone=m<n> phase=<questions|draft|checked|approved|written>`; the audit allows one handoff per direction per topic, and `approved` only after `checked`, `written` only after `approved` (fields: `${CLAUDE_PLUGIN_ROOT}/refs/decide/ledger.md`).

## 2. Where the plan goes
- With an OKF bundle (profile "OKF docs", default `docs/okf`): `<bundle>/roadmap/m<n>.md`, the next free milestone number. If the milestone already exists with the placeholder plan (the scaffold's M1), replace that doc and keep its status line; never write a sibling.
- Without a bundle: offer `/orbit:okf-init` first (the plan is an OKF doc). If the owner declines, write the same doc at the profile's Docs location and say it is not validated there.
- The plan needs only the profile's `security_paths`; a TODO in labels, tracker or milestones blocks only step 8.

## 3. One question round
Ask at most five questions, in one message: the outcome and who it is for, constraints, what is out of scope, how done is proved, what is already decided. An answer the owner skips becomes a numbered assumption (A1, A2, ...) in the plan. No second round.

## 4. Discover
Your own greps and reads first. At most one `orbit:explorer` call, only for a sweep you cannot do yourself.

## 5. Draft the plan doc
The scaffold's `roadmap/m1.md` shape, filled in, under the cap (`maxDocChars`, default 4000, frontmatter included):
- Frontmatter: `type: Roadmap`, quoted `title: "M<n> plan: <Title>"`, `description` (one sentence; the index line repeats it), `tags: [roadmap, milestones, m<n>]`, `status: draft`, `generated: { by: claude-code/<model id>, at: <now, ISO 8601 with Z> }`. `sources` only for a fact taken from outside the conversation, each with `id` and `resource`, cited as `[^id]`.
- Body: a `**TL;DR:**` line, `## Intent` (goal, out of scope, assumptions), `## Exit tests` (`Test | Step`), `## Steps`, `## Carried`.
- Steps: `Step | Builds | Files | Proof | Depends | Hint`. One step fits one worker session. Files are paths, directories ending in `/`, or a wildcard in the last segment, separated by commas or spaces; prefer exact files: a directory or wildcard entry is forced to sec=yes whenever a security path could lie below it. Proof names a test or check. Depends lists step ids or `-`. Hint is `sec=yes|no door=yes|no` (plus `prod=yes|no` when the profile names a production_env), your provisional triage, or `decide-first` for a step that is an open design question.
- Over the cap: split by track into `m<n>-<track>.md` docs, one plan; step ids stay unique across them.

## 6. Check it (free, deterministic)
Pipe the rendered doc to `node "${CLAUDE_PLUGIN_ROOT}/scripts/intent-plan.mjs" --root . --plan -` (several docs: `--plan <file>` each, outside the repo in an operator session). Fix every `plan gap` and re-run until exit 0 (it also checks the frontmatter: `type: Roadmap`, the title `M<n> plan: <Title>`, tags `roadmap, milestones, m<n>`, `status: draft`, and a `## Carried` section). Keep the forced `sec=yes` lines; they are the profile speaking. Then append `intent ... phase=checked`.

## 7. Approval gate
- Optional light review, only when the owner asks for it: `orbit:designer` as reviewer, focus `plan-sizing`, with the plan doc and the script's output as the brief; it reads nothing else. Apply what holds, re-run step 6.
- A one-way-door goal (persistent data, migrations, API contract, security boundary, money or destructive operations, plus the profile's additions): run `/orbit:decide` on the plan as a roadmap question before approval. Steps forced to sec=yes or marked door=yes do not trigger it here; each is decided when its issue is built. A step decided elsewhere (its design call ran under another topic, such as this plan's `/decide`) records that topic as `decision_topic` on its branch triage, so the merge check counts that topic's security and tech lead calls.
- Show the owner the doc, the forced lines, the waves and the "decide first" list. Ask once for approval. A change the owner asks for goes back to step 5.
- On approval set `status: stable`, `generated.at` to now and `verified:` as a list with `- { by: human:<id>, at: <now> }`. The id is the owner's GitHub login (`gh api user -q .login`), else ask once; never an email address. Re-run the script with `--approved` (it needs `status: stable` and that human `verified` entry), then append `intent ... phase=approved`.

## 8. Write
- Order: the plan doc; its line in `roadmap/index.md` (`* [M<n> plan](m<n>.md) - <description> Load when working on M<n>.`); `roadmap/milestones.md` (`## M<n> <Title> - planned` with a link, unless the milestone exists; set its `generated` to `{ by: claude-code/<model id>, at: <now> }`); a `**Creation**` bullet under today's `## YYYY-MM-DD` in `log.md`. The docs hook fails between these writes (not yet indexed); act only on the final `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-okf.mjs" --root .`.
- Without an operator session: write in place and do not commit unless the owner says so.
- With an operator session: the operator writes nothing in the repo. The writes are one docs-only task through the normal worker path (branch, commit, review or the profile's docs waiver, merge).
- With the owner's go only: create the tracker milestone `M<n> <Title>` if it is missing, then one issue per step (type label, milestone, a link to the plan doc, the step's Files, Proof and Hint). A `decide-first` step becomes a question issue for `/orbit:decide`.

## 9. Hand off
Append `intent ... phase=written` once the docs are written.
The operator dispatches the issues by its loop, in the script's waves; without one, the owner runs `/orbit:decide` per issue. Later changes to the plan's intent, steps or exit tests need the owner's approval again, appended to `verified`; progress and carried issues do not.
