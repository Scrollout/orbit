#!/bin/sh
# Self-test of tracked() in lib.sh (part of make vet): the reason must reach stderr.
. ci/scripts/lib.sh
rc=0
out=$(tracked '*.sh' 2>&1) && [ -n "$out" ] || { echo "lib.test.sh:1 tracked '*.sh' found nothing"; rc=1; }
err=$(tracked '*.no-such-extension' 2>&1 >/dev/null) && { echo "lib.test.sh:1 tracked on an empty class succeeded"; rc=1; }
case $err in *"no tracked files for"*) ;; *) echo "lib.test.sh:1 no reason on stderr: '$err'"; rc=1 ;; esac
err=$(cd / && tracked '*.sh' 2>&1 >/dev/null) && { echo "lib.test.sh:1 tracked outside a repository succeeded"; rc=1; }
case $err in *"git ls-files failed"*) ;; *) echo "lib.test.sh:1 no git failure reason on stderr: '$err'"; rc=1 ;; esac
exit $rc
