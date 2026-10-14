# Report results

Send JUnit XML from a test runner or CI, then read the gate for the tested commit.
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

[Diagram: one red build, from upload to a green gate](../diagrams/red-build.html)

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

## Link tests to cases

Put a case annotation in the JUnit test name:

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

The property takes precedence over an annotation in the name.
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
Mainworthy records same-commit changes between pass and fail. It does not yet provide
a flaky score or automatic quarantine. A person decides whether a failure is flaky.

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
Mainworthy does not yet post a check to your code host. The `gate` command's exit
code is what makes this workflow step pass or fail.

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
        run: |
          curl -fsS -X POST "$MAINWORTHY_URL/api/p/$MAINWORTHY_PROJECT/change" \
            -H "authorization: Bearer $MAINWORTHY_TOKEN" -H 'content-type: application/json' \
            -d "{\"change\":\"pr:$PULL\",\"state\":\"$STATE\"}"
```

With `mainworthy` on the job's path, the step is `mainworthy change --change "pr:$PULL" --state "$STATE"`.
The call is answered `not_found` for a pull request that never sent a report.
[Changes and the gate](./changes.md#when-a-change-ends) says what ending a change does.
