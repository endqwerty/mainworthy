# 0038: A commit can gain a scope and land on trunk

- Date: 2026-10-14
- Status: proposed
- Issue: [#68](https://github.com/endqwerty/mainworthy/issues/68)

## Problem

A commit has one exact gate and one scope across its environments. Keeping its first
scope forever avoided contradictory answers, but a head fast-forwarded to trunk still
belonged to its pull request. A hash-only first report also prevented a later branch
report from placing the commit. Decision 0022 ends questions about a change, but does
not say that its head reached trunk unchanged.

## Usage

The existing `change` operation accepts optional landing metadata:

```json
{"change":"pr:482","state":"merged","landing":{"commit":"abc12345","branch":"main"}}
```

A pipeline or person reports this fact. `landing.commit` sets the change's head to that
exact hash, even if it is older than the recorded head or has no reports yet. The gate
is pending until evidence arrives. The landed commit belongs to trunk immediately,
so later results count for both the change's head gate and trunk's questions, even when
the report still names the pull request. A different merge or rebased hash leaves the
original commit's scope unchanged. Metadata can arrive after the initial end event.
Without landing metadata, a merge keeps the head recorded when the change ended.
Reopening a change leaves a landed commit on trunk.

An automated report first made with only a commit hash is provisional about its scope.
A later pipeline or person naming a branch or pull request places all its environments
there, unless the commit has a recorded `human` batch or any result row with method
`human`. This check includes results that the gate does not count. Those reports keep
their scope so a later branch report preserves their question id, dispute hints and answers.
Reports about a commit already in a named scope keep that scope. Agents cannot choose it.

## Shape

`ChangeInput` adds `landing?: { commit: string; branch: "main" | "master" | "trunk" }`.
The operation refuses landing metadata unless the state is `merged`. Evidence owns
the target placement and the append-only `scope_moves` record, including source scope,
destination scope, actor, sequence and time. For an unreported landing, evidence creates
a trunk target without creating evidence or a gate run. Reports preserve that trunk
placement across environments, even before the first counted report. Runs updates the existing gate's scope
and change reference. The operation recomputes that gate and all planned runs counting
the commit, using the ordinary failure-question path.

The gate keeps its id and counted evidence. Pull request decisions keep their original
scope and attribution, so they still cover older commits of the pull request. They do
not excuse trunk failures. Trunk's existing decisions apply and unexplained failures
are asked again. An answer in a provisional hash-only scope becomes outdated, through
the existing decision lifecycle, before the failure is evaluated in its named scope.

Migration 8 adds `scope_moves` with `archive: false`. Like `change_ends` in decision
0022, the table is `UNEXPORTED`, so this migration keeps archive schema 7 compatible.
Migration 7 already requires archive schema 7. Targets
and runs already carry the resulting scope. An import loses the audit trail of moves,
including their source, reporter and time, while preserving the resulting placement.

## Alternatives considered

Inferring a merge from an ordinary trunk report would hide a lifecycle transition in
report ingestion and require storing or reconciling report order. A merge may also
produce a different hash. Explicit landing metadata extends the lifecycle operation
that already owns change ending and keeps the comparison exact.

Copying pull request answers to trunk would silently broaden their scope to other
commits. Keeping two active scopes or making another run would allow contradictory
answers to the same commit. Both are rejected. The existing single gate changes scope
atomically and evaluates failures under the destination's decisions.

## Limits

The landing identifies the merged head. Reports and code-host head observations cannot
replace it while the change is merged. A missed event can be resent with the landing metadata. The GitHub workflow
supplies landing metadata on merge events into the three recognized trunk names;
manual workflow dispatch still ends the change without inferring a landing.
