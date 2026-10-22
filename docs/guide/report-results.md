# Report results

Send a test report from a runner or CI, then read the gate for the tested commit.
Keep the pipeline's identity, retries, and case links with its results.

## Upload JUnit XML

To upload results and read the verdict, follow these steps.

1. Configure your runner to write a JUnit XML file, such as `results.xml`.
2. Run `mainworthy report results.xml` to upload the file to your instance.
3. Run `mainworthy gate` to read the verdict for the tested commit.

You can pass several files or a shell glob such as `results/*.xml`.
The receipt lists outcomes, new or existing questions, result bases,
and the gate at the time of the upload. Counts use singular nouns for one result,
claim, attachment, or assumed case version. A declined claim keeps its result
without a case. Skipped attachments leave the report's results intact.

"1 result had no case or version when recorded" counts results with an unresolved
basis, even if the project's policy has since created cases or someone has linked
the tests. Several results can belong to the same test. See [tests with no case](./policy.md#tests-with-no-case)
for the policy choices.

The totals and each basis count results, not distinct tests. For two passing
results from one unmapped test, the receipt includes:

```text
  2 results   2 pass   0 fail   0 skip
  2 results had no case or version when recorded
  basis: unresolved 2 results (no case or version when recorded)
```

An assumed basis uses the case version current when the result was recorded.
Linking the test, editing the case, or changing policy does not change a replayed receipt.

A successful `report` exits `0` even when tests fail. Use `gate` for the verdict.
An invalid input or refused command exits `4`. See [changes](./changes.md).

A result's `corrects` names an earlier result of yours that has not already been corrected.
If another report has replaced that result, or an accepted report is still waiting to apply
its correction, the server refuses the whole report with `conflict` before accepting it.
After an interruption, retry the first report or let server startup finish it.
Read the latest results and correct the current result instead.
Two results in one report cannot correct the same earlier result.

Sending an identical report again returns the original receipt and says
"already received; nothing was written". The receipt's gate line shows the verdict
at the first upload. A repeat can therefore show "blocked" for a commit
that has passed since. The command explains this on stderr and points at
`mainworthy gate` to read the current verdict.

Reports also fill qualifying slots in planned runs that accept the tested commit,
even after those runs close. A late report makes the run's gate `pending` until
Mainworthy applies all accepted reports. If the report added or corrected
qualifying slot results, Mainworthy reconsiders the run's sign-off on the new evidence. A report
that does neither leaves the approval in place. See [planned runs](./runs.md#close-and-reopen-a-run).

[Diagram: one red build, from upload to a green gate](../diagrams/red-build.html)

## Upload a native report

The same command reads Playwright JSON, Jest JSON, Vitest JSON,
`pytest-json-report` JSON, and Visual Studio Test TRX. It detects each file
independently, so one upload can include different formats:

```sh
$ mainworthy report playwright.json unit-results.json results.trx
```

Use `--format` with `junit`, `playwright`, `jest`, `vitest`, `pytest`, or `trx` to select
one format for every file in the command. The default is `--format auto`. Jest and Vitest use
the same JSON structure. Detection reads the content. A `.trx` extension also
selects TRX, and a `.json` extension makes invalid JSON an input error.

The commands below produce and upload each native report format.

| Runner | Produce the report | Upload |
| --- | --- | --- |
| Playwright | `PLAYWRIGHT_JSON_OUTPUT_FILE=results.json playwright test --reporter=json` | `mainworthy report results.json` |
| Jest | `jest --json --outputFile=results.json` | `mainworthy report results.json` |
| Vitest | `vitest run --reporter=json --outputFile=results.json` | `mainworthy report results.json` |
| pytest with `pytest-json-report` installed | `pytest --json-report --json-report-file=results.json` | `mainworthy report results.json` |
| .NET | `dotnet test --logger "trx;LogFileName=results.trx"` | `mainworthy report TestResults/results.trx` |

Pytest's built-in report export is JUnit XML (`pytest --junitxml=results.xml`).
Its JSON adapter requires the separate
[`pytest-json-report` plugin](https://github.com/numirias/pytest-json-report),
with test details enabled. A summary-only report has no executions to upload.
CTRF is not supported.

Native adapters keep the file, suite path, test name, case annotations in the
name, duration, and failure diagnostics. Playwright includes the project name
in the test key, so Chromium and Firefox results stay separate. TRX uses the
class in `TestDefinitions` when present, together with the test name. Its
assembly path is not a source file. A TRX test without a definition keeps its name as its key.
The report's filename and TRX execution IDs do not enter test keys.

Jest and Vitest source paths are relative to the report's `rootDir` when present.
Otherwise the command uses the Git checkout's top level, or its working directory
outside Git. Run the command in the source checkout that produced the report,
including when the report file is stored elsewhere. Running from the source
checkout keeps keys stable between checkouts. The JSON reporters normally omit `rootDir`.
The command refuses a relative `rootDir`, a filesystem root, or a source path
outside the chosen root. It exits with code 4 and names the report file and root.

Keep source paths and suite names stable. Switching exporters can change those
values. Before switching an existing pipeline, compare the exporters' keys. An
unlinked native test follows the same project policy as an unlinked JUnit test.

Long names and source files are shortened to at most 500 UTF-16 units, failure
messages to 4,000, and failure details to 20,000. Shortening keeps whole Unicode
code points, so text stays valid; an emoji made of several code points can still
be shortened. Test keys longer than 1,000 units keep a prefix
and a digest of the full original identity, so differences beyond the prefix
still distinguish tests. These limits apply to JUnit and native reports.

Native reports with unknown statuses, malformed test details, or errors outside
test executions stop the upload with exit `4`. No files in that command are
sent. A pytest test passes only when its call stage ran and passed: a test with
no call stage (other than one skipped in setup) is refused, a skipped call is a
skip, and a failed setup or teardown is an error. A pytest report with
`exitcode` 1 and no failed or errored test is refused too. Keep the runner's
exit status as a CI check too, since a report cannot prove work that the runner
omitted. JUnit keeps its existing parser and warnings.

## Report that no tests are required

When path filters require no tests for a commit, a pipeline can explicitly declare that fact:

```sh
$ mainworthy report --nothing-required --commit 1111111111111111111111111111111111111111
$ mainworthy gate --commit 1111111111111111111111111111111111111111
```

The declaration needs a CI token and accepts no files, results, or planned run.
CI detection can supply the commit, job, and other build metadata as for an
ordinary report.

All presets keep this gate pending by default. Before the declaration can pass
the gate, a project admin must record `mainworthy policy empty nothing-required`. See
[reports with no tests](./policy.md#reports-with-no-tests) for the policy choice
and its record.

The declaration passes only a commit with no ordinary reports. It cannot turn skips, refused results, agent results, or an existing failure into a pass. It never satisfies a planned run or a required CI job. An empty JUnit file without the explicit declaration is refused.

## Identify the tested build

Mainworthy detects GitHub Actions, GitLab CI, CircleCI, Buildkite, Jenkins,
Azure Pipelines, and Bitbucket Pipelines.
It reads the commit and available branch, repository, pull request, base commit,
environment, job name, attempt number, and build URL. Not every provider supplies every field.

In GitHub Actions, pull request event data identifies the pull request's head commit.
It also supplies the base commit, title, and URL when present.
`GITHUB_JOB` supplies the job name, and `GITHUB_RUN_ATTEMPT` supplies the attempt.
The repository and run ID form the build URL.

If a `pull_request_target` event has no readable head commit, supply the tested
commit explicitly. If you test a checkout other than the detected head, override it too.
Mainworthy cannot infer which checkout your test command actually exercised.

Use these environment overrides when detection does not describe your run:

- `MAINWORTHY_COMMIT`, `MAINWORTHY_BRANCH`, and `MAINWORTHY_REPO` identify the tested code.
- `MAINWORTHY_PR` and `MAINWORTHY_BASE` identify the change and its starting commit.
- `MAINWORTHY_ENV` names the test environment.
- `MAINWORTHY_JOB`, `MAINWORTHY_ATTEMPT`, and `MAINWORTHY_BUILD_URL` describe the execution.

Nonempty overrides take precedence over provider variables. Empty values count as unset.
Command flags such as `--commit`, `--job`, and `--attempt` take precedence over detection.
See [configuration](./configuration.md) and [the CLI guide](./cli.md) for the full forms.

Outside CI, Mainworthy reads the commit, branch, and repository from Git.
If there is no Git checkout, name the commit:

```sh
$ mainworthy report results.xml --commit 1111111111111111111111111111111111111111
```

Use `--session <name>` for work with no build identity. A session proves nothing
about a commit's gate. A detected CI provider with no valid commit does not borrow
an unrelated commit from the local checkout.

## Follow a branch reset

If a branch is reset or force-pushed to a commit already reported, read its current head
from the code host when you send the report. Pass that hash with `--head`:

```sh
$ mainworthy report results.xml --pr 482 --commit 1111111111111111111111111111111111111111 --head 2222222222222222222222222222222222222222
```

`--commit` identifies what the results tested. `--head` identifies the change's current
head, which can be another commit. Use `--pr` or a non-trunk `--branch` to name the change.
Through the API, put the hash in `target.head` on `report`. A session target cannot carry a head or other build identity.

A pipeline or person can supply the head. An agent's report cannot move it.
Mainworthy follows an explicit head in either direction. If that commit has no counted
results, the change's gate is pending. The receipt still shows the tested commit's gate.

Only results for that current head can clear a failure question about the change or end
an answer that needs a fix. A passing retry on a discarded commit stays recorded but
leaves the current head's question or answer in place. A passing retry on the current
head can still clear it.

CI detection does not supply `--head`. An old workflow event can name an outdated head,
so read the code host's current value instead of copying the event's commit.
Without `--head`, reports keep their first-reported ordering. A commit already reported
before a head observation cannot replace that head with a late job.

An identical report with the same head and build URL is a retry and does not move the
change again. With `--head`, the build URL distinguishes a new CI run even when its
results and attempt number match an earlier run. GitHub Actions supplies a URL containing
the run ID. Other producers can set `MAINWORTHY_BUILD_URL` or send `buildUrl` in JSON.
Keep it unchanged for a retry.
Without a build URL, use a new `--attempt` number for a fresh observation with identical
results and the same head. Through the API, a new `cmd` value also names a fresh
observation. Reuse that value when retrying the command.

## Link tests to cases

Put a case annotation in the test name, in JUnit or a native report:

```xml
<testcase name="percentage coupon @C-1@v1" classname="checkout" />
```

`@C-1` names the case without claiming a version. `@C-1@v1` also claims version `1`.
You can instead put a property inside the test case:

```xml
<testcase name="percentage coupon" classname="checkout">
  <properties>
    <property name="mainworthy" value="C-1@v1" />
  </properties>
</testcase>
```

An [imported alias](./data.md#bring-cases-from-another-tool), such as `C1234` or `PAY-7`,
works wherever a case ref does here. Use `@C1234` in a name or `C1234` in a property.
To claim version 1 in Mainworthy, add `@v1`. The claim does not name the version
in the source tool.
Aliases keep their original letter case and resolve within the report's project.
In a name, native refs match without regard to letter case: `@c-2` names `C-2`.
Mainworthy normalizes native refs to uppercase and leaves alias letter case unchanged.
A non-native `@token` claims a case only when that alias exists in the report's project.
Mainworthy ignores other tokens, such as `@smoke`, `@media`, and the address in
`user@example.com`, when those tokens name no alias. Those tokens do not hide a
later native ref or drop a previously decided link.
Trailing sentence punctuation is excluded from name claims: `@C1234.` names `C1234`.
Use explicit metadata for an alias whose final punctuation belongs to its identifier.
Separate claims with whitespace. Glued tokens such as `@smoke@C-2`,
`@C-2x`, and `@C-2@v1x` do not claim a case.

Name annotations work in JUnit, Playwright, Jest, Vitest, and TRX test names,
and in pytest node IDs, including parameter IDs. The following formats also
carry case claims outside the name:

- JUnit uses the `mainworthy` property shown above.
- Playwright JSON uses a test annotation with `type: "mainworthy"` and `description: "C1234@v1"`.
- pytest-json-report uses `record_property("mainworthy", "C1234@v1")`, serialized as `user_properties: [{"mainworthy": "C1234@v1"}]`.

Mainworthy resolves name claims when it receives the report, using the aliases in that project.
The last valid claim in a name wins. For example, `checkout @C1234 then @C-2` names `C-2`.
With several native refs, this changes the earlier behavior that selected the first ref.
An unknown non-native token is ignored even after a valid claim.

These properties and Playwright annotations take precedence over every claim in the name.
When several explicit metadata claims name the case on one test, the last syntactically valid claim wins.
An unknown alias in explicit metadata is recorded without a case, just as for
an unknown native ref. The receipt explains why.
Metadata preserves the alias's punctuation and requires uppercase native refs.
A test can also use a link previously decided in [Queue](./decide.md).

Mainworthy identifies a test using its file, or its class name when there is no file,
together with its suite path and name. Keep those values stable across reports.
The report file's name is not the test's source file.

What happens to a test without a case is the project's choice. Under `loose` and `standard`
the policy starts as "Track without a case". Mainworthy keeps the test and asks
nobody. A project can instead create a case for each such test or raise an
unlinked-test question for each file. The `strict` preset starts with questions. See [policy](./policy.md#tests-with-no-case).
An unlinked automated test still counts toward the commit gate.

## Read what each test did

To find an automated test, follow these steps.

1. Press <kbd>g</kbd> <kbd>t</kbd> to open Tests.
2. Type a name or file in the filter.
3. To show tests tracked without a case, check "Only tests with no case".
4. Use <kbd>j</kbd> and <kbd>k</kbd> to select a test.

Tests lists every automated test the project's reports have named, newest first.
Each row shows the test's file and its case or "no case".

A test's page shows its file, key, and case. It also shows how often the test flipped
between passing and failing on the same code, and any quarantine in force.
"Latest results" lists its last twenty results, newest first. Each row shows the
outcome, any commit and change reported with it, the job, duration, producer, and
failure message when present. Attempts after the first show their number.
A failure that a later attempt of the same job, producer and environment passed on the same
commit says "flaky", and "passed on attempt" with the attempt that passed. A result whose
runner tries disagree also says "flaky", lists the runner's tries in order, and shows an earlier
try's failure when the result has none. The flip count leaves
out a flip whose failure or pass its producer corrected.
"build" opens the CI build when the report supplied an HTTP or HTTPS URL.

To see every result of one commit, open its change in [Changes](./changes.md#read-the-results-behind-the-verdict).
From the command line, `mainworthy get T-12` prints the test's details as JSON.

## Read the result's basis

To report execution of a deployed artifact, use `--build <label> --env <environment>`.
This selects the announced artifact instead of a commit detected from CI or Git.
The label must already be bound by `announce`. Check its planned release run with
`gate --run`, as described in [release runs](./runs.md#plan-a-release-run).

`exact` means the result names a case version, or a run pins that version.
`assumed` means a link or case annotation identifies the case. Mainworthy then uses
the case's current version without a version claim from the runner.
`unresolved` means the result has no resolved case and version.

These words describe the connection to the case, not whether the outcome is trustworthy.
A planned run can require exact results. The `strict` preset does so by default.
See [runs](./runs.md).

If an automated test's case or version claim cannot be used, the receipt explains
which claim was declined. The outcome stays recorded without a case, so a failure
cannot disappear from the commit gate because its annotation is wrong.

## Preserve attempts and retries

Use a higher `--attempt` for a rerun when your CI provider does not supply one.
Within one producer, job, target, and test, a higher decisive attempt replaces the
previous outcome. An older attempt arriving late does not replace a newer one.

The same attempt reported twice keeps the worse outcome.
A skip or blocked result does not replace an existing pass or failure.
A pass from one job or environment does not clear another job's failure.
Mainworthy records a same-code flip when a higher decisive attempt changes between pass
and failure within one producer, job, test, and target. Failure includes `fail` and `error`.
A skip does not hide the previous decisive result. An old attempt or same-attempt
disagreement adds no flip. Identical reports add nothing.

### Retries by the test runner

A runner that tries a test again inside one run, such as Playwright with `retries` or
Maven Surefire with `rerunFailingTestsCount`, reports one result per test: the outcome it
ended on. Mainworthy keeps the runner's earlier tries beside that result, oldest first, and the
gate counts only the result. A try that passed or failed where the next one did the other is a
flip, recorded as a flip between attempts is. So a test that failed once and passed on the
runner's retry reads "flaky" in a change's results and on its page, counts in
[Reports](./reports.md), and feeds the detector below. Tries that only failed, or were skipped,
add no flip.

When the pipeline also runs the job again, the earlier attempt meets the new attempt's first
decisive try, so one recovery is one flip whichever retried first. A correction of a result
withdraws the flips of its tries too. A result keeps at most a hundred tries. A Playwright report with more is
refused rather than cut, because the try that was dropped could be the one that passed. A
Surefire testcase with more keeps its first run and its last 99, with a warning: every one
failed, so those decide every flip. In the API,
a result's `tries` lists them, each with an `outcome`, an optional `durationMs` and an
optional `failure`; `mainworthy get T-1 --json` returns each recent result's `tries`, and a
detector sample names the runner's `try` at either end.

The detector counts recent flips per test and failure signature, across assertion,
timeout, and infrastructure classes. By default, two flips of one cause within
14 days suggest investigation. A file-split signature is a separate cause.
Earlier flips of the original cause do not count toward the split cause's threshold.
The failure question shows its cause's count and up to three pairs of concrete results.
Expand a count to see the commit, job, environment, producer, result ids,
outcomes, and attempts. `mainworthy get T-1 --json` returns the current evidence in
`sameCode`, including `signature`, `class`, `flips`, `suggested`, and `samples`
for each cause. `signature` contains its id and normalized text.
The question keeps the evidence shown when its occurrence was recorded.

Both observations must be in the configured window. Corrected observations and
passes contradicted by a failure at the same attempt do not support a suggestion.
The detector uses automated results on commit targets. Agent results and sessions
are excluded. The failure class comes from the normalized failure message, so an
infrastructure suggestion is evidence to investigate, not a diagnosis.

A suggestion excuses no failure. A person still gives the existing `flaky` or
`infra` answer, under the project's policy. Automatic quarantine and alternation
across different trunk commits are not built yet. Change the detector's settings
through a [policy edit](./policy.md#same-code-detector-settings).

Playwright retries become one logical test result. The highest numbered decisive
execution supplies its outcome and failure, and the executions before it are its tries, each
with its own outcome, duration and failure. A skipped retry does not erase an
earlier failure. The logical result's duration sums all executions, and a pass after retries has
the same `passed after N retries` note as JUnit. An expected Playwright failure
counts as a pass. An unexpected pass counts as a failure, for a try as for the result.

In JUnit, Surefire's `flakyFailure`, `flakyError`, `rerunFailure` and `rerunError`
elements become failed tries with their `message`. A testcase with only flaky elements
passed after them, so it is a flip. A testcase with a `failure` and rerun elements failed
every time. Surefire writes the first run as the `failure` and the later runs after it, so the
last rerun is the result and the `failure` is the oldest try. Duplicate testcases named
`(retry #1)` and so on are not yet read as tries of one test.

Jest and Vitest JSON contain the final assertion outcome and duration, but their
standard JSON reporters do not export a retry count or the earlier tries. Mainworthy does not
invent them. The pytest adapter sums setup, call, and teardown durations and keeps setup
or teardown failures as errors. Its failure message uses `crash.message` when
available and keeps the traceback in the details. Expected pytest failures are skipped.
TRX keeps each execution and its duration. Ambiguous or unfinished outcomes
count as errors.

## Report from sharded jobs

When a job's tests run in shards, report each shard as that shard of the job.
Use one job name for all shards, and give each shard its index and the number of shards.

```
mainworthy report results.xml --job tests --shard 2/6
```

The commit's gate then waits for every shard of the job.
Until the last shard reports, the gate reads `pending` and names the missing shards,
for example `pending: waiting for shards 3 and 5 of 6 of job tests`.
A failure in a shard that already reported shows at once, and the reason says which shards are still due.
`mainworthy gate --json` lists them in `waiting`.
The web app and the iPhone app draw the shards under the gate's reason, one strip for each job and one cell for each
shard. A missing shard is outlined in amber. The reason then counts the shards, for example
`pending: waiting for 3 shards`. To read which shards reported and which are still due, hover over a strip in the
web app or tap it on the iPhone. In a phone's browser, the page of a change or a run writes it under each strip. A row
in a list draws the cells alone, before its reason; open the row to read them.
Each shard can run `mainworthy gate` after its own report. The last shard's gate gives the commit's verdict.

A retry of a shard keeps the shard's index. Every shard of a job must give the same number of shards.
A report that gives another number is refused. Each environment of a commit waits for its own shards.
Without `--shard`, Mainworthy cannot tell that more reports are coming, and the gate reads what it has.

In GitHub Actions, the shard's matrix values supply both numbers.

```yaml
strategy:
  matrix:
    shard: [1, 2, 3, 4, 5, 6]
steps:
  - run: npx playwright test --shard=${{ matrix.shard }}/6 --reporter=junit > results.xml
  - run: |
      mainworthy report results.xml --job tests --shard ${{ matrix.shard }}/6
      mainworthy gate
```

A failure question waits for every shard too. Its question closes, or its answer ends, only when the commit's
shards have all reported and every report of the commit has been applied. See [decide](./decide.md#when-the-fix-arrives).

## Give a pipeline its own token

To give a pipeline its own identity, follow these steps.

1. As an administrator, run `mainworthy token new --ci github-actions --project scratch`.
2. Store the returned secret in your CI secret store. Mainworthy shows the secret once.
3. Set `MAINWORTHY_URL` to the server address.
4. Set `MAINWORTHY_TOKEN` to the secret.
5. Set `MAINWORTHY_PROJECT` to the project key.
A pipeline token can report results, say when a change ended, and read the gate. It cannot answer questions,
edit cases, plan runs, or administer the instance.
See [access](./access.md) for token scope and revocation.

The CLI can choose the project when the token can access exactly one project.

## Add GitHub Actions reporting

Before adding this step, put `mainworthy` on the job's path. The preceding test
step must write `results.xml` even when tests fail.

To add reporting to the job, follow these steps.

1. Configure the URL and project as repository variables.
2. Store the pipeline token as a repository secret.
3. Add the following step after the test step.

```yaml
- name: Report results and read the gate
  if: always()
  env:
    MAINWORTHY_URL: ${{ vars.MAINWORTHY_URL }}
    MAINWORTHY_PROJECT: ${{ vars.MAINWORTHY_PROJECT }}
    MAINWORTHY_TOKEN: ${{ secrets.MAINWORTHY_TOKEN }}
  run: |
    mainworthy report results.xml
    mainworthy gate
```

Keep missing reports and failed runner setup as CI failures. A gate cannot prove
that a job ran when the job sent no evidence. For a planned run, require named jobs
as described in [runs](./runs.md#require-ci-jobs).
The `gate` command's exit code makes this workflow step pass or fail.
An operator can also [publish a GitHub commit status](./changes.md#publish-the-gate-as-a-github-commit-status)
that updates after a later decision. It does not change this workflow step's recorded exit code.

## Say when a pull request ends

Mainworthy does not watch your code host, so it does not know that a pull request was
merged or closed. Until Mainworthy receives that information, unexplained failures on that pull
request stay in the queue. Add the following workflow to report when the pull
request ends. The workflow needs the same variables and pipeline token as the
reporting step. It needs no checkout.

```yaml
on:
  pull_request:
    types: [closed, reopened]

jobs:
  tell:
    runs-on: ubuntu-latest
    steps:
      - env:
          MAINWORTHY_URL: ${{ vars.MAINWORTHY_URL }}
          MAINWORTHY_PROJECT: ${{ vars.MAINWORTHY_PROJECT }}
          MAINWORTHY_TOKEN: ${{ secrets.MAINWORTHY_TOKEN }}
          PULL: ${{ github.event.pull_request.number }}
          STATE: ${{ github.event.action == 'reopened' && 'open' || (github.event.pull_request.merged && 'merged' || 'closed') }}
          HEAD_COMMIT: ${{ github.event.pull_request.head.sha }}
          MERGED_COMMIT: ${{ github.event.pull_request.merge_commit_sha }}
          BASE_BRANCH: ${{ github.event.pull_request.base.ref }}
        run: |
          payload=$(jq -nc --arg change "pr:$PULL" --arg state "$STATE" --arg head "$HEAD_COMMIT" --arg commit "$MERGED_COMMIT" --arg branch "$BASE_BRANCH" '
            {change: $change, state: $state, head: $head} +
            (if $state == "merged" and $commit != "" and (["main", "master", "trunk"] | index($branch)) != null
             then {landing: {commit: $commit, branch: $branch}} else {} end)')
          curl -fsS -X POST "$MAINWORTHY_URL/api/p/$MAINWORTHY_PROJECT/change" \
            -H "authorization: Bearer $MAINWORTHY_TOKEN" -H 'content-type: application/json' \
            -d "$payload"
```

With `mainworthy` on the job's path, the step is `mainworthy change --change "pr:$PULL" --state "$STATE"`.
To include the landed commit, use `change --json` with the same payload as the workflow.
The workflow sends the pull request's head, GitHub's merged hash and the base branch.
The head is the commit whose gate the change shows. The merged hash is the landing:
Mainworthy places it on trunk and evaluates its failures there. A rebase or squash
merge writes a new commit, so the landing has a gate of its own, which Changes shows
beside the head's. A fast-forward lands the head itself.
The call is answered `not_found` for a pull request that never sent a report.
[Changes and the gate](./changes.md#when-a-change-ends) says what ending a change does.

## Attach screenshots and small files

To attach files to a planned run's result, follow these steps.

1. Paste a screenshot into **Result note** or choose **Attach a file**.
2. Record the outcome. Keep the page open until Mainworthy records the result.

The files belong to that slot's next result. Files selected while
an earlier result is saving are kept for the next result. Each saved result shows
raster images inline and offers a download for every file. The case's timeline
shows the same attachments.

A report through the API can include `attachments` on each result. Each entry has
`name` and canonical base64 `data`, plus an optional step id in `at`:

```json
{"target":{"session":"screenshots"},"results":[{"test":{"key":"checkout"},"outcome":"fail","attachments":[{"name":"details.txt","data":"ZXhwZWN0ZWQgcmVhZHk="}]}]}
```

`attach` appends a file to a result you recorded. Send
`{"result":123,"attachment":{"name":"details.txt","data":"ZXhwZWN0ZWQgcmVhZHk="},"cmd":"attachment-123"}`.
Use a new `cmd` for a different file and reuse it for a retry. `attachment` with
`{"result":123}` lists metadata. To read one file's base64 data, add `"id":456`.
Both operations are available through the CLI and API. They are not additional
MCP tools, and the MCP report schema omits attachment inputs to keep tool discovery
small.

Each file is limited to 4 MiB. A report may include at most 100 files and 16 MiB of
decoded data. One result may hold at most 20 files and 16 MiB, including files
appended later. These limits bound upload memory and disk growth for each result while allowing
screenshots and small diagnostics. Large recordings belong in an external
artifact store. File names cannot contain paths, control characters or bidi
overrides and isolates. The API refuses the whole request if an attachment is
invalid or exceeds a limit. Large reports can briefly delay other requests while
the server validates and stores their contents.

For JUnit XML, the CLI reads `[[ATTACHMENT|path/to/file]]` on its own line in a
testcase's `system-out` or `system-err`, as described by the
[JUnit Attachments plugin](https://plugins.jenkins.io/junit-attachments/).
It also reads testcase properties named `attachment` or `attachment.1`,
`attachment.2`, and so on when their `value` names a file. The XML parser itself
never opens a path. Permit local file reads explicitly:

```sh
mainworthy report reports/results.xml --attachments reports
```

The CLI reads files only within the permitted directory. For relative paths,
the CLI tries that directory first, then the XML file's directory. Absolute paths must still be inside the
permitted directory. Keep only intended evidence in that directory. Without
`--attachments`, file markers are ignored and stderr says so once. The results
still upload, including reports from Playwright's JUnit reporter that always names
its videos and traces.

With the flag, a missing, hidden, outside-root, non-file, unreadable, changed,
invalid-name or over-limit file is skipped. Each skipped file gets one stderr
line with its path and reason. An unavailable attachment directory skips the
named files too. Skipped files consume no limit, and every parsed result still
uploads. Links within the directory keep the name used in the report.
The CLI receipt includes a skipped-attachments count, `skippedAttachments` in
JSON. This count describes files skipped locally on this command. It is not
part of the server's stored receipt. The CLI does not read embedded attachment
bodies from JUnit or attachments from native reports.

A caller needs `record` to send attachments and `read` on the result's project to
retrieve them. Only the original producer can append files through `attach`.
PNG, JPEG, GIF and WebP signatures select inline image types. Everything else,
including HTML and SVG, downloads as binary data. The UI never inserts a file's
contents as HTML or uses its name as a path.

Attachments are retained evidence and may themselves contain personal data.
Forgetting a person keeps their files and file names, just as it keeps typed
notes. Avoid personal information in screenshots and diagnostics. There is no
attachment deletion or retention control yet. See [your data](./data.md) for
storage and backups and [privacy](./privacy.md) for erasure requests.


## Quarantine an unreliable test

Quarantine applies to one automated test throughout its project. Its failures stay
in history and in the run's failing-test list. The gate counts them as excused and
says how many quarantined failures it recorded, even when another failure blocks.
It never counts quarantine as a proven pass. Missing evidence and required jobs
still wait.

Quarantine covers results reported after its entry decision and before its exit,
in the server's order. It leaves earlier results unchanged. Ending quarantine
preserves the verdicts of results reported while it stood. A covered failure is
excused even if an independent defect answer applies to it. Ending quarantine
leaves that answer and the earlier result's coverage in force.

To propose quarantine, follow these steps.

1. In a failure question, open **Quarantined tests**.
   Alternatively, open the list below the detector settings in **Settings**, **Policy**.
2. Enter the test ref, reason, and exit rule.
3. Choose **Propose quarantine**.
4. Review the proposal in the queue.
5. Enter a reason.
6. As a person with answer authority, accept the proposal.

A person with answer authority must decide under every preset.
Agents may propose and leave advice. Detector suggestions never enter quarantine.
A quarantine covers results reported from its entry on, so the failure you opened it from
still counts. After the proposal is accepted, run the job again to report covered results.
To propose an end, fill **Reason to end quarantine**. Then choose the test's end
button. Entry and expiry times appear in your browser's local time, including an
expiry entered in the form.

Choose one of the following exit rules.

- A person's decision, recorded through a proposal to end quarantine.
- An expiry date. The first result reported at or after that instant counts
  normally. Earlier results stay excused.
- One to 100 consecutive passing trunk commits whose first result for that test
  arrived after entry. Retrying a commit first reported before entry cannot count.
  Every combination of producer, job, and environment reported for that test on
  a commit must pass. Retries count once per commit. Failures,
  errors, skips and blocked results break the streak. Agent reports and change
  commits cannot satisfy it. After the streak succeeds, another failing commit
  does not restart quarantine, including a later failure on a commit in the
  qualifying streak. The result that completes the count ends quarantine.
  Later results count normally, even within the same report.

A correction replaces the earlier observation in its commit's evidence and can
change that commit's verdict. Its quarantine coverage depends on when the server
receives the correction. Before a pass count is reached, corrections can change
the streak. After the exit, they cannot reopen quarantine or change another
result's coverage. Planned runs use the same coverage, even if created later.

For the API and command line, read the test with `get`. Use the last quarantine's
`decision` as `base`, or null before the first quarantine. A changed base refuses
an older proposal. Send the quarantine edit by itself:

```sh
mainworthy propose --json '{"edits":[{"op":"quarantine","test":"T-1","base":null,"exit":{"kind":"passes","count":3}}],"reason":"Retry outcomes disagree on unchanged code"}'
mainworthy find --json '{"in":"tests","state":"quarantined"}'
mainworthy get T-1 --json
```

The quarantine edit is available through HTTP, the CLI, and the web UI. MCP
discovery omits the edit. The list returns each test's reason, person, entry time,
decision, and exit rule.
`get` retains the last entry after it ends. Set `exit` to null to propose ending
quarantine, or use `{"kind":"person"}` or `{"kind":"expiry","at":1800000000000}`
for the other rules. The expiry is UTC milliseconds. A new quarantine can begin
with a new decision after an earlier one ends.

Quarantine entries, recorded result coverage, and pass-count exits travel in
archives. This schema requires archives exported with this build. Imported
expiry rules use the destination server's clock. Earlier covered results keep
their coverage there too.

## Keep the work at each step

Send `steps` in a JSON report through HTTP, CLI, or MCP. Each entry records a
step's `outcome`, optional `durationMs`, and optional `actions`. Each action has
`text`, an optional `outcome`, and optional `durationMs`. Times are non-negative
whole milliseconds. Zero means measured zero; an omitted time means unrecorded.
Action times need not sum to the step's time.

```sh
$ mainworthy report --json '{"target":{"session":"checkout-check"},"results":[{"test":{"case":"C-1"},"outcome":"pass","annotation":{"case":"C-1","version":1},"steps":[{"step":"a1","outcome":"pass","durationMs":120,"actions":[{"text":"Open the cart","outcome":"pass","durationMs":120}]},{"step":"b2","outcome":"pass","durationMs":800,"actions":[{"text":"Apply the coupon","durationMs":700},{"text":"Read the discounted total","outcome":"pass","durationMs":100}]}]}]}'
$ mainworthy get C-1 --json
```

Use the stable step `id` from the case version you tested. A fragment's expanded
ID includes its occurrence, such as `a1.b2`. Read a planned run's slot to get its
pinned steps. Runner steps can instead use a short text label. Labels are
producer-supplied observations; Mainworthy does not verify that they identify a
case step. The result's recorded case version remains its basis after a case edit.
A trail may cover only part of a case or repeat a step. Its order is the order
sent, and it does not change the result's overall outcome.

A step's optional `attachment` is a zero-based index into that result's own
`attachments` array in the same report. Send an image there as
`{"name":"cart.png","data":"<canonical base64>"}`. Only image attachments can be
step screenshots. A step's screenshot opens from its row on web and iPhone.
Later `attach` calls append files and do not change those indexes. MCP accepts
inline attachments, though its compact tool list omits their schema; the HTTP
operation reference describes the attachment fields.

`get` and HTTP replies return the trail with the recorded result, including the
original action order and omitted fields. Test latest results, counted change
results, and planned-run slots show it on web and iPhone. Each step and any
recorded action outcome appears in words. Longer steps have a stronger background
tint relative to the longest step in that result. Missing and zero times have no
tint. The first `fail` or `error` in a present trail supplies `atStep` and takes
precedence over `failure.at`. An empty trail has no failed step. Without a trail,
`failure.at` remains the failure location.

A report is refused before acceptance when it exceeds any trail limit. The reply
names the limit: 100 steps per result, 100 actions per step, 160 characters per
step ID or label, 2,000 characters per action, 65,536 UTF-8 bytes of serialized
trail JSON per result, or 1,048,576 bytes of trails per report. Text lengths count
UTF-16 units. Attachment limits apply separately. Split a report to meet the
report-wide limit, or shorten the observations to meet a result limit.

Playwright JSON carries recorded `test.step` data when the runner writes it.
The adapter keeps the final attempt's top-level steps and lists nested steps as
actions, with their path, outcome, and rounded milliseconds. A step with an error
is `fail`; a completed step without one is `pass`. Earlier retry steps do not
become the final result's trail. The JUnit, Jest, Vitest, pytest, and TRX adapters
do not currently carry case-step observations and do not invent trails.
