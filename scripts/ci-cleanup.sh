#!/usr/bin/env bash
set -euo pipefail

# These resources belong only to CI on the dedicated runner VM. Never prune the daemon.
: "${RUNNER_TEMP:?The runner temporary directory is required}"
docker info >/dev/null
if docker buildx inspect mainworthy-ci >/dev/null 2>&1; then
  docker buildx rm --force mainworthy-ci
fi
for container in mainworthy postgres; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    if [ "${1:-}" = --logs ]; then docker logs "$container" || true; fi
    docker rm --force --volumes "$container"
  fi
done
if docker network inspect mainworthy-check >/dev/null 2>&1; then
  docker network rm mainworthy-check
fi
if docker image inspect mainworthy:check >/dev/null 2>&1; then
  docker image rm mainworthy:check
fi
# A cancelled publication may leave a candidate from an earlier run.
candidates=$(docker image ls --format '{{.Repository}}:{{.Tag}}' --filter 'reference=ghcr.io/endqwerty/mainworthy:build-*')
while IFS= read -r candidate; do
  if [[ "$candidate" =~ ^ghcr\.io/endqwerty/mainworthy:build-[0-9]+-[0-9]+$ ]]; then
    docker image rm "$candidate"
  fi
done <<< "$candidates"
rm -f "$RUNNER_TEMP/mainworthy-image.tar"
