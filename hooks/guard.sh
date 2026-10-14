#!/bin/sh
# PreToolUse hook: OPR-01 and DEC-08 (hooks/guard.mjs). Without node it stays silent, except for a session that
# declares itself the operator with ORBIT_ROLE=operator: that one fails closed.
if ! command -v node >/dev/null 2>&1; then
  [ "$ORBIT_ROLE" = operator ] && { echo "OPR-01: node is missing, so the orbit guard denies the operator's tool call." >&2; exit 2; }
  exit 0
fi
exec node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs"
