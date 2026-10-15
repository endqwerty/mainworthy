# Report results

Send a test report from a runner or CI, then read the gate for the tested commit.
Keep the pipeline's identity, retries, and case links with its results.

## Upload JUnit XML

Have your runner write a JUnit XML file. Then report it to your instance:

```sh
$ mainworthy report results.xml
$ mainworthy gate
```

You can pass several files or a shell glob such as `results/*.xml`.
The receipt lists outcomes, new or existing questions, unlinked tests, result bases,
and the gate at the time of the upload.

A successful `report` exits `0` even when tests fail. Use `gate` for the verdict.
An invalid input or refused command exits `4`. See [changes](./changes.md).
Sending an identical report again returns the original receipt and says
"already received; nothing was written". The gate line in it is the gate as
it was at the first upload, so a repeat can show "blocked" for a commit that
has passed since. The command says so on stderr and points at `mainworthy gate`,
which reads the verdict now.

Reports also fill qualifying slots in planned runs that accept the tested commit,
even after those runs close. A late report makes the run's gate `pending` until
all accepted reports are applied, then Mainworthy reconsiders its sign-off on the
new evidence if the report added or corrected qualifying slot results. A report
that does neither leaves the approval in place. See [planned runs](./runs.md#close-and-reopen-a-run).

[Diagram: one red build, from upload to a green gate](../diagrams/red-build.html)

## Upload a native report

The same command reads Playwright JSON, Jest JSON, Vitest JSON,
`pytest-json-report` JSON, and Visual Studio Test TRX. It detects each file
independently, so one upload can include different formats:

```sh
$ mainworthy report playwright.json unit-results.json results.trx
```

Use `--format junit|playwright|jest|vitest|pytest|trx` to select one format for
every file in the command. The default is `--format auto`. Jest and Vitest use
the same JSON structure. Detection reads the content; a `.trx` extension also
selects TRX, and a `.json` extension makes invalid JSON an input error.

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
class in `TestDefinitions` when present and the test name; its assembly path
is not a source file. A TRX test without a definition keeps its name as its key.
The report's filename and TRX execution IDs do not enter test keys.

Jest and Vitest source paths are relative to the report's `rootDir` when present.
Otherwise the command uses the Git checkout's top level, or its working directory
outside Git. Run the command in the source checkout that produced the report,
including when the report file is stored elsewhere. This keeps keys stable
between checkouts. The JSON reporters normally omit `rootDir`.
The command refuses a relative `rootDir`, a filesystem root, or a source path
outside the chosen root. It exits with code 4 and names the report file and root.

Keep source paths and suite names stable. Switching exporters can change those
values, so compare their keys before switching an existing pipeline. An
unlinked native test follows the same project policy as an unlinked JUnit test.

Native reports with unknown statuses, malformed test details, or errors outside
test executions stop the upload with exit `4`. No files in that command are
sent. Keep the runner's exit status as a CI check too, since a report cannot
prove work that the runner omitted. JUnit keeps its existing parser and warnings.

## Report that no tests are required

When path filters require no tests for a commit, a pipeline can explicitly declare that fact:

```sh
$ mainworthy report --nothing-required --commit 1111111111111111111111111111111111111111
$ mainworthy gate --commit 1111111111111111111111111111111111111111
```

The report needs a CI token. It accepts no files, results, or planned run. CI detection can supply the commit, job, and other build metadata as for an ordinary report.

All presets keep this gate pending by default. A project admin must first record `mainworthy policy empty nothing-required`. See [reports with no tests](./policy.md#reports-with-no-tests) for the policy choice and its record.

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

CI detection does not supply `--head`. An old workflow event can name an outdated head,
so read the code host's current value instead of copying the event's commit.
Without `--head`, reports keep their first-reported ordering. A commit already reported
before a head observation cannot replace that head with a late job.

An identical report with the same head and build URL is a retry and does not move the
change again. With `--head`, the build URL distinguishes a new CI run even when its
results and attempt number match an earlier run. GitHub Actions supplies a URL containing
the run ID; other producers can set `MAINWORTHY_BUILD_URL` or send `buildUrl` in JSON.
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
Add `@v1` to claim version 1 in Mainworthy, not the version in the source tool.
Aliases keep their original letter case and resolve within the report's project.
In a name, native refs match without regard to letter case: `@c-2` names `C-2`.
Mainworthy normalizes native refs to uppercase and leaves alias letter case unchanged.
A non-native `@token` claims a case only when that alias exists in the report's project.
Other tokens, such as `@smoke`, `@media`, and the address in `user@example.com`, are ignored when they name no alias.
They do not hide a later native ref or drop a previously decided link.
Trailing sentence punctuation is excluded from name claims: `@C1234.` names `C1234`.
Use explicit metadata for an alias whose final punctuation belongs to its identifier.
Separate claims with whitespace. Glued tokens such as `@smoke@C-2`,
`@C-2x`, and `@C-2@v1x` do not claim a case.

Name annotations work in JUnit, Playwright, Jest, Vitest and TRX test names,
and in pytest node IDs, including parameter IDs. These formats also carry case claims outside the name:

- JUnit uses the `mainworthy` property shown above.
- Playwright JSON uses a test annotation with `type: "mainworthy"` and `description: "C1234@v1"`.
- pytest-json-report uses `record_property("mainworthy", "C1234@v1")`, serialized as `user_properties: [{"mainworthy": "C1234@v1"}]`.

Mainworthy resolves name claims when it receives the report, using the aliases in that project.
The last valid claim in a name wins. For example, `checkout @C1234 then @C-2` names `C-2`.
With several native refs, this changes the earlier behavior that selected the first ref.
An unknown non-native token is ignored even after a valid claim.

These properties and Playwright annotations take precedence over every claim in the name.
When several explicit metadata claims name the case on one test, the last syntactically valid claim wins.
An unknown alias in explicit metadata is recorded without a case, and the receipt explains why, just as for an unknown native ref.
Metadata preserves the alias's punctuation and requires uppercase native refs.
A test can also use a link previously decided in [Queue](./decide.md).

Mainworthy identifies a test using its file, or its class name when there is no file,
together with its suite path and name. Keep those values stable across reports.
The report file's name is not the test's source file.

What happens to a test without a case is the project's choice. Under `loose` and `standard`
it starts as "Track without a case": the test is kept and nobody is asked. A project can have
a case made for each such test, or have each file raise an unlinked-test question, which is
where `strict` starts. See [policy](./policy.md#tests-with-no-case).
An unlinked automated test still counts toward the commit gate.

## Read the result's basis

To report execution of a deployed artifact, use `--build <label> --env <environment>`.
This selects the announced artifact instead of a commit detected from CI or Git.
The label must already be bound by `announce`. Check its planned release run with
`gate --run`, as described in [release runs](./runs.md#plan-a-release-run).

`exact` means the result names a case version, or a run pins that version.
`assumed` means a link or case annotation identifies the case, and Mainworthy uses
its current version without a version claim from the runner.
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
execution supplies its outcome and failure; a skipped retry does not erase an
earlier failure. Its duration sums all executions, and a pass after retries has
the same `passed after N retries` note as JUnit. An expected Playwright failure
counts as a pass; an unexpected pass counts as a failure.

Jest and Vitest JSON contain the final assertion outcome and duration, but their
standard JSON reporters do not export a retry count. Mainworthy does not invent
one. The pytest adapter sums setup, call, and teardown durations and keeps setup
or teardown failures as errors. Its failure message uses `crash.message` when
available and keeps the traceback in the details. Expected pytest failures are skipped.
TRX keeps each execution and its duration; ambiguous or unfinished outcomes count as errors.

## Give a pipeline its own token

As an administrator, create a token for the pipeline:

```sh
$ mainworthy token new --ci github-actions --project scratch
```

Store the returned secret in your CI secret store. It is shown once.
A pipeline token can report results, say when a change ended, and read the gate. It cannot answer questions,
edit cases, plan runs, or administer the instance.
See [access](./access.md) for token scope and revocation.

Set `MAINWORTHY_URL` to the server address, `MAINWORTHY_TOKEN` to this secret,
and `MAINWORTHY_PROJECT` to the project key.
The CLI can choose the project when the instance has only one project.

## Add GitHub Actions reporting

This step assumes your job has `mainworthy` on its path and a preceding test step
writes `results.xml` even when tests fail. Configure the URL and project as repository
variables, and the pipeline token as a repository secret.

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
merged or closed. Until it is told, a failure nobody explained on that pull request stays
in the queue. Add a workflow that tells it. It needs the same variables and the pipeline's
token, and no checkout:

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
          MERGED_COMMIT: ${{ github.event.pull_request.merge_commit_sha }}
          BASE_BRANCH: ${{ github.event.pull_request.base.ref }}
        run: |
          payload=$(jq -nc --arg change "pr:$PULL" --arg state "$STATE" --arg commit "$MERGED_COMMIT" --arg branch "$BASE_BRANCH" '
            {change: $change, state: $state} +
            (if $state == "merged" and $commit != "" and (["main", "master", "trunk"] | index($branch)) != null
             then {landing: {commit: $commit, branch: $branch}} else {} end)')
          curl -fsS -X POST "$MAINWORTHY_URL/api/p/$MAINWORTHY_PROJECT/change" \
            -H "authorization: Bearer $MAINWORTHY_TOKEN" -H 'content-type: application/json' \
            -d "$payload"
```

With `mainworthy` on the job's path, the step is `mainworthy change --change "pr:$PULL" --state "$STATE"`.
For a merged change whose head reached trunk unchanged, use `change --json` with the
same payload as the workflow. The workflow sends GitHub's merged hash and base branch;
a matching head moves to trunk and its failures are evaluated there again. A different
merge or rebased hash leaves the original head's scope alone.
The call is answered `not_found` for a pull request that never sent a report.
[Changes and the gate](./changes.md#when-a-change-ends) says what ending a change does.

## Attach screenshots and small files

In a planned run, paste a screenshot into **Result note** or choose **Attach a file**
before recording the outcome. The files belong to that slot's next result. They
stay on the open page until recorded, so keep the page open. Files selected while
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
`{"result":123}` lists metadata; add `"id":456` to read one file's base64 data.
Both operations are available through the CLI and API. They are not additional
MCP tools, and the MCP report schema omits attachment inputs to keep tool discovery
within its token budget.

Each file is limited to 4 MiB. A report may include at most 100 files and 16 MiB of
decoded data. One result may hold at most 20 files and 16 MiB, including files
appended later. These limits bound upload memory and per-result disk growth while
allowing screenshots and small diagnostics. Large recordings belong in an external
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

The directory is the boundary for file reads. Relative paths try that directory
first, then the XML file's directory. Absolute paths must still be inside the
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
JSON. This count describes files skipped locally on this command; it is not
part of the server's stored receipt. Embedded attachment bodies and native-report
attachments are not read in this first version.

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

In a failure question, open **Quarantined tests**, or use the list below the detector
settings in **Settings**, **Policy**. Enter the test ref, reason and exit rule,
then choose **Propose quarantine**. Review and accept the proposal in the queue
with a reason. A person with answer authority must decide under every preset.
Agents may propose and leave advice. Detector suggestions never enter quarantine.

Choose one exit rule:

- A person's decision, recorded through a proposal to end quarantine.
- An expiry date. At that instant its failures count normally again, without waiting for background work.
- One to 100 consecutive passing trunk commits after entry. Every automated lane
  seen for that test on a commit must pass. Retries count once per commit. Failures,
  errors, skips and blocked results break the streak. Agent reports and change
  commits cannot satisfy it. After the streak succeeds, another failing commit
  does not restart quarantine.

For the API and command line, read the test with `get`. Use the last quarantine's
`decision` as `base`, or null before the first quarantine. A changed base refuses
an older proposal. Send the quarantine edit by itself:

```sh
mainworthy propose --json '{"edits":[{"op":"quarantine","test":"T-1","base":null,"exit":{"kind":"passes","count":3}}],"reason":"Retry outcomes disagree on unchanged code"}'
mainworthy find --json '{"in":"tests","state":"quarantined"}'
mainworthy get T-1 --json
```

The quarantine edit is available through HTTP, the CLI and the web UI; MCP discovery
omits it. The list returns each test's reason, person, entry time, decision and exit rule.
`get` retains the last entry after it ends. Set `exit` to null to propose ending
quarantine, or use `{"kind":"person"}` or `{"kind":"expiry","at":1800000000000}`
for the other rules. The expiry is UTC milliseconds. A new quarantine can begin
with a new decision after an earlier one ends.

Quarantine entries and the observations behind their exit rules travel in archives.
This schema requires archives created after quarantine was introduced. Imported
expiry rules use the destination server's clock.
