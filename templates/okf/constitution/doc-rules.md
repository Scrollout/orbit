---
type: Rules
title: Doc rules
description: How docs in this OKF v0.2 bundle are written, indexed and logged; enforced by validate-okf.
tags: [constitution, docs]
status: draft
generated: { by: process:orbit-okf-init, at: {{TIMESTAMP}} }
---
**TL;DR:** Docs live in the bundle (`{{BUNDLE}}`): small docs, one idea each, indexed, linked not copied. `node <orbit>/scripts/validate-okf.mjs --root .` enforces it.

- **Frontmatter**: every doc that is not `index.md` or `log.md` starts with YAML frontmatter: `type`, `title`, `description` (all required), and `tags`, `status` (`draft`, `stable`, `deprecated`), `generated: { by, at }` (`by` required). Volatile external facts add `stale_after` and `sources` (each entry needs `resource`); a person who checked a doc adds `verified: { by: human:<id>, at }` (one or a list, each with `by` and `at`) and sets `status: stable`, since `draft` means not yet reviewed. On an approved roadmap plan, a change to its intent, steps or exit tests needs a new approval, appended to `verified`.
- **Actors**: `<tool>/<model>` for an AI assistant, `human:<id>` for a person, `process:<id>` for automation.
- **Body**: begins with a `**TL;DR:**` line (readers stop there if it is enough). Prefer lists, headings and tables over prose.
- **Size**: target under 400 tokens, hard cap 4000 characters. Split rather than grow.
- **Index**: every doc is listed in its folder's `index.md` as `* [Title](file.md) - description. Load when ...`, with the description from its frontmatter; every folder index is listed in its parent's. Only the root index has frontmatter, and only `okf_version`.
- **Links**: bundle-relative (`/area/x.md`) or relative. Link, never copy.
- **Timestamps**: ISO 8601 datetimes with a UTC offset (`2027-04-04T00:00:00Z`), never a bare date.
- **Citations**: cite a source as a footnote keyed by its `sources[].id` (`[^id]` in the text, `[^id]: title` at the end); every source is cited.
- **Log**: add an entry to [log.md](/log.md) when adding or materially changing docs: one `## YYYY-MM-DD` heading per date, newest first, a bullet per change.
- **Machine data** (schemas, codes) lives in JSON or YAML files referenced from docs.
- **Assistant files** (`CLAUDE.md`, `GEMINI.md`, ...) stay short pointers to `AGENTS.md`; nothing assistant-specific goes into the bundle's rules.
