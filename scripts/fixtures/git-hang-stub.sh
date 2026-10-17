#!/bin/sh
# Test stub for git (unattended.test.mjs, #16 finding 5): ignores SIGTERM and leaves a grandchild holding stdout, like an ssh
# that never answers. Records the grandchild's pid in $GIT_STUB_PIDS.
trap '' TERM
sleep 30 &
[ -n "$GIT_STUB_PIDS" ] && echo "$!" >> "$GIT_STUB_PIDS"
sleep 30
