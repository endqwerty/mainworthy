# Changes and the gate

Read a change's latest verdict and find what prevents it from passing.
Use the same gate from the command line to decide whether CI can continue.

![Changes with a blocked gate, open questions, decisions, and impact](../ui/screenshots/changes-light.png)

## Open a change

1. Press <kbd>g</kbd> <kbd>c</kbd> to open Changes.
2. Select a change from the list.
3. Read its verdict and reason.
4. Open a question that needs an answer.

Use <kbd>j</kbd> and <kbd>k</kbd> to move between changes.
<kbd>Enter</kbd> opens the first question shown for the selected change.
See [the keyboard guide](./keyboard.md) for navigation keys.

A report identifies the tested commit. Branch or pull request metadata groups
commits into a change. For example, `pr:482` identifies a pull request.
The change shows its head commit's gate. A commit gate names one commit.
An older report arriving late does not move the change back to an earlier commit.
A report can also carry the current head read from the code host, so a reset or force-push
can move the change back. That head's gate stays pending until it has counted evidence.
See [report results](./report-results.md#follow-a-branch-reset) for `--head` and `target.head`.

A commit first reported by hash alone gains its scope when a pipeline or person later
names its branch or pull request, unless someone has typed a result for that commit.
Typed results keep their scope, question ids and answers. Otherwise, former answers
stay in the ledger as outdated and failures are evaluated in the named scope.
Every environment shares the same commit gate.

The list says "Latest commit's verdict". The detail shows the gate's reason and
nonzero counts, followed by "Open questions", "Settled and excused", "Impact",
and "Uncovered files" when there are uncovered paths.
Impact lists related cases and review information. It is not a code coverage measurement.

The diagram follows the default policy, which requires counted evidence. A project can separately allow an explicit [CI declaration that no tests are required](./policy.md#reports-with-no-tests).

[Diagram: how a gate reaches its verdict](../diagrams/gate-verdict.html)

## Act on the verdict

`passed` means counted evidence exists, or the project's policy accepts an applied CI declaration that no tests are required.
No current failure, dispute, missing requirement, or blocking question prevents passage. Read "Settled and excused"
to see whether a decision excused a failure. Passed does not mean every test passed.

`failed` means a decision attributes a failure to the target.
Fix the product, fix the test, or update the case and test for an intended change.
Then report the new evidence. If the judgment was wrong, withdraw or replace it.

`blocked` means an unexplained failure, a dispute, or an open blocking question
needs a decision. Open the question, read its evidence, and [answer it](./decide.md).
Re-running alone is not a substitute for explaining a failure that still counts.

`pending` means the gate cannot give a completed verdict yet.
Report missing evidence, wait for an accepted upload to be applied, or renew an
expired decision. A run with only skipped results has proven nothing and stays pending.
A planned run can also wait for a required job or an unfilled slot.

An unexplained failure can make a run blocked even when it also has missing results.
The reason names the condition that currently determines the verdict.
See [runs](./runs.md) for planned-run requirements.

## Read the gate in CI or a shell

```sh
$ mainworthy gate
$ mainworthy gate --commit 1111111111111111111111111111111111111111
$ mainworthy gate --change pr:482
$ mainworthy gate --run R-2
```

With no target flag, `gate` uses CI or Git detection.
Choose one commit, change, or run per call.
If a commit was reported for several repositories, use `--repo` to identify the one
whose gate you need. Mainworthy refuses to guess between repositories.

The verdict sets the exit code:

- `0` means `passed`.
- `1` means `failed`.
- `2` means `blocked`.
- `3` means `pending`.
- `4` means the command encountered an input, connection, or operation error.

Use `--wait <seconds>` to wait while the verdict is pending.
It does not wait for a person to answer a blocked question.
Use `--json` for structured output. [The CLI guide](./cli.md) lists every flag.

## When a change ends

A pull request ends when it is merged, or closed without merging. Tell Mainworthy, and it
stops asking about the change:

```sh
$ mainworthy change --change pr:482 --state merged --compact
{"change":"pr:482","state":"merged","questions":["Q-115"],"already":false}
```

`--state` takes `merged`, `closed` or `open`. The reply lists the failure questions that were open
about the change and are no longer asked. Nobody will act on an answer about a pull request
that has ended. A failure that came with the merge fails on the line too, and is asked about
there as its own question.

Include the exact commit that landed and its trunk branch:

```sh
$ mainworthy change --json '{"change":"pr:482","state":"merged","landing":{"commit":"1111111111111111111111111111111111111111","branch":"main"}}'
```

`landing.commit` sets the change's head, even if that commit is older than the recorded
head or CI has not reported it yet. Its gate is pending until results arrive. All its
environments belong to trunk, including environments reported later. Reports that
still name the pull request count for this head and raise unexplained failures on trunk.
The commit keeps its one gate, and planned runs that count it are recomputed.
Pull request answers remain attributable in history and still cover its older commits.
They do not carry to trunk. A landed commit's automatic inherited answer ends because it no longer belongs to the change's base comparison.
Existing trunk answers apply. If this commit gate is the
newest run in trunk, its unexplained failures raise trunk questions immediately, even
before another report arrives. An older gate can remain blocked without an open
question. Planned runs that count the commit still ask about their unexplained failures.

Migration 8 records scope moves locally. Archives keep the resulting target and run
scopes but omit the move audit trail. That audit table does not change the archive schema.
Result-specific inherited excuses require archive schema 13. To transfer older data, upgrade
the source database and export it again as described in [data](./data.md).

A different merge or rebased hash leaves the original commit in its existing scope.
Omitting `landing` ends the change and keeps its recorded head. You can supply the
landing later by repeating `merged` with the metadata.
`landing.branch` takes `main`, `master` or `trunk`. Reopening a change does not move a
commit back from trunk.

A merged change keeps its recorded head. Neither an ordinary report for another commit
nor a report with `target.head` can replace it. Without landing metadata, the head stays
on the commit recorded when the change ended. Reports still count evidence, so late
results for that head can change its verdict. A landing sent later selects its commit
as the head and places it on trunk.

A change closed without merging continues to follow reports and code-host head
observations. Explicitly reopening a merged change lets it follow reports again.
A landed commit keeps its trunk scope.
Migration 0009 stores head observations without changing archive schema 7.

What stays as it was:

- The merged change's head. Its row and `gate --change` keep showing that commit's gate.
  Without new landing metadata or evidence, an unexplained failure still reads
  `blocked`, with no open question behind it.
- Answers already given. They stay under "Settled and excused".
- Findings about the change. A finding is about a case, and is still worth an answer.
- A question that an open planned run shows unexplained. That run waits for the answer
  whatever became of the change.

A report that arrives after the end, from a job that finished late, is recorded and counted.
It raises no question in the ended scope. A landed head is now on trunk, so its late
failures are evaluated and asked about there.

When a pull request is opened again, say so, and what its newest commit shows unexplained
is asked about at once:

```sh
$ mainworthy change --change pr:482 --state open
```

A pipeline or a person says how a change ended. An agent's word about it is refused, as its
word about where a commit belongs is. In Changes, an ended change is marked "merged" or
"closed". See [report results](./report-results.md#say-when-a-pull-request-ends) for the
workflow that sends this from GitHub Actions.

## Distinguish uploads from gates

A successful report records evidence and prints a receipt.
Its exit code does not decide whether the commit passes.
Call `mainworthy gate` after `mainworthy report` in your pipeline.
See [report results](./report-results.md#add-github-actions-reporting).

A test can gate a commit even when it has no case.
An invalid automated case annotation does not discard a failing outcome.
A newer decisive attempt can replace the previous result from the same producer,
job, target, and test. A pass from a different job cannot clear that failure.

## Understand agent evidence

A commit reported only by an agent has no counted commit gate.
Reading its gate returns pending with nothing proven.
An agent's results are recorded and visible, and failures can raise questions,
but they do not move the change's counted head or its commit verdict.

Agent results count only in a planned run that asks for agents on a case that
admits them. A review is still not a runtime pass. See [agents](./agents.md).

## Change a verdict with a decision

Answering a failure recomputes the gates that show that cause.
Choose "Infrastructure" to excuse the target you are looking at, or "Flaky" to
excuse it while the hold lasts. The gate can then pass without another upload
if it has no other outstanding condition.

Choose "Defect in the product", "The test is wrong", or "Expected: behaviour changed"
to attribute the failure. The gate becomes failed until passing evidence replaces
that failure or the judgment changes.

The result stays recorded in either case. The decision changes what the failure
means for the gate. Withdrawing an excuse can block the gate again.
See [decide](./decide.md#explain-a-failure) for duration and later occurrences.

Mainworthy does not yet post the verdict as a code-host check.
Use the `gate` exit code in CI and follow the question links in the web app.
