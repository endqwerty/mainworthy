# 0085: A person quarantines a test with an explicit exit rule

Date: 2026-10-15. Status: proposed for part of issue #38.

Amended 2026-10-15 for issue #338, by the owner's decision. Quarantine covers
observations reported while it stood. Ending it must preserve past verdicts.
Reclassifying every earlier commit on each report also made report cost grow
with the test's entire history.

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

Quarantine excuses only automated failures reported after its entry decision and
before it ends, in the server's sequence. Entry does not excuse earlier results.
Each result records its covering decision when the server applies it. The time a
producer ran the test does not determine coverage. Each exit has one boundary:

- A person's accepted exit decision ends coverage at that decision's sequence.
- Expiry ends coverage at the deadline. The first result whose server time is at
  or after the deadline is not covered. Earlier results stay covered.
- A pass count ends coverage immediately after the result that first completes
  the count. That result is covered. Later results, including later results in
  the same report, are not covered.

A pass rule counts distinct trunk commits whose first result for that test
arrived after entry, using counted
automated evidence. Retrying a commit first reported before entry cannot count.
Every observed lane on a commit must pass; a failure, error, skip or blocked lane
breaks the streak. Retries use their highest decisive attempt with worse
same-attempt disagreement retained.
Agent evidence, sessions and change commits cannot satisfy the exit. A failure on
a later commit does not restart quarantine after the threshold is reached. A later
failure on a qualifying commit cannot reopen quarantine either. Before the count
is reached, a correction replaces its earlier observation in the streak. Once the
count is reached, the exit stays reached. A correction is a new observation with
coverage determined when it arrives. It may change its own commit's verdict, but
cannot change another result's coverage. The original observation remains stored.
No current quarantine row is rewritten by a detector or a clock.

Gate and planned-run classification treat only quarantined test failures as
excused, including failures already answered as a defect. Quarantine takes
precedence for results reported while it stood. Entering quarantine leaves an
earlier defect's verdict unchanged. A later failure of that test is excused while
covered, even if the defect answer still applies. Ending quarantine leaves both
that coverage and the independent defect answer in force. The original results
remain, with the quarantine count in the
gate reply and reason, including when another failure blocks the run. A gate may
return `passed`, but its reason explicitly says how many quarantined failures were
recorded and are not blocking. Missing evidence and required jobs still block.
Every exit restores ordinary failure classification only for later observations.
Entry and exit decisions recompute no old runs. A report recomputes only the runs
whose evidence it changes. Planned runs, including ones created after the exit,
use the recorded coverage of their results.

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
hides lane folding and exit evaluation inside evidence. A nullable decision ref
on each result records coverage. A result that first completes a pass count also
records the entry decision it ended, so later observations cannot reopen it.
These are derived observation metadata, not another standing writer. A full
quarantine-interval history was rejected because ordinary classification needs
only the decision that covered the observation.
The run fold stores the quarantined-failure count with its tally. Gate reads use
that projection, without refolding evidence or evaluating a current quarantine.

## Archives and tradeoffs

Migration 0021 adds an exported table and raises the archive version. Entries,
reasons, decisions and observations travel together; imported expiry rules use
the destination server's clock. Older archives are refused, as before a breaking
archive change. The edit is omitted from MCP discovery to preserve the tool token budget. It remains
available through the registry, HTTP, CLI and web UI. No credentials travel.
Migration 0023 adds the two observation decision refs, the run's derived count,
and raises the archive version. Earlier observations have no recorded coverage and are not retroactively
excused. Older archives must be exported again with this build.

The audit export includes every quarantine entry and manual-exit decision. Its
immutable effects retain the test ref, prior quarantine decision and exit rule,
while the decision retains the person's reason, attribution, time and sequence.
The mutable current quarantine row is not a historical audit record. Tracker
closure ends only the defect hold and cannot end quarantine. Ending quarantine
leaves any independent defect hold in force. In a disputed planned-run slot,
quarantine excuses only that test's automated failures; other failures still
require their own settlement.

Gate reads use observation-time coverage, so an expiry cannot change an earlier
verdict. Stable-trunk flaky detection and a separate flaky question kind remain
outside this slice of issue #38.
