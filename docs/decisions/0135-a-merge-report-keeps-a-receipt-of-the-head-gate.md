# 0135: A merge report keeps a receipt of the head gate

- Date: 2026-10-22
- Status: accepted (issue #726 specifies the receipt)
- Extends: decision 0127

## Problem

A change's head gate changes with later evidence and decisions. A fast-forward also moves that commit to
trunk, where trunk's decisions judge it. A head that passed with an excuse on its pull request can immediately
read blocked on trunk. The current gate cannot answer what Mainworthy knew when the merge was reported.

## Decision

A `change` report with `state: merged` observes the supplied head, or keeps the recorded head, and records
its gate before ending questions or moving a landing. The observation includes the server time, reporting
actor, policy version, scalar gate summary, every counted result and its standing, and references to the immutable
decisions those standings rested on. The displayed decision answer is frozen with the result. Unknown or unreported heads record pending. An explicit nothing-required pass keeps
that verdict even with no result rows. No caller supplies the receipt or its time.

The immutable `merge_receipts` ledger belongs to decisions. It records an internal decision to preserve this
observation, with no queue question, configurable policy clause, approval, excuse or run closure. Only the
existing decision machinery mints its `merge-receipt` Witness after appending the ledger row. The evidence
module checks that kind before selecting the receipt through `change_ends.receipt`, whose foreign key names
the ledger row. The whole command is transactional, including its landing and subsequent gate recomputation.
Public question kinds and their decision ledger keep their existing meaning.

A repeated merge report for the same active head keeps the receipt byte for byte. A corrected head appends a
new observation at its own report time and selects it. A landing-only correction keeps the receipt. Reopening
or closing without merging clears the active selection but keeps the ledger. A later merge records a new
observation, even of the same head. The operation has no code-host event id, so it cannot distinguish an old
head replay from an intentional correction. Its existing explicit-head correction semantics still apply.

The bounded manifest in `merge_receipts` references a content-addressed snapshot. `merge_receipt_snapshots`
indexes ordered memberships in `merge_receipt_members`; `merge_receipt_payloads` shares frozen bodies by
project and full SHA-256. A two-pass, keyset-paged traversal hashes evidence before storing any new snapshot.
Identical reopen/merge observations add only a manifest. Each body is limited to 32 KiB; each read returns
at most 50 members and 64 KiB of source evidence. Gate blocking refs are chunked and shard waits are paged;
large arrays do not enter the manifest. Decision answer, signers, holds, basis and expiry are immutable in
the existing decision ledger (the sole update changes only derived `effects`), so receipts reference that
ledger rather than copying a potentially large decision for every counted result.

`impact` returns the active receipt manifest as `change.mergeReceipt`; the change list keeps only live gate summaries,
so listing changes never reads every historical result. The web and iPhone detail pages show the receipt
beside the current gate and request counted results through `find in: receipt-results`, a page at a time.
CLI and MCP clients read the same bounded manifests and pages.
`gate` and its exit code remain the live gate. Audit exports include every retained receipt, including those
superseded or cleared by a later end. The range export contains manifests, while `audit receipt` pages
export complete frozen result and gate evidence with hashes and ordinals for bundle verification. A receipt describes the gate **when the merge was reported**, not when
the merge actually happened or whether it was approved.

Migration 0041 creates the shared evidence tables, receipt ledger and nullable selection. Existing merged changes keep no receipt:
today's gate cannot reconstruct a past observation. Reporting the merge again takes a receipt at that new
report time. Archives omit the ledger with `change_ends`; imported changes are open. The archive version
therefore stays unchanged. Removing or resetting a project removes its receipts with its other records.

## Turned down

- Reusing run sign-off. It requires a passing gate and closes the run. A receipt can record any verdict.
- Adding a question kind or an approval policy. A merge report needs no answer about whether to preserve it.
- Making question decisions questionless. A separate internal ledger avoids widening every queue and decision
  consumer, while the Witness and a foreign key still protect the active standing record.
- Computing old standings from today's results and excuses. It would repeat the bug under a historical label.
- Returning all frozen results in any change reply. Both detail and lists must remain bounded.
- One deduplicated JSON snapshot. It would still require a full array during capture and unindexed JSON scans
  while paging. Indexed memberships keep capture and evidence reads bounded.

Principles: Model the Domain (separate an immutable observation from live gate and approval); Make Operations
Idempotent (duplicate merge reports keep the receipt); Type System Discipline (shared receipt schema and a
receipt-specific Witness); Test Behavior, Not Implementation (fast-forward and late-report API and browser checks).
