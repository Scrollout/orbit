#!/bin/sh
# make quality: eslint, tsc, then the plugin's own tests. Runs inside the toolbox.
. ci/scripts/lib.sh
start quality
check eslint eslint "$ESLINT_VERSION" node ci/scripts/eslint-baseline.mjs quality
check tsc tsc "$TYPESCRIPT_VERSION" node ci/scripts/tsc-baseline.mjs
check npm-test npm "$(npm -v)" npm test
finish
