#!/bin/sh
# make security: secrets in the tree and in the history, eslint-plugin-security, dependency audit. Runs inside the toolbox.
. ci/scripts/lib.sh
start security
check gitleaks-tree gitleaks "$GITLEAKS_VERSION" sh ci/scripts/gitleaks.sh dir
check gitleaks-history gitleaks "$GITLEAKS_VERSION" sh ci/scripts/gitleaks.sh git
check eslint-security eslint-plugin-security "$ESLINT_PLUGIN_SECURITY_VERSION" node ci/scripts/eslint-baseline.mjs security
if node -e 'const p=require("./package.json");process.exit(Object.keys({...p.dependencies,...p.devDependencies}).length?1:0)'; then
  skip npm-audit npm "$(npm -v)" "package.json has no dependencies; the audit runs without network only on a lockfile"
else
  check npm-audit npm "$(npm -v)" sh -c 'echo "package.json now has dependencies: add a lockfile and a networked audit step (ci/README.md)"; exit 1'
fi
finish
