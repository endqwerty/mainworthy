#!/bin/sh
set -eu
case "${MAINWORTHY_LOCKDOWN:-0}" in
  0) exec /usr/local/bin/mainworthy "$@" ;;
  1) ;;
  *) echo 'MAINWORTHY_LOCKDOWN must be 0 or 1' >&2; exit 1 ;;
esac
if [ "${1:-}" != health ]; then
  policy=/usr/local/share/mainworthy/lockdown.nft
  # Resolve before denying DNS, then use the same numeric endpoint in Bun and nft.
  case "${MAINWORTHY_DATABASE_URL:-}" in
    postgres://*|postgresql://*) ;;
    *) echo 'MAINWORTHY_DATABASE_URL must name PostgreSQL' >&2; exit 1 ;;
  esac
  scheme=${MAINWORTHY_DATABASE_URL%%://*}
  location=${MAINWORTHY_DATABASE_URL#*://}
  authority=${location%%[/?#]*}
  path=${location#"$authority"}
  credentials=
  endpoint=$authority
  case "$authority" in
    *@*) credentials="${authority%@*}@"; endpoint=${authority##*@} ;;
  esac
  port=5432
  case "$endpoint" in
    \[*\]*)
      host=${endpoint#\[}; host=${host%%\]*}
      rest=${endpoint#*\]}
      case "$rest" in '') ;; :*) port=${rest#:} ;; *) exit 1 ;; esac
      ;;
    *:*) host=${endpoint%:*}; port=${endpoint##*:} ;;
    *) host=$endpoint ;;
  esac
  case "$host" in ''|*[!a-zA-Z0-9._:-]*) echo 'invalid database host' >&2; exit 1 ;; esac
  case "$port" in ''|*[!0-9]*) echo 'invalid database port' >&2; exit 1 ;; esac
  port=$(awk -v port="$port" 'BEGIN { if (port < 1 || port > 65535) exit 1; printf "%d", port }')
  address=$(getent ahosts "$host" | awk '$2 == "STREAM" { print $1; exit }')
  case "$address" in ''|*[!0-9a-fA-F.:]*) echo 'cannot resolve database host' >&2; exit 1 ;; esac
  family=ip
  resolved=$address
  case "$address" in *:*) family=ip6; resolved="[$address]" ;; esac
  MAINWORTHY_DATABASE_URL="$scheme://$credentials$resolved:$port$path"
  export MAINWORTHY_DATABASE_URL
  expected=$(mktemp)
  transaction=$(mktemp)
  trap 'rm -f "$transaction" "$expected"' EXIT HUP INT TERM
  awk -v family="$family" -v address="$address" -v port="$port" '
    /# database endpoint/ {
      printf "\t\t%s daddr %s tcp dport %s ct state new accept\n", family, address, port
      printf "\t\t%s daddr %s tcp dport %s ct state established accept\n", family, address, port
      next
    }
    { print }
  ' "$policy" > "$expected"
  {
    echo 'add table inet mainworthy_lockdown'
    echo 'delete table inet mainworthy_lockdown'
    cat "$expected"
  } > "$transaction"
  nft --check --file "$transaction"
  nft --file "$transaction"
  nft --stateless list table inet mainworthy_lockdown > "$transaction"
  cmp "$expected" "$transaction"
  rm -f "$transaction" "$expected"
  trap - EXIT HUP INT TERM
fi
exec setpriv --reuid=10001 --regid=10001 --clear-groups \
  --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
  /usr/local/bin/mainworthy "$@"
