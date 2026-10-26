# A report names when its tests ran

- Date: 2026-10-26
- Status: proposed
- Issue: https://github.com/endqwerty/mainworthy/issues/722

The owner asked how long a change run took, not only the test time (the sum of the counted results' durations,
which adds up results that ran side by side). The times Mainworthy stores are when the server received a report, so
the spread between the first and last receipt measures uploads, not the run. On 2026-10-26 the owner chose to show
"Reported test span" only when every contributing report has usable start and end times and nothing declared is
still pending, and nothing new otherwise.

## Decision

**A report may carry a span, and it is evidence, not the time of a write.** `report` takes an optional
`span: { startedAt, endedAt }`, whole milliseconds since 1970 by the runner's clock, with `endedAt >= startedAt`. It
is stored on the report's batch (`batches.started_at`, `batches.ended_at`, migration 0005) beside `at`, which stays
the server's. Like a result's `durationMs`, it says what the report observed. Decision 0100 still holds for every
time a write is stored at: a span moves no `at`, no sequence, no hold and no gate. The rule in `AGENTS.md` now says
"no write time" in an operation's input: a span is not one.

**A change run shows the earliest start to the latest end of the reports it counts, or nothing.** The reports are
the batches the gate's counted results came from, whatever filter or page is read. The span is null when there are
no counted results, when any of those batches named no span, when a declared shard has not reported, or when an
accepted report is not yet applied. `find --in results` returns it as `reportedSpan` beside `testTime`; the web
change run and the iPhone show it as "Reported test span".

**Formats give a span only where their timing is unambiguous.** Playwright JSON: `stats.startTime` and
`stats.duration`. Jest and Vitest JSON: the run's `startTime`, or its first file's, to the latest file `endTime`,
only when every file names both. JUnit: each outermost `testsuite`'s `timestamp` and `time`, only when every
outermost suite holding a result names both and the timestamp names a zone; nested suites run inside their parent's
span and are not read. pytest-json-report and TRX give none until their semantics are checked. A file whose timing
is present but unusable keeps its results, gives no span, and the CLI warns once. When the CLI sends several files
as one report, it sends a span only when every file has one.

**A span is part of what makes a report the same report.** The batch key includes the span when there is one, so
the same files sent twice are one batch, and a report sent again with other timing is another report. Reports with
no span keep the keys they had.

## Why not the alternatives

- **Leave it out and point at the build link.** The issue's first option; the owner wanted the number in
  Mainworthy.
- **Show a partial span ("2 of 3 reports timed").** The timed subset can miss the first or last work, and the number
  grows as reports arrive. The owner chose nothing over a partial number.
- **Receipt times.** They measure uploads.
- **`--started` and `--ended` flags on `mainworthy report`.** A CI script would most likely pass the job's own start,
  which includes checkout and installs, under the same label. Left out until a runner's own timing is missing where
  it is needed; the API takes `span` from any caller that has one.

## What it does not say

A span is the runners' account: shards on machines whose clocks disagree distort it, a retry's wait between attempts
is inside it when both attempts supply counted results, and work no report covers (checkout, builds, jobs that never
declared themselves) is outside it. It is not the build's duration. The guide says so on the page that shows it.
