---
description: Scaffold an OKF v0.2 docs bundle (index, log, constitution, doc rules) plus AGENTS.md/CLAUDE.md pointers; never overwrites existing files
argument-hint: [bundle path, default docs/okf] [project name]
version: 1.0.0
---
Scaffold the OKF bundle in the current repo root. Arguments: $ARGUMENTS

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/okf-init.mjs" --root . [--bundle <path>] [--name "<name>"]`. It creates only files that do not exist: `<bundle>/index.md` (with `okf_version`), `log.md`, `constitution/{index,principles,doc-rules}.md`, `roadmap/{index,milestones,m1}.md`, `AGENTS.md`, `CLAUDE.md` (pointer with `@` imports) and `.agents/okf.json`. It reports what it created and what it skipped.
2. If it skipped an `index.md`, `AGENTS.md` or `CLAUDE.md`, edit the existing file minimally (Edit, never overwrite): link the constitution from the root index, add the principles and doc-rules pointers to AGENTS.md and the `@` lines to CLAUDE.md.
3. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/validate-okf.mjs" --root .`, fix what it reports, and show the result.
4. Fill the roadmap with the project's milestones if they are known (ask, don't invent); otherwise leave the placeholders. Then tell the user about the optional pieces: the `templates/githooks/pre-commit` snippet and the project profile's OKF section (`templates/project.md`). Do not commit.
