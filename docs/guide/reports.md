# Reports

Read what the results of the last days say: how often tests pass, which tests are flaky, how much time reruns
cost, how much of the suite is automated, and which requirements have cases that pass.
Every report reads the one stream of results, from people, pipelines and agents alike.

![Reports with the pass rate per day of the demo shop](../ui/screenshots/reports-light.png)

## Open a report

1. Press <kbd>g</kbd> <kbd>o</kbd> to open Reports.
2. Select a report from the list. Each row shows its headline number.
3. Choose how many days to read: 7, 14, 30 or 90. Pass rate reads calendar days, today included. The other
   reports read that many 24-hour periods back from now.

Use <kbd>j</kbd> and <kbd>k</kbd> to move between reports.

From the command line, `mainworthy stats --of <report>` prints the same report as JSON, for example
`mainworthy stats --of flaky --days 14`. Over HTTP it is `POST /api/p/<project>/stats` (see [the API](./api.md#stats)).
Agents read reports this way too: `stats` is not one of the agent tools.

The flaky, rerun and automation reports list 20 tests or cases, and coverage lists 100 requirements. The headline
numbers count all of them. To list more, pass `--limit`: up to 200 rows, or 500 requirements for coverage.

## Pass rate

The share of results that passed, per day, of those that passed or failed. Skipped and blocked results are counted
beside the rate and are not in it.

- Each test counts once for each job, producer and method on each target, by its latest attempt that passed or
  failed. A target is what was tested: a commit in one repository and environment, or a run with no commit. Two
  environments of one commit count apart.
  A later skip or blocked attempt does not replace a pass or a failure, and of two results for one attempt the worse
  counts. A failure that a rerun of the same job then passed counts as a pass, and the failed attempt is in
  [time lost to reruns](#time-lost-to-reruns). This is the rule a gate counts with.
- A result its producer corrected is replaced by the correction.
- A failure recorded while its test was in [quarantine](./report-results.md#quarantine-an-unreliable-test) is counted as
  quarantined, apart from the failures, and does not lower the rate. Quarantine that starts or ends later does not
  change how earlier results count.
- The days are the reader's. The web page uses your browser's time zone. The command line and the API use UTC
  unless you give `--zone` with a time zone's name, for example `--zone Europe/Berlin`. An offset such as `+05:30`
  is refused.
- Choose a producer to read only people's, pipelines' or agents' results (`--method human`, `auto` or `agent`).

## Flaky tests

A flaky test passed and failed on the same code: the same target (repository, commit and environment), job and
producer, one attempt after another.
Mainworthy records such a flip when the report arrives. A flip whose pass or failure its producer later corrected
is not counted. The report lists the automated tests with flips in the window, the most flips first, and says which
of them are in quarantine. The headline compares them with every automated test that reported in the window, whoever
reported it.

## Time lost to reruns

An attempt that a later attempt of the same test, job, commit and producer repeated is a rerun, counted once
however many times that attempt was reported. The report adds up the time those attempts took, as their reports said
it (of an attempt reported twice, the time of the result it counted: the worse, then the later), and lists the tests
that cost the most. A correction counts in place of the attempt it corrects, its time included, whichever attempt
the correction was sent with. Where older stored history has two corrections of the same result, the attempt
counts the worse of the corrections that stand, then the later.

The runner's earlier tries inside an attempt also count as reruns, even if the pipeline ran only once. Each try
adds its reported duration. When a later pipeline attempt repeats the whole attempt, its reported duration counts
once, without adding known try durations again: Playwright already sums those durations. A try without a duration
always counts as unreported time, even if its attempt has a duration: Surefire times only one execution.
If the repeated attempt's duration is missing, the report keeps the known try durations. For an attempt not repeated,
only its earlier tries count; the final execution is not time lost. A correction replaces its result's tries too.

Each test's time and the report's total stop at 9,007,199,254,740,991 ms, JavaScript's largest safe integer.
Old or imported durations above today's input limit cannot overflow the report; a time at that ceiling means
at least that much was reported. Negative stored durations cannot make a test's time or the report's total
less than zero.

## Automation

A case is automated when an automated test is linked to it. The rate is the automated cases over the active cases
that can be automated: a case marked as one that cannot be automated is left out, unless a test covers it anyway.
The other cases are counted by what they say about automation: to automate, not decided, or cannot be automated.

The backlog lists the cases that can be automated and are not, the ones run by hand most often in the window
first. Where people recorded how long a run took, the time is shown too. Each case's total stops at
9,007,199,254,740,991 ms, including larger historical or restored durations. A reported zero is zero;
when no run reported a duration, the time stays unknown.

## Coverage by requirement

Each requirement with the active cases that cover it. The list shows the first 100 requirements, and the headline
counts all of them. A case counts by the latest result of each of its tests in
the window: failed when one of them failed, passed when none failed and one passed, skipped or blocked when that
is all they were, and not run when none of its tests has a result in the window. A requirement with no active case
is marked. A case covers a requirement through `covers: [KEY]` in its Markdown, or `@KEY` on the title line of a
capture outline.
