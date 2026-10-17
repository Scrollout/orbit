#!/bin/sh
# UserPromptSubmit hook: /orbit:unattended (hooks/unattended.mjs). Without node it stays silent: the command then reaches the
# model, whose command file says no go opened (nothing else writes the go state).
command -v node >/dev/null 2>&1 || exit 0
exec node "${CLAUDE_PLUGIN_ROOT}/hooks/unattended.mjs"
