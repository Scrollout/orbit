#!/bin/sh
# Runs one command in the CI toolbox image, for make only (ci/README.md). The repository is mounted read-only at its
# host path; only ci/out (the report) and a tmpfs /tmp are writable. No network, no capabilities, no secrets, no
# docker socket; the container runs as the calling user. Inside the toolbox already (CI_TOOLBOX set by the image)
# the command runs directly.
# Usage: ci/scripts/in-toolbox.sh <command> [args...], from the repository root; CI_IMAGE is set by make.
[ -n "${CI_TOOLBOX:-}" ] && exec "$@"
image=${CI_IMAGE:?in-toolbox.sh: CI_IMAGE is not set; run it through make}
command -v docker >/dev/null 2>&1 || { echo "in-toolbox.sh: docker is required" >&2; exit 1; }
root=$(pwd -P)
mkdir -p "$root/ci/out" || exit 1
set -- "$image" "$@"
# A worktree keeps its git directory outside the repository: mount it too, read-only, so git works inside.
gitdir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
case $gitdir in "" | "$root" | "$root"/*) ;; *) set -- -v "$gitdir:$gitdir:ro" "$@" ;; esac
exec docker run --rm --init -u "$(id -u):$(id -g)" --network none --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp -e HOME=/tmp -v "$root:$root:ro" -v "$root/ci/out:$root/ci/out" -w "$root" "$@"
