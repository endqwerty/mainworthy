#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
source ./env.sh
shared=/home/endqwerty/.cache/mainworthy-arena/stack
driver=$(cat selected-driver.txt 2>/dev/null || printf cgo)
binary="./mainworthy-$driver"
rebuild=false
if ! test -x "$binary"; then rebuild=true; fi
for source in *.go go.mod go.sum; do
  if test "$source" -nt "$binary"; then rebuild=true; fi
done
if "$rebuild"; then
  bash ./build.sh "$driver"
fi
cp "$shared/queries.txt" queries.txt
reset_sqlite() {
  python3 - <<'PY'
from pathlib import Path
for name in ("work.db", "work.db-wal", "work.db-shm"):
    Path(name).unlink(missing_ok=True)
PY
  cp --reflink=auto "$shared/seed.db" work.db
}
reset_pg() {
  psql -X -h 127.0.0.1 -p 54329 -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c 'drop database if exists cb_go' -c 'create database cb_go template cb_seed'
}
start=$SECONDS
python3 - <<'PY'
from pathlib import Path
Path("results.json").unlink(missing_ok=True)
PY
reset_sqlite
MAINWORTHY_DB="$PWD/work.db" "$binary" selfcheck > checks-embedded.txt
reset_sqlite
"$binary" bench --mode embedded --db "$PWD/work.db" --queries queries.txt --out embedded.json
reset_pg
MAINWORTHY_MODE=server "$binary" selfcheck > checks-server.txt
reset_pg
"$binary" bench --mode server --queries queries.txt --out server.json
python3 ./proof.py "$binary"
python3 ./combine.py "$((SECONDS-start))"
