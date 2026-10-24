#!/usr/bin/env bash
set -euo pipefail

# Only disposable CI databases skip durability; timing measurements retain it.
case "$1" in
  --only=performance) durability=on ;;
  --only=parallel*) durability=off ;;
  *) echo "Expected a CI test phase" >&2; exit 1 ;;
esac

docker run --detach --name postgres --publish 127.0.0.1:5432:5432 --shm-size=256m \
  --env POSTGRES_HOST_AUTH_METHOD=trust \
  --env 'POSTGRES_INITDB_ARGS=--locale=C --encoding=UTF8' \
  --health-cmd 'pg_isready -h 127.0.0.1 -U postgres' --health-interval 2s \
  --health-timeout 5s --health-retries 30 \
  postgres:18@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6 \
  postgres -c "fsync=$durability" -c "synchronous_commit=$durability" -c "full_page_writes=$durability"
for attempt in $(seq 1 60); do
  if docker exec postgres pg_isready -h 127.0.0.1 -U postgres; then break; fi
  sleep 1
done
docker exec postgres pg_isready -h 127.0.0.1 -U postgres
settings=$(docker exec postgres psql -h 127.0.0.1 -U postgres -Atc \
  "SELECT current_setting('fsync') || ',' || current_setting('synchronous_commit') || ',' || current_setting('full_page_writes')")
echo "PostgreSQL durability: $settings"
test "$settings" = "$durability,$durability,$durability"
