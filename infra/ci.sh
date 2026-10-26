#!/usr/bin/env bash
set -euo pipefail
suite=$(cd -- "$(dirname -- "$0")" && pwd)
if [ "${1:-}" = mask ]; then
  exec python3 "$suite/ci-log.py" mask
fi
# The app runs the image check.yml tested and published to GHCR for this commit. A push waits for it (check.yml's
# gate runs first); a drift check reads the same commit's. The image is public, so no credentials are needed. The
# workflow runs this before signing in, so the wait does not use up the access token.
if [ "${1:-}" = digest ]; then
  deadline=$((SECONDS + ${IMAGE_WAIT_SECONDS:-2400}))
  while :; do
    token=$(curl --fail --silent --max-time 10 "https://ghcr.io/token?scope=repository:endqwerty/mainworthy:pull" | jq -r .token) || token=
    digest=$(curl --fail --silent --head --max-time 10 -H "Authorization: Bearer $token" \
      -H 'Accept: application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' \
      "https://ghcr.io/v2/endqwerty/mainworthy/manifests/${GITHUB_SHA:?Set the checked-out commit}" |
      tr -d '\r' | awk 'tolower($1) == "docker-content-digest:" { print $2 }') || digest=
    if [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "Image: ghcr.io/endqwerty/mainworthy@$digest ($GITHUB_SHA)" >&2
      printf '%s\n' "$digest"
      exit 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "No tested image of $GITHUB_SHA on GHCR: check.yml publishes one only after its gate passes on main." >&2
      exit 1
    fi
    sleep 30
  done
fi
# The workflow and WIF independently restrict callers to main and bind each event to its own identity.
case "${1:-}" in
  push|workflow_dispatch) ;;
  *) echo 'Infrastructure runs only for a main push or manual drift check.' >&2; exit 1 ;;
esac
: "${STATE_BUCKET:?Set the app state bucket}"
: "${RUNNER_TEMP:?Set private runner temporary storage}"
umask 077
scratch=$(mktemp -d "$RUNNER_TEMP/mainworthy-infra.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
terraform_ci() {
  local rc=0
  terraform "$1" -no-color "${@:2}" > "$scratch/terraform.log" 2>&1 || rc=$?
  python3 "$suite/ci-log.py" "$scratch/terraform.log" "$rc"
  if [ "$rc" != 0 ] && [ "$rc" != 2 ]; then
    echo "Terraform $1 failed (exit $rc)." >&2
  fi
  return "$rc"
}
# Print each planned change's action, address and changed attribute names; never values.
changes() {
  if terraform show -no-color -json "$1" > "$scratch/plan.json" 2> "$scratch/terraform.log"; then
    python3 "$suite/ci-log.py" changes "$scratch/plan.json"
  else
    python3 "$suite/ci-log.py" "$scratch/terraform.log" 1
    echo 'Terraform show failed.' >&2
    return 1
  fi
}
: "${TF_VAR_app_digest:?Set the tested image digest (ci.sh digest)}"
terraform_ci init -lockfile=readonly -backend-config="bucket=$STATE_BUCKET"
terraform_ci validate
if [ "$1" = push ]; then
  terraform_ci plan -lock-timeout=5m -out="$scratch/apply.tfplan"
  changes "$scratch/apply.tfplan"
  # An old push can be rerun after main advances. Never apply that stale configuration.
  if [ "$(git ls-remote origin refs/heads/main | cut -f1)" != "${GITHUB_SHA:?Set the checked-out commit}" ]; then
    echo 'Refusing to apply infrastructure from an older main commit.' >&2
    exit 1
  fi
  terraform_ci apply -lock-timeout=5m "$scratch/apply.tfplan"
else
  # The reader cannot create a GCS lock. Exit 2 makes drift fail the workflow.
  rc=0
  terraform_ci plan -lock=false -detailed-exitcode -out="$scratch/drift.tfplan" || rc=$?
  if [ "$rc" = 0 ] || [ "$rc" = 2 ]; then changes "$scratch/drift.tfplan"; fi
  exit "$rc"
fi
