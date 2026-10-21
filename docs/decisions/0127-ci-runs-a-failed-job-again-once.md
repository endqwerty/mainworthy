# 0127: CI runs a failed job again once, to tell a flaky test from a broken commit

- Date: 2026-10-21
- Status: accepted (the owner asked for it in the thread that built it, 2026-10-21)

## Problem

The owner: "Setup auto rerun for my ci of failed jobs to find out if they are flaky."

A test that fails by chance fails the check like a broken commit. Under decision 0124 the gate reads `failed`, and
the session that pushed the commit, or the owner for `main`, finds out whether it was chance by running the shard's
job again by hand. On 2026-10-21 `main` at `3a47777e` read failed for 36 minutes until somebody did. Mainworthy
already tells the two apart once the retry has run: a test that fails and then passes on the same commit has
flipped, and its results and its page say "flaky".

## Decision

**The `rerun` workflow runs the failed jobs of a check again, once.** It starts when a run of `check` fails on its
first attempt, on a branch of this repository. `scripts/ci-rerun.ts` reads the run's test reports and jobs:

- Each test shard whose report holds a failing test runs again, and so does any other job that failed and can
  fail by chance (`ios`, `image`). The gate runs after each of them, as a job that needs them.
- Nothing runs again when `scope`, `static` or `description` failed. Those fail the same way every time, so the
  run cannot pass, and the commit that fixes them tests everything again.
- Nothing runs again when more than three jobs would. That many failing is a broken commit, and a retry would only
  put off saying so for another ten minutes.
- When only the gate failed and no test did, the gate runs again alone: what it reads, the deployed Mainworthy or
  the artifacts, may have been out of reach.

The jobs run again one after the other. GitHub runs a job again only in a run that has finished, and a shard's job
passes when its tests fail (the gate judges them), so "Re-run failed jobs" would run the gate alone.

What the retry shows is Mainworthy's to judge, as for a retry by hand. A test that passes has flipped, the gate counts
the pass, and the results say "flaky". A test that fails again stays a failure, now with two attempts behind it.
A flaky test is still a defect to fix and to file as `flaky-test` (`AGENTS.md`). The retry tells you which kind of
failure it is; it does not excuse the test.

## Turned down

- **Retrying failing tests inside the shard**, with Bun or a loop in `scripts/check.ts`. That is faster, but
  Mainworthy would see one attempt with a pass, the flip would never be recorded, and the flaky test would be
  hidden instead of named.
- **Re-running the whole run.** It runs every shard, the iPhone app and the image again, about ten minutes on seven
  runners, and gives every test that passed a fresh chance to fail.
- **Failing a shard's job when its tests fail**, so that "Re-run failed jobs" finds it. The gate's last step reads a
  shard's job result to catch a shard that could not run. A quarantined or answered failure must not fail the run,
  so that step would need another way to know the shard ran.
- **Retrying more than once.** A second pass after a second failure would hide a test that fails half the time.

## Not checked

GitHub runs a `workflow_run` workflow only from the default branch, so this one first runs after it merges.
`bun scripts/ci-rerun.ts <run> --dry-run` showed what it would have chosen for eight failed runs of 2026-10-21. That
the workflow's own token may run another run's jobs again is taken from published examples, not from GitHub's
documentation. The first failure after the merge shows it, on the `rerun` run's summary page.
