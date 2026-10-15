# 0085: A person quarantines a test with an explicit exit rule

Date: 2026-10-15. Status: proposed for part of issue #38.

## Problem and existing flow

Same-code evidence suggests investigation and changes no standing. A failure answer
covers a cause and scope, rather than one test across the project. Quarantine must
name a test and keep every observation. The registry seals proposals, decisions
mint witnesses, and run folds classify counted results. Those boundaries remain.

## Usage

Read `get` on T-1, then propose one edit with a reason:

```json
{"edits":[{"op":"quarantine","test":"T-1","base":null,"exit":{"kind":"passes","count":3}}],"reason":"Retry outcomes disagree on unchanged code"}
```

A person accepts the proposal in the queue with a reason. `base` is the last
quarantine decision returned by `get`, or null before the first decision. It guards
against applying a proposal after somebody changed that test's quarantine.
An edit with `exit: null` ends quarantine. Other exit rules are
`{"kind":"person"}` and `{"kind":"expiry","at":1800000000000}`.
The expiry is a condition, not the time of the write; the server dates the decision.

## Shape

`QuarantineExit` is a discriminated union. Evidence owns `quarantines`, with the
adopting decision, person, reason, entry time, sequence and exit rule. Its writer
requires an adopt witness. Proposal sealing keeps the requested edit; the decision
handler validates the project test and the base before writing it. Only automated
tests qualify. Quarantine edits stand alone, so their person-only authorization
cannot unexpectedly change authorization of other edits.

Every preset asks a person with answer authority and a reason. An agent may
propose and advise, but never accept or reject this proposal or end standing.
Detector evidence remains optional context; no detector writes quarantine.

Active quarantine is derived from the witnessed entry and immutable observations.
Expiry is inactive at the exact deadline. A pass rule counts distinct trunk
commits whose first result for that test arrived after entry, using counted
automated evidence. Retrying a commit first reported before entry cannot count.
Every observed lane on a commit must pass; a failure, error, skip or blocked lane
breaks the streak. Retries
use their highest decisive attempt with worse same-attempt disagreement retained.
Agent evidence, sessions and change commits cannot satisfy the exit. Once the
threshold is reached quarantine stays ended, even after another failure. Correcting
an observation can change the derived exit because the corrected observation no
longer stands. No current row is rewritten by a detector or a clock.

Gate and planned-run classification treat only quarantined test failures as
excused, including failures already answered as a defect. Quarantine takes
precedence while it stands. If that defect is the gate's only blocker, entering
quarantine changes its verdict from `failed` to `passed`. Ending quarantine leaves
the defect answer in force. The original results remain, with the quarantine count in the
gate reply and reason, including when another failure blocks the run. A gate may
return `passed`, but its reason explicitly says how many quarantined failures were
recorded and are not blocking. Missing evidence and required jobs still block.
Expiry and a pass exit restore ordinary failure classification, including for old
commits. A read derives the current gate where a quarantine applies, so no background
sweep is needed to stop a gate passing. Entry, manual exit and new evidence refold
affected runs, including planned runs.

`find` with `in: tests, state: quarantined` lists active entries with why, when,
who and the exit rule. `get` also returns the last entry after it ended, so a
client can base its next proposal on it. The same list and proposal controls appear
beside failure evidence and under Settings' detector settings.

## Synthesis decision and alternatives

Two shapes were considered. A new question kind could own entry and exit, but it
would duplicate proposal review and add a question vocabulary to every client.
An adopt edit reuses review, reasons, stale-evidence checks and the ledger, while
keeping quarantine classification inside evidence. The latter is the base.
Automatic exit is derived rather than a second standing writer. The interface
hides lane folding and exit evaluation behind one effective-quarantine read.

## Archives and tradeoffs

Migration 0020 adds an exported table and raises the archive version. Entries,
reasons, decisions and observations travel together; imported expiry rules use
the destination server's clock. Older archives are refused, as before a breaking
archive change. The edit is omitted from MCP discovery to preserve the tool token budget. It remains
available through the registry, HTTP, CLI and web UI. No credentials travel.

The audit export includes every quarantine entry and manual-exit decision. Its
immutable effects retain the test ref, prior quarantine decision and exit rule,
while the decision retains the person's reason, attribution, time and sequence.
The mutable current quarantine row is not a historical audit record. Tracker
closure ends only the defect hold and cannot end quarantine. Ending quarantine
leaves any independent defect hold in force. In a disputed planned-run slot,
quarantine excuses only that test's automated failures; other failures still
require their own settlement.

We accept evaluating quarantine exits on gate reads in exchange for expiry that
cannot leave a stale green gate. Stable-trunk flaky detection and a separate flaky
question kind remain outside this slice of issue #38.
