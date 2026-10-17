#!/bin/sh
# Self-test of plugin-validate.sh (part of make vet, #24): fixture plugins made in a temp dir. The clean one (with the
# known CLAUDE.md warning) passes; one with a planted unknown warning and one with an error both fail.
script=$(pwd -P)/ci/scripts/plugin-validate.sh
d=$(mktemp -d) || exit 1
trap 'rm -rf "$d"' EXIT
fixture() { # <name> <plugin.json text>
  mkdir -p "$d/$1/.claude-plugin" || exit 1
  printf '%s\n' "$2" >"$d/$1/.claude-plugin/plugin.json"
  printf '%s\n' '{ "name": "fx-market", "owner": { "name": "A" }, "description": "fixture", "plugins": [ { "name": "fx", "source": "./", "description": "fixture" } ] }' >"$d/$1/.claude-plugin/marketplace.json"
  echo "working notes" >"$d/$1/CLAUDE.md"
}
fixture clean '{ "name": "fx", "version": "1.0.0", "description": "fixture", "author": { "name": "A" }, "license": "MIT" }'
fixture warning '{ "name": "fx", "version": "1.0.0", "description": "fixture", "author": { "name": "A" }, "license": "MIT", "frobnicate": 1 }'
fixture error '{ "name": "fx", "version": "1.0.0"'
rc=0
sh "$script" "$d/clean" || { echo "plugin-validate.test.sh:1 the clean fixture failed"; rc=1; }
sh "$script" "$d/warning" && { echo "plugin-validate.test.sh:1 a planted unknown warning passed"; rc=1; }
sh "$script" "$d/error" && { echo "plugin-validate.test.sh:1 a plugin.json error passed"; rc=1; }
# A warning printed in another form (no "Found N warning" line) fails too: a stub claude prints one. The toolbox's /tmp
# is noexec, so the stub lives in ci/out (writable, ignored by git).
mkdir -p ci/out && b=$(mktemp -d ci/out/plugin-validate-test.XXXXXX) || exit 1
trap 'rm -rf "$d" "$b"' EXIT
printf '#!/bin/sh\necho "Validating plugin manifest: x"\necho "warning: frobnicate is deprecated"\necho "✔ Validation passed"\n' >"$b/claude" && chmod +x "$b/claude" || exit 1
PATH="$(pwd -P)/$b:$PATH" sh "$script" "$d/clean" && { echo "plugin-validate.test.sh:1 a warning in another form passed"; rc=1; }
exit $rc
