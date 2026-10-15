#!/bin/sh
# gitleaks <dir|git> with findings as path:line lines; never prints a secret (--redact, report only file, line, rule).
mode=$1
rep=$(mktemp)
gitleaks "$mode" --no-banner --redact --report-format json --report-path "$rep" .
rc=$?
lines=$(node ci/scripts/gitleaks-lines.mjs "$rep")
[ -z "$lines" ] || printf '%s\n' "$lines"
rm -f "$rep"
# A failure with no finding to show: gitleaks died before writing a report (or wrote none we can read).
if [ "$rc" -ne 0 ] && [ -z "$lines" ]; then echo "gitleaks.sh:1 gitleaks failed before writing a report, exit $rc"; fi
exit $rc
