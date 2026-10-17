#!/bin/sh
echo "$*" >> "$GH_LOG"
[ -f "$GH_STUB/delay" ] && sleep "$(cat "$GH_STUB/delay")"
case "$*" in
  auth*) k=auth ;; *issueTypes*) k=types ;; *projectsV2*) k=projects ;; */labels*) k=labels ;; */milestones*) k=milestones ;; *) k=repo ;;
esac
[ -f "$GH_STUB/$k.out" ] || exit 1
cat "$GH_STUB/$k.out"
exit "$(cat "$GH_STUB/$k.code")"
