# shellcheck shell=sh
# Sourced by vet.sh, quality.sh, security.sh. Provides:
#   start <target>                      truncates ci/out/<target>.jsonl
#   check <name> <tool> <version> <cmd...>   runs the command, keeps its full output in ci/out/<target>.<name>.log
#                                       (capped, ci/scripts/record.mjs), records one JSON line, prints a pass/fail line
#                                       and, on failure, the tail of the log; a failure does not stop the target
#   skip <name> <tool> <version> <why>  records a skipped check
#   finish                              prints the target's totals; exit 1 if any check failed
OUT=ci/out
fails=0
start() { target=$1; mkdir -p "$OUT"; : >"$OUT/$target.jsonl"; }
check() {
  name=$1 tool=$2 version=$3; shift 3
  log=$OUT/$target.$name.log; t0=$(date +%s)
  if "$@" >"$log" 2>&1; then status=pass; else status=fail; fails=$((fails + 1)); fi
  node ci/scripts/record.mjs "$OUT/$target.jsonl" "$target" "$name" "$tool" "$version" "$status" "$(($(date +%s) - t0))" "$log"
  echo "$target/$name: $status"
  [ "$status" = pass ] || { echo "--- tail of $log"; tail -n 20 "$log"; echo "---"; }
}
skip() {
  node ci/scripts/record.mjs "$OUT/$target.jsonl" "$target" "$1" "$2" "$3" skipped 0 /dev/null "$4"
  echo "$target/$1: skipped ($4)"
}
finish() { if [ "$fails" -eq 0 ]; then echo "$target: PASS"; else echo "$target: FAIL ($fails failed)"; return 1; fi; }
