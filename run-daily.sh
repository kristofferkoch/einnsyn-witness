#!/usr/bin/env bash
# Daily einnsyn-witness run. Installed via crontab (see README). Runs the witness,
# commits the snapshot if one was written, so the cadence never depends on an
# operator remembering. Logs to last_run.txt are written by witness.mjs itself.
set -euo pipefail
cd "$(dirname "$0")"
export WITNESS_HOST_TAG="${WITNESS_HOST_TAG:-vm}"   # per-host snapshot subtree; overrides for manual runs
# Pre-run integrity gate: the state union is a claim about the snapshots.
# If either side was edited since the last run, the replay root mismatches
# and the run refuses to proceed (exit 1) rather than fold tainted input.
node witness.mjs --verify-union || { echo "union verify FAILED — refusing to run" >&2; exit 1; }
OUT="$(node witness.mjs 2>&1)" || { echo "$OUT" >&2; exit 1; }
echo "$OUT" >&2
if echo "$OUT" | grep -q "Snapshot saved"; then
  git add -A
  git commit -q -m "witness: automated daily run $(date -u +%F)" || true
fi
