#!/bin/sh
# Self-test for operator-context.sh: sh hooks/operator-context.test.sh (needs git; node for the JSON check).
set -u
hook="$(cd "$(dirname "$0")" && pwd)/operator-context.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else printf 'FAIL %s: got [%s], want [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }
run() { (cd "$1" && CLAUDE_PROJECT_DIR="$1" sh "$hook"); }

repo="$tmp/repo"
git init -q "$repo"
git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
check "main checkout without operator.md is silent" "$(run "$repo")" ""

mkdir -p "$repo/.agents"
printf '# Operator\n## State\n- quote " backslash \\ tab\there\n' > "$repo/.agents/operator.md"
out=$(run "$repo")
if command -v node >/dev/null 2>&1; then
  ctx=$(printf '%s' "$out" | node -e 'const e=JSON.parse(require("fs").readFileSync(0,"utf8")).hookSpecificOutput; process.stdout.write(e.hookEventName+"|"+e.additionalContext)')
  want=$(printf 'SessionStart|# Operator\n## State\n- quote " backslash \\ tab\there\n\n\nYou are the operator. Load orbit:operator. Resume from the State section; do not wait to be told.')
  check "main checkout prints the handoff as additionalContext" "$ctx" "$want"
else
  case "$out" in *'You are the operator.'*) r=yes ;; *) r=no ;; esac
  check "main checkout prints the operator line (no node: JSON not parsed)" "$r" yes
fi

git -C "$repo" worktree add -q --detach "$tmp/repo-topic"
mkdir -p "$tmp/repo-topic/.agents" && cp "$repo/.agents/operator.md" "$tmp/repo-topic/.agents/"
check "linked worktree is silent" "$(run "$tmp/repo-topic")" ""

mkdir -p "$tmp/plain/.agents" && cp "$repo/.agents/operator.md" "$tmp/plain/.agents/"
check "non-git directory is silent" "$(export GIT_CEILING_DIRECTORIES="$tmp"; run "$tmp/plain")" ""

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
