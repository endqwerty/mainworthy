#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec 9>.run.lock
if ! flock -n 9; then
  printf '%s\n' 'Another Rust candidate benchmark is already running.' >&2
  exit 75
fi
export RUSTUP_HOME=/home/endqwerty/.cache/mainworthy-arena/toolchains/rust/rustup
export CARGO_HOME=/home/endqwerty/.cache/mainworthy-arena/toolchains/rust/cargo
export PATH="$CARGO_HOME/bin:$PATH"
export TMPDIR="$PWD/tmp"
mkdir -p "$TMPDIR"
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "$TMPDIR/rustup.sh"
  sh "$TMPDIR/rustup.sh" -y --no-modify-path --profile minimal --default-toolchain stable
fi
python3 build.py
python3 benchmark.py
python3 - <<'PY'
import json
from pathlib import Path
p=Path('results.json');result=json.loads(p.read_text())
result['extras']['build']=json.loads(Path('build-metadata.json').read_text())
p.write_text(json.dumps(result,indent=2)+'\n')
print('results.json written; errors=',result['extras'].get('overall_errors'))
if result['extras'].get('overall_errors',0):raise SystemExit(1)
PY
