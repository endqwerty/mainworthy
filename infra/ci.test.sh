#!/usr/bin/env bash
set -euo pipefail
# Runs the real CI commands against a Terraform stand-in, with no Google credentials or provider calls.
suite=$(cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
# Check Git's real ignore behavior in an isolated directory, including archive-based reviews.
cp "$suite/.gitignore" "$scratch/.gitignore"
git -C "$scratch" init -q
for name in production.tfvars production.auto.tfvars production.tfvars.json production.auto.tfvars.json; do
  git -C "$scratch" check-ignore --no-index -q "$name"
done
# A call without a quota project is billed to the CI account's seed project, where these APIs are off.
if ! grep -Eq '^[[:space:]]*user_project_override[[:space:]]*=[[:space:]]*true' "$suite/versions.tf" ||
  ! grep -Eq '^[[:space:]]*billing_project[[:space:]]*=[[:space:]]*var\.production_project' "$suite/versions.tf"; then
  echo 'The google provider must name production as the quota project of every call.' >&2
  exit 1
fi
cat > "$scratch/terraform" <<'MOCK'
#!/usr/bin/env bash
args=$(printf '%s' "$*" | sed -E 's@/[^ ]*/mainworthy-infra\.[^/ ]+/([a-z]+\.tfplan)@\1@g')
printf '%s\n' "$args" >> "$CALLS"
if [ "$1" = show ]; then
  cat <<'PLAN'
{"resource_changes": [
  {"address": "google_sql_database.app", "change": {"actions": ["create"], "before": null,
    "after": {"name": "mainworthy", "project": "example-private-project"}}},
  {"address": "google_storage_bucket.attachments", "change": {"actions": ["update"],
    "before": {"labels": {"app": "old"}, "name": "example-private-project-attachments"},
    "after": {"labels": {"app": "new"}, "name": "example-private-project-attachments"}}},
  {"address": "google_service_networking_connection.sql[\"production\"]", "change": {"actions": ["no-op"],
    "before": {}, "after": {}, "importing": {"id": "projects/example-private-project/global/networks/mainworthy"}}},
  {"address": "google_service_networking_connection.sql[\"preview\"]", "change": {"actions": ["update"],
    "before": {"deletion_policy": null, "network": "example-private-project"},
    "after": {"deletion_policy": "ABANDON", "network": "example-private-project"},
    "importing": {"id": "projects/example-private-project/global/networks/mainworthy"}}},
  {"address": "google_compute_network.app[\"preview\"]", "change": {"actions": ["no-op"], "before": {}, "after": {}}}
]}
PLAN
  exit 0
fi
printf '%s\n' 'resource project = example-private-project' 'email = mainworthy-jobs@example-private-project.iam.gserviceaccount.com' 'url = https://mainworthy-jobs-123456789012.us-west1.run.app'
printf 'runtime = %s\n' "${TF_VAR_runtime:-null}"
if [ "$1" = plan ]; then
  if [ "${PLAN_EXIT:-0}" = 1 ]; then
    echo "Error: ${PLAN_ERROR:-example-private-project mainworthy-jobs@example-private-project.iam.gserviceaccount.com https://mainworthy-jobs-123456789012.us-west1.run.app}" >&2
  else
    echo "${PLAN_SUMMARY:-Plan: 3 to add, 1 to change, 0 to destroy.}"
  fi
  exit "${PLAN_EXIT:-0}"
fi
if [ "$1" = apply ]; then
  echo 'Apply complete! Resources: 3 added, 1 changed, 0 destroyed.'
  echo 'Error: example-private-project mainworthy-jobs@example-private-project.iam.gserviceaccount.com' >&2
  exit "${APPLY_EXIT:-0}"
fi
MOCK
cat > "$scratch/git" <<'MOCK'
#!/usr/bin/env bash
if [ "$*" != 'ls-remote origin refs/heads/main' ]; then exit 1; fi
printf '%s\trefs/heads/main\n' "${REMOTE_SHA:-example-main}"
MOCK
chmod +x "$scratch/terraform" "$scratch/git"
export PATH="$scratch:$PATH" CALLS="$scratch/calls" STATE_BUCKET=example-state GITHUB_SHA=example-main
export RUNNER_TEMP="$scratch" TF_VAR_production_project=example-private-project
run_ci() {
  local rc=0
  bash "$suite/ci.sh" "$1" > "$scratch/public.log" 2>&1 || rc=$?
  if grep -Eq 'example-private-project|gserviceaccount.com|123456789012|run.app' "$scratch/public.log"; then
    echo 'Private Terraform attributes reached the public log.' >&2
    exit 1
  fi
  return "$rc"
}
bash "$suite/ci.sh" mask > "$scratch/masks"
for value in "$TF_VAR_production_project" "$STATE_BUCKET" \
  "mainworthy-app@$TF_VAR_production_project.iam.gserviceaccount.com" \
  "mainworthy-jobs@$TF_VAR_production_project.iam.gserviceaccount.com"; do
  grep -Fqx -- "::add-mask::$value" "$scratch/masks"
done
run_ci push
cat > "$scratch/expected" <<'EXPECTED'
Plan: 3 to add, 1 to change, 0 to destroy.
create google_sql_database.app
update google_storage_bucket.attachments (labels)
import google_service_networking_connection.sql["production"]
import and update google_service_networking_connection.sql["preview"] (deletion_policy)
Apply complete! Resources: 3 added, 1 changed, 0 destroyed.
EXPECTED
diff -u "$scratch/expected" "$scratch/public.log"
cat > "$scratch/expected" <<'EXPECTED'
init -no-color -lockfile=readonly -backend-config=bucket=example-state
validate -no-color
plan -no-color -lock-timeout=5m -out=apply.tfplan
show -no-color -json apply.tfplan
apply -no-color -lock-timeout=5m apply.tfplan
EXPECTED
diff -u "$scratch/expected" "$CALLS"
# The first apply on main printed nothing: a plan that imports says so in its summary.
PLAN_SUMMARY='Plan: 2 to import, 3 to add, 1 to change, 0 to destroy.' run_ci push
grep -Fx 'Plan: 2 to import, 3 to add, 1 to change, 0 to destroy.' "$scratch/public.log"
: > "$CALLS"
run_ci workflow_dispatch
cat > "$scratch/expected" <<'EXPECTED'
init -no-color -lockfile=readonly -backend-config=bucket=example-state
validate -no-color
plan -no-color -lock=false -detailed-exitcode -out=drift.tfplan
show -no-color -json drift.tfplan
EXPECTED
diff -u "$scratch/expected" "$CALLS"
for event in push workflow_dispatch; do
  : > "$CALLS"
  export PLAN_EXIT=1
  if run_ci "$event"; then echo 'A failed plan must fail CI.' >&2; exit 1; fi
  grep -q '^Error: ' "$scratch/public.log"
  if grep -q '^apply ' "$CALLS"; then echo 'A failed plan must not apply.' >&2; exit 1; fi
done
: > "$CALLS"
export PLAN_EXIT=2
set +e
run_ci workflow_dispatch
rc=$?
set -e
test "$rc" = 2
if grep -q '^apply ' "$CALLS"; then echo 'Drift must never apply.' >&2; exit 1; fi
# Drift names what differs, so it can be diagnosed from the public log alone.
grep -Fx 'update google_storage_bucket.attachments (labels)' "$scratch/public.log"
: > "$CALLS"
export PLAN_EXIT=0 APPLY_EXIT=1
if run_ci push; then echo 'A failed apply must fail CI.' >&2; exit 1; fi
grep -q '^Error: ' "$scratch/public.log"
export APPLY_EXIT=0 PLAN_SUMMARY='No changes. Your infrastructure matches the configuration.'
run_ci workflow_dispatch
grep -Fx 'No changes.' "$scratch/public.log"
: > "$CALLS"
export PLAN_EXIT=0 REMOTE_SHA=example-new-main
if run_ci push; then echo 'A stale push must not apply.' >&2; exit 1; fi
if grep -q '^apply ' "$CALLS"; then echo 'A stale push must not apply.' >&2; exit 1; fi
: > "$CALLS"
if run_ci pull_request; then echo 'PR events must be refused.' >&2; exit 1; fi
test ! -s "$CALLS"
# Exercise the runner's literal mask replacement, since ci.sh cannot apply Actions masks locally.
export TF_VAR_runtime='{"image":"us-west1-docker.pkg.dev/example-runtime/mainworthy/app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sql_proxy_image":"example/proxy@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
export GCP_WORKLOAD_IDENTITY_PROVIDER=projects/234567890123/locations/global/workloadIdentityPools/github/providers/github-actions
export GCP_INFRA_DEPLOY_ACCOUNT=mainworthy-deploy@example-deploy-seed.iam.gserviceaccount.com
export GCP_INFRA_PLAN_ACCOUNT=mainworthy-plan@example-plan-seed.iam.gserviceaccount.com
export PLAN_EXIT=0 PLAN_SUMMARY='Plan: 3 to add, 1 to change, 0 to destroy.' REMOTE_SHA=example-main
bash "$suite/ci.sh" mask > "$scratch/masks"
run_ci workflow_dispatch
failures=0
if ! python3 - "$scratch/masks" "$scratch/public.log" <<'PYTEST'
import json
import os
import sys
from pathlib import Path

masks = [line.removeprefix("::add-mask::").replace("%0A", "\n").replace("%0D", "\r").replace("%25", "%")
         for line in Path(sys.argv[1]).read_text().splitlines()]
public = Path(sys.argv[2]).read_text()
assert public.startswith("Plan: 3 to add, 1 to change, 0 to destroy.\ncreate google_sql_database.app\n"), public
generic = "Error: image sql_proxy_image github github-actions global projects locations providers"
runtime = list(json.loads(os.environ["TF_VAR_runtime"]).values())
rendered = public + generic + "\n" + "\n".join(runtime + [os.environ["GCP_WORKLOAD_IDENTITY_PROVIDER"], "234567890123"])
for value in masks:
    rendered = rendered.replace(value, "***")
assert rendered.startswith(public + generic + "\n"), "L1: Actions masks garble plan summaries or generic words"
assert not any(value in rendered for value in runtime + ["234567890123"]), "L1: private runtime/WIF values reached the log"
PYTEST
then
  failures=1
fi
export PLAN_EXIT=1 PLAN_ERROR='cannot use project example-deploy-seed or example-plan-seed'
if run_ci workflow_dispatch; then echo 'The seed-project error must fail CI.' >&2; exit 1; fi
if ! grep -Fxq 'Error: cannot use project *** or ***' "$scratch/public.log"; then
  echo 'L2: bare seed project ids reached the error log.' >&2
  failures=1
fi
for identifier in \
  10.20.30.40 192.0.2.12 fd12:3456:789a::1 \
  2001:db8:1234:5678:90ab:cdef:1234:5678 ::1 :: \
  ::ffff:10.20.30.40 fe80::1%eth0 \
  01234567-89ab-cdef-0123-456789abcdef ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB; do
  export PLAN_ERROR="cannot reach $identifier; check firewall or request id"
  if run_ci workflow_dispatch; then echo 'A diagnostic error must fail CI.' >&2; exit 1; fi
  if ! grep -Fxq 'Error: cannot reach ***; check firewall or request id' "$scratch/public.log"; then
    echo "An address or UUID reached the error log: $identifier" >&2
    failures=1
  fi
done
export PLAN_ERROR='dial [fd12:3456:789a::1]:5432 or 10.20.30.40. Terraform 1.17.0 returned 400: denied'
if run_ci workflow_dispatch; then echo 'A connection error must fail CI.' >&2; exit 1; fi
if ! grep -Fxq 'Error: dial [***]:5432 or ***. Terraform 1.17.0 returned 400: denied' "$scratch/public.log"; then
  echo 'Diagnostic punctuation or failure context was lost.' >&2
  failures=1
fi
export PLAN_ERROR='dial tcp 10.20.30.40:5432 from host:192.0.2.12 via 0.0.0.0:8080'
if run_ci workflow_dispatch; then echo 'A connection error must fail CI.' >&2; exit 1; fi
if ! grep -Fxq 'Error: dial tcp ***:5432 from host:*** via ***:8080' "$scratch/public.log"; then
  echo 'An IPv4 address beside a port or a colon reached the error log.' >&2
  failures=1
fi
test "$failures" = 0
echo 'PASS: identifiers are masked, Terraform logs are private, and failed plans, drift, PRs and stale pushes never apply.'
