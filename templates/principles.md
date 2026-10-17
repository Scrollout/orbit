# Principles

Don't assume, build the minimum, touch only what you must, define success and loop until verified (every loop has a stated cap; at the cap, stop and report); read wide in subagents; one worktree per session.

## 1. Think before coding
- State assumptions explicitly; if uncertain, ask rather than guess.
- Present multiple interpretations; don't pick silently when ambiguity exists.
- Push back when warranted; if a simpler approach exists, say so.
- Stop when confused; name what is unclear and ask.

## 2. Simplicity first
- Minimum code that solves the problem. Nothing speculative.
- No features, abstractions, configurability or error handling for impossible cases beyond what was asked.
- If 200 lines could be 50, rewrite it.

## 3. Surgical changes
- Touch only what you must. Clean up only your own mess.
- Don't improve adjacent code, comments or formatting; match existing style.
- Unrelated dead code: mention it, don't delete it. Remove what your change made unused.

## 4. Goal-driven execution
- Turn imperative tasks into verifiable goals (a failing test or check first).
- For multi-step tasks, state a brief plan with a verification checkpoint per step.
- Every loop (retries, review rounds, fix rounds, reflection) has a stated cap; at the cap, stop and report what is left.

## 5. Subagents for wide reading
Research, big specs and code review run in a subagent; only the digest returns.

## 6. One worktree per session
- Work only in your own worktree and topic branch, never on the default or base branch. Tasks share no files across branches.
- Merge one branch at a time, with `--no-ff`, after merging the base into it and a green CI run on that merge commit; check the merged tree is the green tree; then remove the worktree and delete the branch locally and on the remote. Exact rules: the project profile.

Working if: small diffs, few rewrites, clarifying questions come before implementation.
