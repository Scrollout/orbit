# Threat model: Orbit's guard

One page. What the PreToolUse guard (`hooks/guard.mjs`) protects, from whom, where the real boundary is, and what is accepted. Behaviour: README, Operator guard and Outward guard.

## Assets
| Asset | Harm |
|---|---|
| The base and protected branches (`main`, `master`, `release/*`, `origin/HEAD`'s target, the profile's `base_branch` and `protected_branches`) | unreviewed code reaches users; history rewritten |
| Published tags and releases | moved, deleted or re-created; consumers get different bits under the same version |
| CI runs | cancelled, re-run or dispatched to fake a green result or burn the owner's runners |
| The owner's approval | an agent message or ledger line passed off as the owner's go |
| The owner's `gh` token | read (`gh auth token`) and used outside every check (`curl`) |

## Actors
- **Operator**: the main thread that coordinates; must not write the repo (OPR-01).
- **Peer**: another main session working a branch.
- **Subagent worker**: a coder or reviewer started by a session; its prompts surface in the main session.
- **Injected content**: text in an issue, a PR, a file or a tool result that steers any of the above.
None of them is the owner. An agent can write the ledger and the worktree's `.agents/project.md`, so neither can grant anything.

## Trust boundary
Claude Code's permission system is the boundary: its allow, ask and deny rules and the owner's answer to a prompt. The guard is a guardrail inside it: it denies destructive actions and turns shared actions into a prompt (`ask`) that only the owner can answer. Under `dontAsk` or a headless run nothing can prompt, so shared actions are denied. The profile can only add protected branches; the guard never reads the ledger.

## Accepted risks
- Not covered: git hook files that push, scripts and interpreters running a file, `make` and `npm run`, `curl` or another client with a token, non-GitHub MCP servers, shell state persisting across calls, a `node` shadowed on `PATH`.
- Node missing: the hook is silent (fail-open), except with `ORBIT_ROLE=operator`.
- The owner's `!` commands skip the hook and are not captured in the ledger.
- The owner may approve a prompt without reading it; the reason is short and fixed-shape to make that less likely, never suppressed.
