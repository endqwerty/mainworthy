#!/bin/sh
set -eu
case "${MAINWORTHY_LOCKDOWN:-0}" in
  0) exec /usr/local/bin/mainworthy "$@" ;;
  1) ;;
  *) echo 'MAINWORTHY_LOCKDOWN must be 0 or 1' >&2; exit 1 ;;
esac
if [ "${1:-}" != health ]; then
  policy=/usr/local/share/mainworthy/lockdown.nft
  transaction=$(mktemp)
  trap 'rm -f "$transaction"' EXIT HUP INT TERM
  {
    echo 'add table inet mainworthy_lockdown'
    echo 'delete table inet mainworthy_lockdown'
    cat "$policy"
  } > "$transaction"
  nft --check --file "$transaction"
  nft --file "$transaction"
  nft --stateless list table inet mainworthy_lockdown > "$transaction"
  cmp "$policy" "$transaction"
  rm -f "$transaction"
  trap - EXIT HUP INT TERM
fi
exec setpriv --reuid=10001 --regid=10001 --clear-groups \
  --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
  /usr/local/bin/mainworthy "$@"
