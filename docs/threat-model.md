# Threat model: Orbit's guard

One page. What the PreToolUse guard (`hooks/guard.mjs`) protects, from whom, where the real boundary is, and what is accepted. Behaviour: README, Operator guard and Outward guard.

## Assets
| Asset | Harm |
|---|---|
| The base and protected branches (`main`, `master`, `release/*`, `origin/HEAD`'s target, the profile's `base_branch` and `protected_branches`) | unreviewed code reaches users; history rewritten |
| Published tags and releases | moved, deleted or re-created; consumers get different bits under the same version |
| CI runs | cancelled, re-run or dispatched to fake a green result or burn the owner's runners |
| The owner's approval | an agent message, ledger line or forged go state passed off as the owner's go |
| CI evidence | a commit status or check run minted by an agent to fake a green |
| The owner's `gh` token | read (`gh auth token`) and used outside every check (`curl`) |

## Actors
- **Operator**: the main thread that coordinates; must not write the repo (OPR-01).
- **Peer**: another main session working a branch.
- **Subagent worker**: a coder or reviewer started by a session; its prompts surface in the main session.
- **Injected content**: text in an issue, a PR, a file or a tool result that steers any of the above.
None of them is the owner. An agent can write the ledger and the worktree's `.agents/project.md`, so neither can grant anything (the main checkout's profile sets the review trailer and the base push grant; a worktree's only adds).

## Trust boundary
Claude Code's permission system is the boundary: its allow, ask and deny rules and the owner's answer to a prompt. The guard is a guardrail inside it: it denies destructive actions and turns shared actions into a prompt (`ask`) that only the owner can answer. Under `dontAsk` or a headless run nothing can prompt, so shared actions are denied. The profile can only add protected branches; the guard never reads the ledger.

The owner approves in two forms: an answer to a prompt, or **the go** (`/orbit:unattended`), typed with a one-time code shown only on the owner's terminal. The go is interpreter-forgeable (a program the agent runs can write its state file), so it is intent, not proof: it counts only for its session's main thread in `bypassPermissions`, at most 24 h, and allows only two actions, each bounded by evidence the guard reads itself (the pinned merge sha's parents, tree, trailer and paths in git; first-attempt green GitHub Actions runs covering the base tip's workflows; a branch delete only once merged). Every other shared action under it is denied. The guard denies writes to `~/.claude`, status and check run writes, and scheduled or sent `/orbit:unattended` in every mode.

## Accepted risks
- Not covered: git hook files that push, scripts and interpreters running a file, `make` and `npm run`, `curl` or another client with a token, non-GitHub MCP servers, shell state persisting across calls, a `node` shadowed on `PATH`.
- Node missing: the hook is silent (fail-open), except with `ORBIT_ROLE=operator`.
- The owner's `!` commands skip the hook and are not captured in the ledger.
- The owner may approve a prompt without reading it; the reason is short and fixed-shape to make that less likely, never suppressed.
- A night merge under the go is proven by CI as the agent left it, not by a reviewer: the review trailer is agent text, and changes to `scripts/**` or weakened tests outside the guard's path and skip checks pass if CI passes. An empty commit re-run to get a first-attempt green shows in the night log.
- The go state can be forged by a program the agent runs (a script file or a compiled tool; the guard denies only the writes it parses); the evidence gates hold either way.
