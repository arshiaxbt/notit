#!/usr/bin/env bash
# Render stills of a composition at the given frames: scripts/stills.sh <Composition> <frame> [frame...]
# Stills land in stills/<Composition>-<frame>.jpg at half size, for a quick look.
set -euo pipefail
cd "$(dirname "$0")/.."
export TMPDIR="$PWD/.cache/tmp"; mkdir -p "$TMPDIR"
comp="$1"; shift
for f in "$@"; do
  npx remotion still "$comp" "stills/$comp-$(printf %04d "$f").jpg" --frame="$f" --scale="${SCALE:-0.5}" --image-format=jpeg --jpeg-quality=85 --log=error &
  # at most 3 at once
  while [ "$(jobs -r | wc -l)" -ge 3 ]; do sleep 0.2; done
done
wait
