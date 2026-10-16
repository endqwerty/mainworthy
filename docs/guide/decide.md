# Decide in the queue

Read the evidence behind a question and record an answer with one key.
Use the answer's stated consequence to decide what the gate needs next.

![Queue with failure evidence and the available answers](../ui/screenshots/queue-light.png)

## Find the question to answer

To answer a question, follow these steps.

1. Press <kbd>g</kbd> <kbd>q</kbd> to open Queue.
2. Select a question.
3. Read its evidence and the text beside each available answer.
4. Press the answer key.

The queue lists the questions that block most first, then the newest first.
A test with no case comes after every other question, regardless of its age.
That question blocks nothing.

Use <kbd>j</kbd> and <kbd>k</kbd> to move between questions.
Press <kbd>Space</kbd> to expand the evidence.
The "Open" view contains questions that need an answer. "Settled" contains decisions.
You can filter by "Proposals", "Unlinked", "Failures", "Findings", or "Sign-offs".
See [the keyboard guide](./keyboard.md) for the full key list.

## Know what needs you today

The line beside "Queue" separates failures from questions that can wait, for example
"1 failure to explain · 104 can wait". Start with the failures. The queue lists failures first.
The count beside Queue in the sidebar is red only while a failure question is open.

A failure is the one kind of question that blocks anything. While nobody has explained a
failure, no gate that counts it passes. An earlier occurrence of the same cause that someone
answered for another build stays excused there. Every other kind leaves things as they are until
someone answers. A proposed edit waits, a finding stays on record, and a test with no case
still runs and still gates the build.

Under its title, each open question says what leaving it costs. These are example messages.

- "Listed as blocking R-83. While this is open, no gate that counts the unexplained failure passes."
- "Blocks nothing. Left alone, these tests still run and still gate the build, and no case gets credit for them."

The runs a failure lists are the ones it was listed under as its results arrived. Open a
run to read its gate as it is now: an older commit's run can pass again while a newer
commit keeps the question open.

A failure stops blocking a gate when a decision explains the failure or another result replaces the failing result.
A newer passing attempt of the same job replaces the failing result.
A skipped or blocked attempt leaves the failure in place.
A result that explicitly corrects the failing result replaces that failure regardless of the correction's outcome, including passed, skipped, or blocked.
A pass reported beside the failure replaces nothing. The pass and failure disagree, and a person settles the disagreement.
A pull request's gate is the gate of its newest commit, so a newer commit that passes moves
the pull request on. The older commit keeps the verdict it had.

A failure that only an agent reported, or one typed for a session, is counted by no commit's
gate. It is still a failure to explain.

A question asks for a judgment about recorded evidence. It is not a test result.
Several occurrences of the same failure cause can share one question.
A planned run's disputed slot has a separate "Disputed" question for each cause
and scope. Explaining the cause leaves that dispute waiting for its own answer,
even when the cause was explained first. Under `standard` and `strict`, someone who reported neither side settles the dispute. The cause answer still applies in other slots,
runs and scopes where that answer already held. See [disputed slots](./runs.md#resolve-a-disputed-slot).
An assertion cause shared by more than 50 distinct tests across more than five files in one commit's
applied reports gets a question per file, starting with the report that crosses those limits.
Reports for the same repository and commit count together, including different environments.
Each title starts with "Split by file" and names the file. Your answer covers that file's cause.
Earlier results keep their grouping, and earlier answers keep their effects.
Later reports on that commit also split new files. Other commits keep that cause separate for a file
seen before the split as well as after it, even when they contain fewer failures.
Reports without a commit count separately.
Results without a reported file get a separate group when a cause splits.
The guard counts reported files, so missing file names do not help reach the threshold.

Look for "blocks gate" and the runs named beside the question.

[Diagram: the life of a question](../diagrams/question-lifecycle.html)

## Failures already present on the base

Under the loose policy, a test that fails with the same cause on the change's base is excused by rule.
The decision appears in Settled. It names exact results of one commit and the base results that support them.
Other tests with the same message still need their own evidence. Splitting a report does not change which tests qualify.

The comparison uses the change's current base in its own repository and the effective results of pipelines and people.
The base must fail in the same environment, method, and job as the change's result.
A failure in a different environment, method, or job does not qualify.
A newer passing attempt, a correction, a result judged a mistake, or a different base can end the excuse.
Mainworthy updates the affected commits and planned runs immediately when that evidence changes, including reports recovered after a restart.
Landing the change's head on trunk ends that commit's inherited excuse. Trunk answers apply, and unexplained failures are asked again.
A skipped or blocked retry does not remove an earlier failure. An agent's report supplies no base evidence and receives no automatic inherited excuse.

If you withdraw the rule's answer, the queue keeps one ordinary failure question for you to answer.
The rule stops answering that commit and cause, including after base or change retries. Another commit or cause can still qualify.
Your answer follows the usual failure holds. A failing base retry does not withdraw your answer.

Standard and strict policies leave the comparison as a hint for a person. A person's "Already failing on base" answer
still covers the build they answered about. To use a newer preset, apply the preset. Stored policies keep their existing clauses.

## Choose an answer

Only answers that apply to the current evidence are available.
For example, "The failure was a mistake" applies to a disputed planned-run result.
"Already failing on base" is available for a change, not a trunk failure.

<!-- generated:answer-keys -->

### A proposed edit (`adopt`)

| Key | Answer | What it does |
| --- | --- | --- |
| <kbd>a</kbd> | Accept | Makes this the current version. |
| <kbd>r</kbd> | Reject | Leaves the case as it is. The proposal stays in the history. |
|  | Merge | Adopts the version you put together from both sides. |

### A test with no case (`map`)

| Key | Answer | What it does |
| --- | --- | --- |
| <kbd>l</kbd> | Link to a case | Results of this test count for the case from now on. |
| <kbd>c</kbd> | Create cases | Makes one case per test and links them. |
| <kbd>t</kbd> | Track without a case | Keeps them as tests without cases. They still gate the build. |
|  | Unlink | The test stops counting for its case. |

### A failed result (`failure`)

| Key | Answer | What it does |
| --- | --- | --- |
| <kbd>d</kbd> | Defect in the product | A product bug. The gate fails until a build passes. |
| <kbd>t</kbd> | The test is wrong | The test is wrong. The gate fails until the test is fixed. |
| <kbd>e</kbd> | Expected: behaviour changed | The behaviour changed on purpose. The gate fails until the case and the test say so. |
| <kbd>f</kbd> | Flaky | Unreliable. Not blocking; asked again when the hold runs out or the evidence changes. |
| <kbd>i</kbd> | Infrastructure | The environment, not the product. Excused for this build only. |
| <kbd>n</kbd> | Already failing on base | Already failing where this change started. Not this change's doing. |
| <kbd>m</kbd> | The failure was a mistake | The failing result was a mistake. The passing result stands. |

### A finding from a review (`finding`)

| Key | Answer | What it does |
| --- | --- | --- |
| <kbd>a</kbd> | Accept | Agree. A suggestion it carries becomes a proposed edit by its author. |
| <kbd>r</kbd> | Reject | Disagree. It is not raised again for this version. |
| <kbd>d</kbd> | Duplicate | Already covered by another finding. |
| <kbd>z</kbd> | Defer | Not now. It stays on record. |

### Closing a run (`signoff`)

| Key | Answer | What it does |
| --- | --- | --- |
| <kbd>a</kbd> | Approve | Closes the run with the verdict it has now. |
| <kbd>r</kbd> | Reject | Leaves the run open. |

<!-- /generated -->

A key records the answer immediately unless the answer needs another field.
"Link to a case" opens a case picker for each test. "Defect in the product" lets you
enter an optional defect reference. <kbd>Enter</kbd> records the defect answer with that reference.
<kbd>Escape</kbd> records the defect answer without a reference. If the policy requires a reason, enter it before
submitting. The queue keeps unfinished reference and reason text on this device.

If evidence changes while you answer, Mainworthy refuses the stale answer.
Read the new evidence before trying again. A decision names the evidence you saw.

## Answer several questions at once

To answer several questions, select the questions and give one answer.
The answer goes to every selected question in one request.
Use these controls to change the selection.

- To add or remove a question, click the box at the start of its row or press <kbd>x</kbd> on the question shown. A click elsewhere on the row opens the question and keeps the selection.
- To select a range, hold Shift and click a row. The range starts at the last row you selected or cleared and ends at the clicked row.
- To add or remove a question by clicking its row, hold <kbd>⌘</kbd> or Ctrl while you click.
- To select all listed questions of the selection's kind, press <kbd>*</kbd>. With nothing selected, the key uses the kind of the question shown. Press <kbd>*</kbd> again to clear the selection.
- To clear the selection, press <kbd>Esc</kbd>.

A selection contains one kind of question, so one answer means the same thing to every question in it.
You cannot select a question you cannot settle or a row of another kind. The status line says why.
Proposals and findings that suggest edits need their edits on screen before an answer counts.
Answer those one at a time.

"Select all" takes the questions listed so far. To include the rest, press "More questions" first.
A selection holds at most 500 questions, the most one answer sends. The status line says how many it left out.

The bar above the list counts the selection. The answers under the evidence apply to the selection.
The line above them says when the question shown is not one of the selected questions.
The queue offers an answer only when every selected question takes it.
"Link to a case" asks for a case for each test, so answer one question at a time.
An answer that needs a defect reference or a reason asks once and gives the same text to all.
Record or cancel that answer before changing the selection.
Advice is about the question shown, so <kbd>↵</kbd> does not take it while a selection exists.

Each question gets its own decision. To withdraw all those decisions, press <kbd>u</kbd>, as you would for one decision.
A refused question returns to the list, for example if its evidence changed while you were choosing an answer.
The other questions stay answered.

In a phone browser, open a question and choose **Actions** for "Select question", "Select all of this kind", or "Clear selection".
The rows have no box there.

The iPhone app has its own **Select**. See [answer several questions at once](./iphone.md#answer-several-questions-at-once).
The app saves an answer on the device before sending it, and **Unsent answers** in Queue shows what has not reached the server.
See [answer during a network drop](./iphone.md#answer-during-a-network-drop).

## Review a proposal

An adoption question asks whether a proposed edit becomes current.
Read the proposed changes beside the existing case.
"Accept" makes the proposal current. "Reject" leaves the case as it is and keeps
the proposal in history. These choices do not by themselves excuse a test failure.

An edit conflict needs a merged body, rather than a plain acceptance.
Resolve it in the case's conflict card. See [write cases](./write-cases.md#resolve-simultaneous-edits).
The merged body is another proposal and still follows the adoption policy.

## Give an unlinked test a home

An unlinked-test question asks how to keep a test that has no case.
A project asks it when its policy says "Ask in the queue" for tests with no case.
Otherwise a rule tracks the tests or makes their cases. Find its answers under "Settled".
A rule leaves a file's question open if a person took back its answer or answered against it.
Under `standard` with "Create a case for each test", an agent's reported tests also wait for a person to adopt their new cases.
See [policy](./policy.md#tests-with-no-case).
"Link to a case" makes future results count for the chosen case.
"Create cases" creates one case per test and links each test to its case.
"Create cases" works where the policy adopts your new case by rule, under `loose` or for a person under `standard`.
Under `strict`, or for an agent under `standard`, a person must adopt each new case. Mainworthy refuses "Create cases" in those situations.
To link tests when a person must adopt new cases, follow these steps.

1. Propose the cases.
2. Have a person adopt the cases.
3. Answer with "Link to a case".

"Track without a case" keeps the test without a case. The test still gates the build.

Tests reported with neither a file nor a class name share one question under the file "(no file)".
The question lists those tests like any other file's tests. Every answer acts on the listed tests.

To answer several files now, [select them](#answer-several-questions-at-once) and give one answer.
To give every file the same answer from now on, change the project's choice instead of answering each row.
Open Policy in Settings. Under "Tests with no case", choose "Track without a case" or "Create a case for each test". The rule then answers every open question about a file at once.

A link holds for the tests it names. A test that turns up later in the same file is a new
question, and the earlier links stay. "Track without a case" is about the file as it was:
the file is asked about again when its tests with no case change.

These choices settle the mapping question. They do not turn a failed result into a pass.
An already recorded result keeps its original basis. Link decisions affect later results.
See [report results](./report-results.md#link-tests-to-cases).

## Explain a failure

Choose "Defect in the product" when the product needs a fix.
Choose "The test is wrong" when the test needs a fix.
Choose "Expected: behaviour changed" when the intended behavior changed.
All three attribute the failure to the target and make its gate `failed`.
An expected change still needs the case and test to agree with that change.

These answers carry to later occurrences of the same cause in the same scope
while their basis holds. They have no fixed expiry date.
Withdraw or replace the answer when the judgment no longer applies.

Choose "Flaky" for an unreliable failure. The outcome stays recorded but is excused.
With the supplied presets, that answer carries for 14 days or until its basis changes.
When the hold ends, Mainworthy asks again if the failure still needs a decision.
The project can change the number of days. See [policy](./policy.md).

Choose "Infrastructure" for a failure in the environment.
It excuses the build you are answering about, including its specific environment,
rather than later commits or another environment of that commit.

Choose "Already failing on base" when the same cause already failed where the change
started. It excuses this target only. The next commit is judged separately.
The evidence can show a hint that the same cause fails on the base.

A normal answer to a "Disputed" question classifies its named failures only in that
slot. It cannot replace the cause's answer or another slot's settlement. Later agent
reports of that cause keep a person's settlement while the non-agent evidence and scope stay the same.
"The failure was a mistake" instead sets the named results aside everywhere they
count in an open run and in their commit gate. It does not judge a new failure reported later.
See [runs](./runs.md#resolve-a-disputed-slot).

An excuse removes that failure's block. The gate passes only if no other condition prevents a pass.
Missing results, other failures, and disputes still need attention.

## Judge a finding

A finding asks whether you agree with an observation, often from an agent.
"Accept" agrees with it. In the web queue, a suggestion it carries becomes a proposed
edit by the finder. That edit follows the normal adoption policy.
"Reject" records disagreement. "Duplicate" records that another finding covers it.
"Defer" records that you are leaving it for later.

These answers stay with the finding's recorded basis.
They do not convert a review into a runtime pass or directly change a commit's gate.
A review's completion record is separate. A new commit under the same pull request needs another review, even if the case text is unchanged.
See [agents](./agents.md) for the distinction between reviews and test results.

## Close a completed run

A sign-off question asks whether to close a planned run that passes.
"Approve" closes it with its current verdict. "Reject" leaves it open.
Approval is refused if the run no longer passes when the answer arrives.
Under `loose` and `standard`, a recorded rule normally approves a passed run.
Under `strict`, a person supplies the answer and a reason.
See [runs](./runs.md#close-and-reopen-a-run).

## Undo or withdraw an answer

To withdraw your latest answer, press <kbd>u</kbd>.
To withdraw an earlier answer, follow these steps.

1. Open "Settled".
2. Select a decision.
3. Use its withdrawal button.

Your authority still depends on the current policy.
The original decision and its withdrawal both stay in the record.

Undo names the decision returned by your answer. If somebody replaced it meanwhile,
the withdrawal conflicts and their decision stays. The withdrawal button in "Settled"
names the decision shown there. Read the question again before withdrawing a replacement.
For several answers, undo withdraws each decision separately. A refused answer is not
withdrawn, and a failed withdrawal does not stop the others. The message names the failed withdrawals.
Pressing <kbd>u</kbd> again retries only those withdrawals, with the same decision ids and command ids.
If the server took a withdrawal but its reply was lost, the retry reads its recorded reply.
If somebody already withdrew the decision, the queue reads the question again and says
it is already open.

API and command-line callers can send `{"undo":"Q-12","ifDecision":31}`. The server
compares `ifDecision` inside the transaction that withdraws the decision. Without it,
undo deliberately withdraws whichever decision currently stands, subject to the current
policy. Use the receipt's `decision` id when taking back a specific answer. Advice is
not a decision receipt, and undo does not withdraw advice on an open question.

Withdrawing an excuse recomputes gates that depended on it. A failure can become
unexplained again. Withdrawing a link removes that decision's link unless a newer
link has replaced it. Withdrawing an approval reopens its run.

An adopted proposal cannot be withdrawn. Restore earlier case content as a new
version instead. See [write cases](./write-cases.md#read-versions-and-restore-earlier-content).
Withdrawing an older decision does not undo standing work made by a newer decision.

## Create or link a tracker defect

An operator can [configure GitHub Issues or Jira Cloud](./configuration.md#variables-the-server-reads) for a project and destination.
If both trackers name the same Mainworthy project, Mainworthy uses Jira for new defects and links.
A link then takes a Jira key. Mainworthy still checks existing holds from either tracker.

Use `mainworthy tracker` or the API to create an issue from a failed or errored result.
The request sends the failure message and detail, the tested target, and the reported build URL to that destination.
It also sends the recorded case version and its content when known.
Review what the report contains before sending it to a public repository or shared Jira project.

A test's `get` reply lists result ids in `last[].id`.
A case's `timeline` reply also includes result ids. A run slot lists result ids in `fills[].result`.
If the failed result is `123`, use these commands:

```
mainworthy tracker --json '{"do":"create","result":123,"cmd":"defect-result-123"}'
mainworthy tracker-status --id defect-result-123
```

The request needs `produce`. Reading its status needs `read`.
The server sends up to twenty queued requests once a minute.
When stopping, it waits for the request already in flight and leaves queued requests for the next start.
If saving that reply fails, the server logs the error once and finishes shutting down.
A completed request returns an issue URL and the issue's state as the tracker reported it.
To check an existing issue, use these commands:

```
mainworthy tracker --json '{"do":"link","result":123,"key":"42","cmd":"link-result-123"}'
mainworthy tracker-status --id link-result-123
```

If only GitHub is configured for the project, use the issue number in the configured repository.
Mainworthy refuses pull requests. For Jira, use the issue key in the configured project, for example `QA-42`.
Record the returned URL as the optional reference in a **Defect in the product** answer.
Creating or checking an issue does not answer the failure question. The answer still follows the project's policy.

Reuse the same `cmd` when retrying a request after a lost reply.
Its first receipt still says `queued`, so use `tracker-status` to read the current delivery state.
The server does not retry a failed request automatically.
After a timeout or a restart that leaves a request `sending`, check the tracker before creating another request.
The issue may already exist. Link that issue if you find it.

Delivery requests and their status stay on this instance. Archives leave them out.
To keep the issue reference in an archive, record the reference in a decision before archiving.
A restored archive keeps historical command receipts but has no corresponding tracker status.
The restored instance does not send those requests again.
Requirement mirroring, Azure DevOps, and GitHub Enterprise remain planned.

### End a defect hold when its issue closes

The server checks defect references that exactly match an issue URL or tracker reference in the configured destination.
GitHub uses `closed`. Jira uses status category `done`, regardless of the status's display name.
The server records an ending decision with a reason naming the issue and removes the old excuse.
If the failure still appears, the server asks it again.
Closure does not count as a passing test. If the issue reopens, the old hold does not return.

Answering the reopened question as a defect with the same closed issue ends the hold again at the next check.
The server checks up to twenty due defect decisions each minute.
After a failed read, it keeps the hold and retries with increasing delays, up to an hour.
The deadline survives a restart. The server does not poll references outside the configured destination or in another format.
GitHub references look like `github:example/shop#42`. Jira references look like `jira:https://example.atlassian.net#QA-42`.

An archive keeps the defect decision and its reference but leaves out polling state.
If the destination is configured on the instance, the server checks live defect holds afresh after import.

If a check fails, the defect decision in the queue and the failure's case history show when the tracker first became unreadable.
They also show a short reason. The question's `get` reply and the decided `inbox` reply carry the warning in `decision.trackerError`.
A successful read clears the warning. The server logs one warning per failing issue until a successful read clears the failure.
Several holds naming the same issue, retries, and restarts do not repeat the warning.

For HTTP 401, ask the operator to renew the tracker token in the server configuration and restart the server.
For HTTP 403 or 404, check the account's permissions and the issue key.
If the issue moved to another key, withdraw the old defect answer.
Answer the failure again with the new key's canonical issue URL or tracker reference.
If Jira returns status category `undefined`, set the issue's status category to `new`, `indeterminate`, or `done` in Jira.
The hold stays until a successful check finds the referenced issue closed, or you withdraw or replace the answer.

## Check who may answer

The question says whom it needs. Your token's capabilities and the project's policy
both matter. An agent's answer can count, remain advice, or be refused.
A pipeline cannot answer. Some failure decisions require a person who did not
produce the evidence. Read [policy](./policy.md) before changing those rules.
