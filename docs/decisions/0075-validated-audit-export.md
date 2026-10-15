# 0075: a verifiable audit export

Date: 2026-10-15. Part of [issue #40](https://github.com/endqwerty/mainworthy/issues/40).

## Problem

An instance archive can restore data, but cannot isolate an inspection period or
check the decision references without importing it. An admin needs a project audit
file that can be checked on a machine without the server.

## Decision

`audit` is one admin-only, project-scoped read operation in the registry. The CLI
adapts it as `mainworthy audit export`; `mainworthy audit verify <file>` checks a
local file without a server or credentials. Export uses the registry's consistent
read snapshot and changes no standing, command log, or project sequence.

The transfer module owns the explicit cross-table projection, as it does instance
archives. A pure core module owns the version 1 schemas, canonical encoding, checksum,
and reference verification. Adding readers to each domain was considered, but would
spread export selection and dependency rules across several interfaces. A separate
streaming HTTP route was rejected because this capability belongs in the registry.
The operation buffers its JSON reply and NDJSON text. Operators should choose a
smaller time range when a project's retained history is large.

Export selects events in `[from, to)`, using Unix milliseconds. The default is all
retained history through the read snapshot's server time. A requested end later than
that time plus one millisecond is refused. Records include every retained answer,
decision, policy version, and case version in the range. Withdrawals, expirations,
and outdated decisions remain decisions with their recorded answers. Decision,
answer, policy, and case-version events retain their time, sequence, attribution,
and recorded content. Question records and
hash-only evidence records supply reference context. Mutable question titles,
evidence payloads, and current question state are not presented as historical facts.

Decision creation now retains the question's exact seen-evidence hash in
`decisions.on_evidence`. Migration `0016_decision_evidence.sql` leaves this column null on older decisions.
An export marks their evidence `not-recorded` and verification reports their count.
It never infers an old hash from today's question or from a coincident answer.
Answers already retain their exact evidence hashes. Case and policy changes refer
to their adopting decisions. The initial policy legitimately has no decision.

Actor ids remain the attribution keys. Names are resolved at export time, so a
forgotten actor uses its pseudonym. Team history records creation, membership and
grant changes. The export includes events for teams with a current or historical
grant on this project or every project, but excludes grants and events for other
projects. Team context includes current members and scoped grants, explicitly
labelled `teamState: "at-export"`. This state does not reconstruct membership at
a historical decision. Team events have no project sequence, so they retain their
instance event id and time instead. Removal of team membership by forgetting has
no retained event history. The header declares
`grantChanges: "team-history-only"`; credentials and personal grants stay out.

Personal grant changes are not reconstructed from `commands`. An admin request
sent with `cmd` can retain its actor, time, and outcome, but command ids are optional.
The row identifies the operation as `admin`, stores a digest of the request, and
does not retain the requested action or previous grant. A successful removal's
`{ removed: true }` outcome does not identify the affected person or project.
Some grant-setting receipts reveal the resulting grant, but they cannot form an
exact or complete grant history. Exporting these as grant events would imply more
than the records prove. Keep `grantChanges: "team-history-only"` until dedicated
personal grant events exist, rather than build a partial inference from receipts.

Inherited failure decisions retain their complete immutable `effects.inherited`
mapping and add typed references to every head result and base result. Result
context includes its test, target, commit, repository, environment, job, method,
producer, outcome, signature, time and sequence, even before `from`. Verification
checks the mapping against the effects and the matching failure lanes. Automatic
expirations and outdated decisions stay in the ledger; mutable `result_excuses`
standing is not presented as historical evidence. Retained `change_ends` rows are
exported separately as `change-end` records, with the change id, key, repository,
ending time, and merged or closed state. They explain a currently ended change
without inventing an actor or sequence that the table does not retain. Reopening
deletes the row and closing again replaces it. Historical ending and reopening
events are therefore unavailable, including when a selected historical range
predates a later reopening. This projection adds no migration or new write path.
The five kinds and answer discriminators are unchanged since
the branch base; decision 0042 changed how automatic `inherited` answers work.
Policy records retain their complete settings, including custom field definitions,
and verification checks clauses and settings against the core policy schemas.

## Format and validation

The stable format is documented in [the data guide](../guide/data.md#export-and-verify-an-audit).
Every line is canonical JSON with sorted object keys and a single LF. The first
line is a versioned header. The last line gives the record count and a SHA-256
checksum of all preceding UTF-8 bytes, including their LFs. Version 1 rejects
unknown keys, unsupported formats, duplicate keys or ids, extra or missing lines,
a leading byte-order mark, and a bad checksum or count. A shared core comparator
defines export and verification order: context by id using English collation,
then events by time, sequence, and id, with missing sequences treated as zero.
The verifier reports record errors with the line and id, without raw schema JSON
or repeated error prefixes. JSON parsing and schema validation have separate
error boundaries so canonicalization errors are not wrapped a second time.

References either resolve to a typed record in the file or identify an existing
event before the requested range. The exporter checks those old events in the same
project snapshot. The offline verifier checks the marker's timestamp, referenced
types, project sequence order, evidence-hash associations, prior chains, cycles, and case body
hashes. Case and policy predecessors are contiguous. Question context retains its
opening sequence (`seen_first`), so an answer or decision cannot precede it in the
project sequence. Demo dates may run backward, even between opening a question and
answering it, so a predecessor need not have an earlier timestamp. A range that cuts such a
dependency fails closed and asks for a wider end date. Question and evidence
context always resolve inside the file. The checksum
does not authenticate the source. An offline check cannot prove database completeness,
original evidence payloads, or the truth of a before-range assertion. A person who
can rewrite the file and checksum can construct another internally consistent file.

Migration 15 adds only a nullable, non-key column with no non-NULL default or
backfill. A missing value preserves the existing `not-recorded` behavior, so it
uses `archive: false`. `ARCHIVE_VERSION` remains the last breaking migration,
`result_excuses`, currently 13. Existing current-format archives import with NULL
decision evidence; the shared importer already fills missing nullable columns.

## Later slices

Re-authenticated signatures with a recorded meaning, retention and legal hold,
and decision-recorded redaction of typed text remain separate work. A human-readable
audit report and a customer's validation package are also absent. This export closes
a concrete copying and structural-validation gap. It establishes no regulated
conformance, electronic signature ceremony, or certified system validation.
