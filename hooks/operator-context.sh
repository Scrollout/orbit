#!/bin/sh
# SessionStart hook: in the main checkout (not a linked worktree), when .agents/operator.md exists,
# hand it to the session as additionalContext so the operator resumes after startup, resume or compaction.
# Silent otherwise.
file="${CLAUDE_PROJECT_DIR:-.}/.agents/operator.md"
[ -f "$file" ] || exit 0
git_dir=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
[ "$git_dir" = "$common_dir" ] || exit 0
{
  cat "$file"
  printf '\n\nYou are the operator. Load orbit:operator. Resume from the State section; do not wait to be told.\n'
} | tr -d '\000-\010\013\014\016-\037' | awk '
  BEGIN { ORS = ""; print "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"" }
  { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, "\\t"); gsub(/\r/, ""); if (NR > 1) print "\\n"; print }
  END { print "\"}}\n" }'
