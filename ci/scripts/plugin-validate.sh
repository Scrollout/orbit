#!/bin/sh
# make plugin-validate (also a check of make vet): `claude plugin validate` from the toolbox's pinned Claude Code,
# offline and without auth (#23), on `.` (with a marketplace.json present, 2.1.288 validates only the marketplace there)
# and on the plugin manifest (plugin.json, hooks, components). Fails on an exit status, a run without its pass line,
# and any warning but the known one: CLAUDE.md at the plugin root is not loaded as context (the repo's working notes).
# Usage: plugin-validate.sh [plugin root, default .]; plugin-validate.test.sh runs it on fixtures (#24).
cd "${1:-.}" || exit 1
KNOWN='root: CLAUDE.md at the plugin root is not loaded as project context'
rc=0
for target in . .claude-plugin/plugin.json; do
  out=$(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude plugin validate "$target" 2>&1); st=$?
  printf '%s\n' "$out"
  [ "$st" -eq 0 ] || { echo "plugin-validate $target: exit status $st" >&2; rc=1; }
  printf '%s\n' "$out" | grep -q 'Validation passed' || { echo "plugin-validate $target: no pass line" >&2; rc=1; }
  # Every "Found N warning(s)" counts; all of them must be the known line.
  total=$(printf '%s\n' "$out" | awk '/Found [0-9]+ warning/ { for (i = 1; i < NF; i++) if ($i == "Found") n += $(i + 1) } END { print n + 0 }')
  known=$(printf '%s\n' "$out" | grep -c -F "$KNOWN")
  [ "$total" -eq "$known" ] || { echo "plugin-validate $target: $total warning(s), $known of them the known CLAUDE.md one" >&2; rc=1; }
  # A warning in another form fails too (#24): every non-empty line is one of the shapes 2.1.288 prints for a passing
  # run or the known warning.
  odd=$(printf '%s\n' "$out" | grep -v -E -e '^[[:space:]]*$' -e '^Validating [a-z ]+: ' -e '^⚠ Found 1 warning:$' \
    -e "^  ❯ $KNOWN\\." -e '^✔ Validation passed( with warnings)?$' | head -1)
  [ -z "$odd" ] || { echo "plugin-validate $target: a line it does not know: $odd" >&2; rc=1; }
done
exit $rc
