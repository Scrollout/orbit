#!/bin/sh
# make vet: static checks, cheapest first, none stops the others. Runs inside the toolbox.
. ci/scripts/lib.sh
start vet
node_check() {
  rc=0
  for f in $(git ls-files -- '*.mjs'); do
    if ! out=$(node --check "$f" 2>&1); then echo "$f:1 $(echo "$out" | head -1)"; rc=1; fi
  done
  return $rc
}
json_check() { git ls-files -- '*.json' | xargs node ci/scripts/check-json.mjs; }
# SC2015 is excluded: hooks/operator-context.test.sh:82 trips it on main (a plugin file this change does not touch).
# Remove the -e when that line is fixed; every other shellcheck finding fails.
check shellcheck shellcheck "$SHELLCHECK_VERSION" sh -c 'git ls-files -- "*.sh" | xargs shellcheck -f gcc -e SC2015'
check node-syntax node "$(node -v)" node_check
check json-valid node "$(node -v)" json_check
check actionlint actionlint "$ACTIONLINT_VERSION" sh -c 'git ls-files -- ".github/workflows/*.yml" "templates/*.yml" | xargs actionlint -oneline'
check hadolint hadolint "$HADOLINT_VERSION" hadolint --no-color ci/Dockerfile
check report-test node "$(node -v)" node ci/scripts/report.test.mjs
finish
