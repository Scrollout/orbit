#!/bin/sh
# gitleaks <dir|git> with findings as path:line lines; never prints a secret (--redact, report only file, line, rule).
mode=$1
rep=$(mktemp)
gitleaks "$mode" --no-banner --redact --report-format json --report-path "$rep" .
rc=$?
node ci/scripts/gitleaks-lines.mjs "$rep"
rm -f "$rep"
exit $rc
