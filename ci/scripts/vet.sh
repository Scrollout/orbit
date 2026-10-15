#!/bin/sh
# make vet: static checks, cheapest first, none stops the others. Runs inside the toolbox.
. ci/scripts/lib.sh
start vet

shell_check() {
  files=$(tracked '*.sh') || return 1
  # SC2015 is excluded for this one file, which trips it on main (reported, Scrollout/orbit#3); remove when fixed.
  others=$(printf '%s\n' "$files" | grep -vx 'hooks/operator-context.test.sh')
  rc=0
  printf '%s\n' "$others" | xargs shellcheck -f gcc || rc=1
  shellcheck -f gcc -e SC2015 hooks/operator-context.test.sh || rc=1
  return $rc
}
node_check() {
  files=$(tracked '*.mjs') || return 1
  rc=0
  for f in $files; do
    if ! out=$(node --check "$f" 2>&1); then echo "$f:1 $(echo "$out" | head -1)"; rc=1; fi
  done
  return $rc
}
json_check() { files=$(tracked '*.json') || return 1; echo "$files" | xargs node ci/scripts/check-json.mjs; }
yaml_lint() { files=$(tracked '.github/workflows/*.yml' 'templates/*.yml') || return 1; echo "$files" | xargs actionlint -oneline; }

check shellcheck shellcheck "$SHELLCHECK_VERSION" shell_check
check node-syntax node "$(node -v)" node_check
check json-valid node "$(node -v)" json_check
check actionlint actionlint "$ACTIONLINT_VERSION" yaml_lint
check hadolint hadolint "$HADOLINT_VERSION" hadolint --no-color ci/Dockerfile
check lib-test sh "posix" sh ci/scripts/lib.test.sh
check report-test node "$(node -v)" node ci/scripts/report.test.mjs
finish
