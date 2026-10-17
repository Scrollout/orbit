#!/bin/sh
# make sast: Opengrep and Checkov over the tree, offline (in-toolbox.sh runs the toolbox with --network none), then the
# baseline ci/sast-baseline.json. Results: ci/out/sast-opengrep.{json,sarif}, ci/out/checkov/results_{json.json,sarif.sarif}.
. ci/scripts/lib.sh
start sast
rm -rf "$OUT/sast-opengrep.json" "$OUT/sast-opengrep.sarif" "$OUT/checkov"
# Opengrep and Checkov are Python inside; the image has an ASCII locale and the rule files hold UTF-8 (Opengrep crashed
# with UnicodeDecodeError reading them). C.UTF-8 is built into Debian bookworm's libc.
export PYTHONUTF8=1 LC_ALL=C.UTF-8

# The scope is set here and in ci/sast-baseline.json only: these files, read by Opengrep or Checkov from the scanned
# tree, could drop paths, rules or checks with no baseline entry and no reason, so any of them present or tracked fails.
scope_check() {
  rc=0
  for f in .semgrepignore .semgrep.yml .semgrep.yaml .checkov.yaml .checkov.yml .checkov.baseline; do
    hits=$(git ls-files -- ":(glob)**/$f") || return 1
    if [ -e "$f" ] || [ -n "$hits" ]; then
      echo "${hits:-$f}:1 $f would set the SAST scope from the scanned tree (ci/README.md, SAST); remove it, use ci/sast-baseline.json"
      rc=1
    fi
  done
  return $rc
}

opengrep_scan() {
  opengrep scan --config /opt/opengrep-rules --taint-intrafile --disable-nosem --disable-version-check \
    --json-output="$OUT/sast-opengrep.json" --sarif-output="$OUT/sast-opengrep.sarif" .
}
# Secrets are gitleaks' (make security); Checkov runs only the frameworks of the files this repo has.
checkov_scan() {
  checkov --directory . --framework dockerfile github_actions --skip-download --soft-fail \
    --output json --output sarif --output-file-path "$OUT/checkov"
}

check scope git "$(git --version | cut -d' ' -f3)" scope_check
check opengrep opengrep "$OPENGREP_VERSION" opengrep_scan
check checkov checkov "$CHECKOV_VERSION" checkov_scan
check baseline node "$(node -v)" node ci/scripts/sast-baseline.mjs "$OUT/sast-opengrep.json" "$OUT/checkov/results_json.json"
# On a failure the whole baseline log goes to the console (lib.sh shows only its tail): every finding and the proposed
# baseline, so the baseline can be written from the CI log. $status is the last check's (lib.sh).
# shellcheck disable=SC2154
[ "$status" = pass ] || cat "$OUT/sast.baseline.log"
finish
