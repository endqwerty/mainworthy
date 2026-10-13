#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
source ./env.sh
if test -n "${MAINWORTHY_BUILD_CACHE:-}"; then export GOCACHE="$MAINWORTHY_BUILD_CACHE"; fi
driver=${1:-cgo}
case "$driver" in
  cgo)
    export CGO_ENABLED=1
    go build -trimpath -tags 'sqlite_fts5 sqlite_omit_load_extension netgo osusergo' \
      -ldflags '-s -w -linkmode external -extldflags -static' -o mainworthy-cgo .
    ;;
  pure)
    export CGO_ENABLED=0
    go build -trimpath -tags purego -ldflags '-s -w' -o mainworthy-pure .
    ;;
  *) exit 2 ;;
esac
