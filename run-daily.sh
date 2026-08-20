#!/usr/bin/env bash
# Daily einnsyn-witness run. Installed via crontab (see README). Runs the witness,
# commits the snapshot if one was written, so the cadence never depends on an
# operator remembering. Logs to last_run.txt are written by witness.mjs itself.
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(node witness.mjs 2>&1)" || { echo "$OUT" >&2; exit 1; }
echo "$OUT" >&2
if echo "$OUT" | grep -q "Snapshot saved"; then
  git add -A
  git commit -q -m "witness: automated daily run $(date -u +%F)" || true
fi
