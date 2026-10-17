# Reports

Read what the results of the last days say: how often tests pass, which tests are flaky, how much time reruns
cost, how much of the suite is automated, and which requirements have cases that pass.
Every report reads the one stream of results, from people, pipelines and agents alike.

![Reports with the pass rate per day of the demo shop](../ui/screenshots/reports-light.png)

## Open a report

1. Press <kbd>g</kbd> <kbd>o</kbd> to open Reports.
2. Select a report from the list. Each row shows its headline number.
3. Choose how many days to read: 7, 14, 30 or 90. Today is one of them.

Use <kbd>j</kbd> and <kbd>k</kbd> to move between reports.

From the command line, `mainworthy stats --of <report>` prints the same report as JSON, for example
`mainworthy stats --of flaky --days 14`. Over HTTP it is `POST /api/p/<project>/stats` (see [the API](./api.md#stats)).
Agents read reports this way too: `stats` is not one of the agent tools.

## Pass rate

The share of results that passed, per day, of those that passed or failed. Skipped and blocked results are counted
beside the rate and are not in it.

- Each test counts once for each job and producer on each commit, by the attempt it ended with. A failure that a rerun of the
  same job then passed counts as a pass, and the failed attempt is in [time lost to reruns](#time-lost-to-reruns).
  This is the rule a gate counts with.
- A result its producer corrected is replaced by the correction.
- A failure of a test in [quarantine](./report-results.md#quarantine-an-unreliable-test) is counted as quarantined, apart from the failures, and does not
  lower the rate.
- The days are the reader's. The web page uses your browser's time zone. The command line and the API use UTC
  unless you give `--zone` with a time zone's name, for example `--zone Europe/Berlin`. An offset such as `+05:30`
  is refused.
- Choose a producer to read only people's, pipelines' or agents' results (`--method human`, `auto` or `agent`).

## Flaky tests

A flaky test passed and failed on the same code: the same commit, job and producer, one attempt after another.
Mainworthy records such a flip when the report arrives. A flip whose pass or failure its producer later corrected
is not counted. The report lists the automated tests with flips in the window, the most flips first, and says which
of them are in quarantine. The headline compares them with every automated test that reported in the window, whoever
reported it.

## Time lost to reruns

An attempt that a later attempt of the same test, job, commit and producer repeated is a rerun, counted once
however many times that attempt was reported. The report adds up the time those attempts took, as their reports said
it (of an attempt reported twice, the time of the result it counted: the worse, then the later), and lists the tests
that cost the most. A correction counts in place of the attempt it corrects, its time included, whichever attempt
the correction was sent with. Where a result was corrected twice, the attempt counts the worse of the corrections
that stand, then the later. An attempt whose
report gave no duration is counted, and its time is not: the report says how many there were.

## Automation

A case is automated when an automated test is linked to it. The rate is the automated cases over the active cases
that can be automated: a case marked as one that cannot be automated is left out, unless a test covers it anyway.
The other cases are counted by what they say about automation: to automate, not decided, or cannot be automated.

The backlog lists the cases that can be automated and are not, the ones run by hand most often in the window
first. Where people recorded how long a run took, the time is shown too.

## Coverage by requirement

Each requirement with the active cases that cover it. A case counts by the latest result of each of its tests in
the window: failed when one of them failed, passed when none failed and one passed, skipped or blocked when that
is all they were, and not run when none of its tests has a result in the window. A requirement with no active case
is marked. A case covers a requirement through `covers: [KEY]` in its Markdown, or `@KEY` on the title line of a
capture outline.
