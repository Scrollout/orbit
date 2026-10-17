#!/bin/sh
# make sast: Opengrep and Checkov over the tree, offline (in-toolbox.sh runs the toolbox with --network none), then the
# baseline ci/sast-baseline.json. Results: ci/out/sast-opengrep.{json,sarif}, ci/out/checkov/results_{json.json,sarif.sarif}.
. ci/scripts/lib.sh
start sast
rm -rf "$OUT/sast-opengrep.json" "$OUT/sast-opengrep.sarif" "$OUT/checkov"

opengrep_scan() {
  opengrep scan --config /opt/opengrep-rules --taint-intrafile --disable-version-check \
    --json-output="$OUT/sast-opengrep.json" --sarif-output="$OUT/sast-opengrep.sarif" .
}
# Secrets are gitleaks' (make security); Checkov runs only the frameworks of the files this repo has.
checkov_scan() {
  checkov --directory . --framework dockerfile github_actions --skip-download --soft-fail \
    --output json --output sarif --output-file-path "$OUT/checkov"
}

check opengrep opengrep "$OPENGREP_VERSION" opengrep_scan
check checkov checkov "$CHECKOV_VERSION" checkov_scan
check baseline node "$(node -v)" node ci/scripts/sast-baseline.mjs "$OUT/sast-opengrep.json" "$OUT/checkov/results_json.json"
# On a failure the whole baseline log goes to the console (lib.sh shows only its tail): every finding and the proposed
# baseline, so the baseline can be written from the CI log. $status is the last check's (lib.sh).
# shellcheck disable=SC2154
[ "$status" = pass ] || cat "$OUT/sast.baseline.log"
finish
