#!/usr/bin/env bash
set -euo pipefail
candidate_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$candidate_dir"
if [[ ! -d node_modules ]]; then NODE_ENV=development bun install --frozen-lockfile --cache-dir "$candidate_dir/bun-cache"; fi
export NODE_ENV=production
export PORT="${CB_HTTP_PORT:-30462}"
trap 'if [[ -f embedded.json && -f server.json && -f registry-proof.json && -f build-metrics.json && -f driver-choice.json ]]; then bun src/aggregate.ts; fi' EXIT
bun run check
bun src/build-metrics.ts
psql -X -h 127.0.0.1 -p 54329 -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'drop database if exists cb_ts' -c 'create database cb_ts template cb_seed'
bun src/driver-choice.ts
export PG_DRIVER="$(<selected-driver.txt)"
for dataset_path in work.db work.db-wal work.db-shm; do if [[ -f "$dataset_path" ]]; then unlink "$dataset_path"; fi; done
cp ../seed.db work.db
MODE=embedded RUNTIME=bun bun src/bench.ts
psql -X -h 127.0.0.1 -p 54329 -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'drop database if exists cb_ts' -c 'create database cb_ts template cb_seed'
MODE=server RUNTIME=bun bun src/bench.ts
bun src/registry-proof.ts
if [[ "${CB_EXTRAS:-0}" == 1 ]]; then
  for dataset_path in node-work.db node-work.db-wal node-work.db-shm; do if [[ -f "$dataset_path" ]]; then unlink "$dataset_path"; fi; done
  cp ../seed.db node-work.db
  MODE=embedded RUNTIME=node DB_PATH=node-work.db PORT=30454 SKIP_MIX=1 RESULT_FILE=node.json node dist/node-bench.js
  if [[ -f src/pglite-extra.ts ]]; then bun src/pglite-extra.ts; fi
fi
bun src/aggregate.ts
