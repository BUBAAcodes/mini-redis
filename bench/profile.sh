#!/usr/bin/env bash
# Profiles the built server under redis-benchmark load (spec 18's optimisation step) and
# prints the hottest functions. No Docker: the server and the local redis-benchmark talk over
# loopback, so the profile shows our code, not the container network.
#
#   bash bench/profile.sh                 # profile, then print the top functions
#   PROFILE=0 RUNS=3 bash bench/profile.sh  # no profiler: median ops/sec of 3 runs (before/after)
#
# Open the .cpuprofile in Chrome DevTools (Performance → Load profile) for the flame chart.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-6391}
N=${N:-1000000}
P=${P:-16}
T=${T:-ping_mbulk,set,get,incr,lpush,hset,mset}
RUNS=${RUNS:-1}
PROFILE=${PROFILE:-1}
OUT=${OUT:-bench/profiles}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

npm run build > /dev/null
mkdir -p "$OUT"
flags=()
[[ $PROFILE == 1 ]] && flags=(--cpu-prof --cpu-prof-dir="$OUT")

node "${flags[@]}" dist/index.js --port "$PORT" --dir "$WORK" \
  --appendonly yes --appendfsync everysec --save "" > "$WORK/server.log" 2>&1 &
SERVER=$!
for _ in $(seq 50); do redis-cli -p "$PORT" ping > /dev/null 2>&1 && break; sleep 0.1; done

for run in $(seq "$RUNS"); do
  redis-cli -p "$PORT" flushall > /dev/null
  redis-benchmark -p "$PORT" -n "$N" -c 50 -P "$P" -t "$T" --csv > "$WORK/run-$run.csv"
done

kill -TERM "$SERVER"
wait "$SERVER" || true

# Median rps per test across the runs.
npx tsx -e "
import { readFileSync } from 'node:fs';
import { parseBenchmarkCsv } from './bench/report.ts';
const runs = Array.from({ length: $RUNS }, (_, i) => parseBenchmarkCsv(readFileSync('$WORK/run-' + (i + 1) + '.csv', 'utf8')));
console.log('| Test | median ops/s | p50 ms | runs |');
console.log('| --- | ---: | ---: | --- |');
for (const name of runs[0].keys()) {
  const rows = runs.map((r) => r.get(name)).filter((r) => r !== undefined && r.rps > 0);
  const mid = [...rows].sort((a, b) => a.rps - b.rps)[Math.floor(rows.length / 2)];
  console.log('| ' + name + ' | ' + Math.round(mid.rps).toLocaleString('en-US') + ' | ' + mid.p50.toFixed(3) + ' | ' + rows.map((r) => Math.round(r.rps / 1000) + 'k').join(', ') + ' |');
}
"

if [[ $PROFILE == 1 ]]; then
  latest=$(ls -t "$OUT"/*.cpuprofile | head -1)
  echo "Profile: $latest"
  npx tsx bench/profile-top.ts "$latest" 25
fi
