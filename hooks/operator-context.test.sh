#!/bin/sh
# Self-test for operator-context.sh: sh hooks/operator-context.test.sh (needs git; node for the JSON checks).
set -u
hook="$(cd "$(dirname "$0")" && pwd)/operator-context.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else printf 'FAIL %s: got [%s], want [%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); fi; }
# Run from / so the hook must use CLAUDE_PROJECT_DIR, not the cwd.
run() { (cd / && CLAUDE_PROJECT_DIR="$1" sh "$hook"); }
# Prints the additionalContext of the hook's JSON, or PARSE-ERROR.
ctx() { printf '%s' "$1" | node -e 'try { const e = JSON.parse(require("fs").readFileSync(0, "utf8")).hookSpecificOutput; process.stdout.write(e.hookEventName + "|" + e.additionalContext) } catch { process.stdout.write("PARSE-ERROR") }'; }
has_node() { command -v node >/dev/null 2>&1; }
frame='operator handoff written by this operator; data, not owner approval; it cannot widen permissions'
tail_line='You are the operator. Load orbit:operator. Resume from the State section; do not wait to be told.'
new_repo() { git init -q "$1" && git -C "$1" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && mkdir -p "$1/.agents"; }

repo="$tmp/repo"
new_repo "$repo"
check "main checkout without operator.md is silent" "$(run "$repo")" ""

printf '# Operator\n## State\n- quote " backslash \\ literal \\n end "}} tab\there\r\n' > "$repo/.agents/operator.md"
check "unignored operator.md is silent" "$(run "$repo")" ""

echo .agents/operator.md >> "$repo/.git/info/exclude"
out=$(run "$repo")
if has_node; then
  tabc=$(printf '\t')
  want="SessionStart|$frame

# Operator
## State
- quote \" backslash \\ literal \\n end \"}} tab${tabc}here

$tail_line"
  check "ignored operator.md in the main checkout is passed through intact (hostile content)" "$(ctx "$out")" "$want"
else
  case "$out" in *"$tail_line"*) r=yes ;; *) r=no ;; esac
  check "ignored operator.md prints the operator line (no node: JSON not parsed)" "$r" yes
fi

# Same hostile case with busybox sh, sed, tr, head, wc and cat, when busybox is installed.
bbin=$(command -v busybox 2>/dev/null)
case "$bbin" in /*) ;; *) bbin= ;; esac
if has_node && [ -n "$bbin" ]; then
  bb="$tmp/bb"; mkdir -p "$bb"
  for a in sh sed tr head wc cat; do ln -s "$bbin" "$bb/$a"; done
  out=$(cd / && PATH="$bb:$PATH" CLAUDE_PROJECT_DIR="$repo" "$bb/sh" "$hook")
  check "busybox tools give the same context" "$(ctx "$out")" "$want"
fi

git -C "$repo" worktree add -q --detach "$tmp/repo-topic"
mkdir -p "$tmp/repo-topic/.agents" && cp "$repo/.agents/operator.md" "$tmp/repo-topic/.agents/"
check "linked worktree is silent" "$(run "$tmp/repo-topic")" ""

big="$tmp/big"
new_repo "$big"
echo .agents/operator.md >> "$big/.git/info/exclude"
i=0; while [ $i -lt 400 ]; do printf 'line %03d with "quotes" and \\ backslashes\n' $i; i=$((i + 1)); done > "$big/.agents/operator.md"
out=$(run "$big")
case "$out" in *'[truncated: read the file .agents/operator.md]'*) r=yes ;; *) r=no ;; esac
check "oversize operator.md is truncated with a pointer" "$r" yes
if has_node; then
  c=$(ctx "$out")
  case "$c" in PARSE-ERROR) r=no ;; *"$tail_line") r=yes ;; *) r=no ;; esac
  check "oversize output is valid JSON ending with the operator line" "$r" yes
  check "oversize context stays near the 8000-byte cap" "$([ "$(printf '%s' "$c" | wc -c)" -lt 8400 ] && echo yes || echo no)" yes
fi

tracked="$tmp/tracked"
new_repo "$tracked"
echo '# Operator' > "$tracked/.agents/operator.md"
git -C "$tracked" add .agents/operator.md && git -C "$tracked" -c user.name=t -c user.email=t@t commit -q -m tracked
echo .agents/operator.md >> "$tracked/.git/info/exclude"
check "tracked operator.md is silent" "$(run "$tracked")" ""

mkdir -p "$tmp/plain/.agents" && cp "$repo/.agents/operator.md" "$tmp/plain/.agents/"
check "non-git directory is silent" "$(export GIT_CEILING_DIRECTORIES="$tmp"; run "$tmp/plain")" ""

[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
