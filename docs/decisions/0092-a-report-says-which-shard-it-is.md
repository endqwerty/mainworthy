# 0092: A report says which shard of its job it is

- Date: 2026-10-16
- Status: accepted (the owner asked for sharded CI to be supported, 2026-10-16, in the thread that built 0102)

## Problem

A pipeline that splits a job's tests into shards sends one report per shard. Mainworthy could not tell that more
reports were coming, so a commit's gate read what it had. When the first shard to report held only passes, the
gate read `passed` before the other shards had run. A shard that never reported was a pass by omission. This
repository's own CI avoided it only because one job uploads every shard and then reads the gate
(`scripts/ci-gate.ts`), and that job failed on a missing shard by its own check, not by the gate.

The same gap made decision 0102 weaker. An answer that needs a fix ends when its cause passes in the newest
commit. With no idea of a whole commit, a test failing with the cause for the first time in a shard that reported
late was asked about as a new question, after the answer had already ended.

## Decision

**A report can say which shard of its job it is**: `shard: {index, of}` in the operation, `--shard 2/6` on the
command line. All shards of a job give the same job name and the same number of shards. A report that gives
another number for a job of the same commit and environment is refused.

**A commit's gate waits for every shard.** For each job of each target (a commit in one environment) that
reported in shards, the shards that have not reported are missing evidence: the gate reads `pending` and names
them, `pending: waiting for shards 3 and 5 of 6 of job tests`, and the gate's reply lists them in `waiting`. The
verdict keeps its order. An unexplained or attributed failure in a shard that already reported shows at once as
`blocked` or `failed`, and the reason adds what it still waits for. A retry of a shard keeps its index. An
agent's report under the job's name is not the job.

**Questions wait for the whole commit too.** An open failure question closes when its cause is gone from the
newest commit, and an answer that needs a fix ends when its cause passes there (decision 0102). Neither happens
while that commit waits for a shard, or while a report of it is accepted and not yet applied: either may hold the
cause. Not even a planned run that cleared closes the question then. (Both found in review: the first by the
verifier, the second by the automated review of the pull request.)

**This repository reports its parallel shards so.** `scripts/ci-gate.ts` reports `tests-1` to `tests-<n>` as
shards of the job `tests`. A shard that left no report now leaves the gate `pending` as well as failing the job.

**The demo shows it.** Today's pull request 483 has reported two of its three shards, and its gate waits for
the third.

## Where it is kept

Two nullable columns on `batches`, `shard` and `shards` (migration 26). A report from before has neither and is
a whole job, so an older archive imports unchanged. What a commit waits for is read from its batches when its run
is counted and when its gate is read; the run stores no list of its own.

## Turned down

- **A separate "every report is in" call** (from an independent design by GPT 6.1 Sol). CI would tell Mainworthy
  once all jobs of a commit had reported. It also covers several unsharded jobs, but it needs a job after all the
  others to send it, and until it comes nothing ends and every gate waits. A sharded job already knows its index
  and count, and with them each shard's own `mainworthy gate` tells the truth.
- **Every report listing the jobs it expects** (`--expect unit,e2e`). It generalises sharding to unrelated jobs,
  and asks each job to know the others. Nobody asked for it; `require` on a planned run already names jobs.
- **Projects declaring their jobs in the policy.** A change that runs fewer tests runs fewer shards (this
  repository's CI narrows by what changed, decision 0090), so the number of shards is a fact of each commit.

## Not done

- Several jobs that are not shards of one job are still not known to be complete. Each is complete when it
  reports.
- A planned run that accepts a commit does not wait for the commit's shards. It names the jobs it requires
  (`require: jobs`).
