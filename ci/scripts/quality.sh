#!/bin/sh
# make quality: the plugin's own tests, then eslint. Runs inside the toolbox.
. ci/scripts/lib.sh
start quality
check eslint eslint "$ESLINT_VERSION" /opt/ci/node_modules/.bin/eslint -c /opt/ci/eslint.config.mjs -f /opt/ci/eslint-format.mjs --no-warn-ignored .
check npm-test npm "$(npm -v)" npm test
finish
