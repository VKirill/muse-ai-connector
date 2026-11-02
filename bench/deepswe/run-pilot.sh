#!/bin/bash
# Run a DeepSWE v1.1 pilot on ovh-main with Muse as the agent.
# N=<tasks> SEED=<seed> bash run-pilot.sh
set -euo pipefail

N=${N:-10}
SEED=${SEED:-0}
BENCH=${MUSE_BENCH_DIR:-/srv/muse-bench}
KIT=$(cd "$(dirname "$0")" && pwd)
OUT="$BENCH/runs/$(date -u +%Y%m%d-%H%M%S)"

mkdir -p "$OUT"
echo "pier output: $OUT"
PYTHONPATH="$KIT${PYTHONPATH:+:$PYTHONPATH}" exec pier run \
  -p "$BENCH/deep-swe/tasks" \
  --agent-import-path muse_agent:MuseAgent \
  --n-tasks "$N" \
  --sample-seed "$SEED" \
  -o "$OUT"
