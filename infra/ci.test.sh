#!/usr/bin/env bash
set -euo pipefail
# Runs the real CI commands against a Terraform stand-in, with no Google credentials or provider calls.
suite=$(cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
cat > "$scratch/terraform" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS"
if [ "$1" = plan ]; then exit "${PLAN_EXIT:-0}"; fi
MOCK
cat > "$scratch/git" <<'MOCK'
#!/usr/bin/env bash
if [ "$*" != 'ls-remote origin refs/heads/main' ]; then exit 1; fi
printf '%s\trefs/heads/main\n' "${REMOTE_SHA:-example-main}"
MOCK
chmod +x "$scratch/terraform" "$scratch/git"
export PATH="$scratch:$PATH" CALLS="$scratch/calls" STATE_BUCKET=example-state GITHUB_SHA=example-main
run_ci() { bash "$suite/ci.sh" "$1"; }
run_ci push
cat > "$scratch/expected" <<'EXPECTED'
init -lockfile=readonly -backend-config=bucket=example-state
validate
plan -lock-timeout=5m -out=apply.tfplan
apply -lock-timeout=5m apply.tfplan
EXPECTED
diff -u "$scratch/expected" "$CALLS"
: > "$CALLS"
run_ci workflow_dispatch
cat > "$scratch/expected" <<'EXPECTED'
init -lockfile=readonly -backend-config=bucket=example-state
validate
plan -lock=false -detailed-exitcode
EXPECTED
diff -u "$scratch/expected" "$CALLS"
for event in push workflow_dispatch; do
  : > "$CALLS"
  export PLAN_EXIT=1
  if run_ci "$event"; then echo 'A failed plan must fail CI.' >&2; exit 1; fi
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
: > "$CALLS"
export PLAN_EXIT=0 REMOTE_SHA=example-new-main
if run_ci push; then echo 'A stale push must not apply.' >&2; exit 1; fi
if grep -q '^apply ' "$CALLS"; then echo 'A stale push must not apply.' >&2; exit 1; fi
: > "$CALLS"
if run_ci pull_request; then echo 'PR events must be refused.' >&2; exit 1; fi
test ! -s "$CALLS"
echo 'PASS: push applies only a successful saved plan; manual drift never writes; PRs and stale pushes are refused.'
