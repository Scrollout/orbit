#!/bin/sh
# PostToolUse hook: append push events to the session ledger (hooks/capture.mjs). Fail-open: no node, no
# profile, no git or any error means exit 0 and no event, and the tool call is never blocked.
command -v node >/dev/null 2>&1 || exit 0
node "${CLAUDE_PLUGIN_ROOT}/hooks/capture.mjs" >/dev/null 2>&1
exit 0
