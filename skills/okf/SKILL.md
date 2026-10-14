---
name: okf
description: Write, index, log and validate project docs as an OKF v0.2 bundle (small docs, frontmatter, TL;DR, indexes, change log). Use when adding or editing docs under the project's bundle, when a docs check fails, or when deciding whether to split a doc.
version: 1.0.2
---
Read the project profile (.agents/project.md) for the bundle path and any project additions; the defaults are `docs/okf` and the settings in `.agents/okf.json` (keys `bundle`, `maxDocChars`, `maxAgentsLines`, `agentsFile`, `pointerFiles`, `maxPointerLines`, `okfVersion`). A bundle's own `constitution/doc-rules.md` wins over this skill.

## Rules
- **Frontmatter** on every doc except `index.md` and `log.md`: `type`, `title`, `description` (required); `tags`, `status` (`draft`|`stable`|`deprecated`), `generated: { by, at }` (`by` required). Volatile external facts add `stale_after` and `sources` (a list; each entry needs `resource`, plus the `id` it is cited by; optional `last_modified`, and `usage_window: { from, to }`); a checked doc adds `verified: { by: human:<id>, at }` (one mapping or a list, each entry with `by` and `at`). `draft` means not yet reviewed: a doc a human verified is `stable`.
- **Actors**: `<tool>/<model>` for an assistant, `human:<id>`, `process:<id>`.
- **Body** starts with `**TL;DR:** ...`; lists, headings, tables over prose. Target under 400 tokens, hard cap 4000 characters.
- **Index**: each doc is listed in its folder's `index.md` as `* [Title](file.md) - description. Load when ...`, the description as in its frontmatter; each folder index is listed in its parent's (`(folder/index.md)`). Only the root index has frontmatter, and only `okf_version: "0.2"`.
- **Links** bundle-relative (`/area/x.md`) or relative, and they must resolve. Link, never copy.
- **Timestamps** ISO 8601 with a UTC offset (`2027-04-04T00:00:00Z`), never a bare date.
- **Citations**: `[^id]` in the text, `[^id]: title` at the end, keyed by `sources[].id`; every source is cited and every footnote has a source.
- **Log**: `log.md` gets a bullet per added or materially changed doc, under one `## YYYY-MM-DD` heading per date, newest first.
- **Assistant files**: `AGENTS.md` (under the line cap) is the one instruction file; `CLAUDE.md` and other vendor files are short pointers to it (Claude Code imports with `@` lines).
- Docs change in the same commit as the behaviour they describe.

## Add a doc
1. Pick the folder; create `name.md` with the frontmatter and a TL;DR line.
2. Add its line to the folder's `index.md` (create the folder index and link it from the parent if the folder is new).
3. Add a bullet to `log.md` under today's date (create the heading on top if missing).
4. Run the validator.

## Roadmap and milestones
- Roadmaps live in the `roadmap/` folder, listed in the root index. `roadmap/milestones.md` lists the milestones in order: `## M<n> <Title> - <status>` (`planned`, `in progress`, `done YYYY-MM-DD`) and a link to `m<n>.md`.
- `roadmap/m<n>.md` holds that milestone's exit tests, steps with proofs, and carried issues (`#n → M<m>`). A new milestone gets its plan doc, and its line in `roadmap/index.md`, when work on it starts; split by track when it outgrows the cap.
- One name everywhere: the tracker milestone is titled `M<n> <Title>`, every issue targeted at it carries it, and the release is `v0.<n>.0` (profile: Releases, Milestones). When the milestone closes, update its status line and log it.

## When to split

A doc over the cap, or one covering two ideas a reader would load separately: split by idea, link the parts from the index, leave the old doc as the short overview or remove it and fix links. Never raise the cap to fit.

## Validate
`node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-okf.mjs" --root .` (flags override the config: `--bundle`, `--max-doc-chars`, `--max-agents-lines`, `--agents-file`, `--pointer-files a,b`, `--max-pointer-lines`, `--okf-version`, `--config`). Exit 1 lists `file: problem` lines. The plugin's PostToolUse hook runs it after edits under the bundle; `templates/githooks/pre-commit` runs it at commit. New bundle: `/orbit:okf-init`.
