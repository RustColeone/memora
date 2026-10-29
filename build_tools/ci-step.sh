#!/usr/bin/env bash
# Run one CI step; if it fails, put its error lines and the end of its output
# into the job's error annotation, where they show on the run page without
# opening the full log. GitHub keeps only the first ~4 KB of an annotation.
#   bash build_tools/ci-step.sh "<title>" <command> [args...]
title="$1"; shift
log="$(mktemp)"
export PYTHONUNBUFFERED=1
"$@" > >(tee "$log") 2>&1
rc=$?
wait
if [ $rc -ne 0 ]; then
  {
    grep -n -E -A6 "Traceback|FAIL|✘|Error:|ERR!|AssertionError|error:|failed" "$log" | grep -v "npm warn" | head -c 2400
    echo; echo "… end of output:"
    tail -c 1200 "$log"
  } | tr -d '\r' | sed 's/%/%25/g' | awk 'BEGIN{ORS="%0A"} {print}' > "$log.msg"
  echo "::error title=$title failed (exit $rc)::$(cat "$log.msg")"
fi
exit $rc
