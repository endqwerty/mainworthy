#!/usr/bin/env bash
set -euo pipefail

# The workflow and WIF independently restrict callers to main and bind each event to its own identity.
case "${1:-}" in
  push|workflow_dispatch) ;;
  *) echo 'Infrastructure runs only for a main push or manual drift check.' >&2; exit 1 ;;
esac
: "${STATE_BUCKET:?Set the app state bucket}"
terraform init -lockfile=readonly -backend-config="bucket=$STATE_BUCKET"
terraform validate
if [ "$1" = push ]; then
  terraform plan -lock-timeout=5m -out=apply.tfplan
  # An old push can be rerun after main advances. Never apply that stale configuration.
  if [ "$(git ls-remote origin refs/heads/main | cut -f1)" != "${GITHUB_SHA:?Set the checked-out commit}" ]; then
    echo 'Refusing to apply infrastructure from an older main commit.' >&2
    exit 1
  fi
  terraform apply -lock-timeout=5m apply.tfplan
else
  # The reader cannot create a GCS lock. Exit 2 makes drift fail the workflow.
  terraform plan -lock=false -detailed-exitcode
fi
