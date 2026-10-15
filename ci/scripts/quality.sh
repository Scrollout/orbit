#!/bin/sh
# make quality: eslint, then the plugin's own tests. Runs inside the toolbox.
. ci/scripts/lib.sh
start quality
check eslint eslint "$ESLINT_VERSION" node ci/scripts/eslint-baseline.mjs quality
check npm-test npm "$(npm -v)" npm test
finish
