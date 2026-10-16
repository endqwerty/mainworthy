# How Mainworthy works

Mainworthy records cases, results and decisions. A failed test raises a question, and the evidence and decisions together determine the gate's verdict.

[Diagram: how Mainworthy works](../diagrams/overview.html)

## Three kinds of record

Mainworthy keeps three kinds of record separate.

- **Cases** say what the software should do. A case has a title and steps with expected results. Steps can include pinned versions of [shared steps](./write-cases.md). Every edit to that content is a new version, and old versions stay. Moving a case, tagging it or archiving it is recorded in its history without a new version.
- **Results** say what was observed. A person pressing <kbd>p</kbd> in a run, a pipeline uploading JUnit XML and an agent reporting a batch all produce the same kind of record.
- **Decisions** say how people interpreted the evidence. "This failure is a product bug." "This edit is accepted." Each one names who decided and on what evidence.

Corrections preserve the earlier record. A change of mind adds a decision that names the one it replaces, so the retained history shows what people decided and when. Automatic [demo refreshes](./customize.md#a-project-of-demo-data) replace the demo project's history at startup.

## Evidence comes with its basis

A result's basis says which version of which case the result is for. Mainworthy records whether the basis is exact, assumed, or unresolved rather than guessing silently.

| Basis | When | What it means |
| --- | --- | --- |
| Exact | A run pinned the version, or the test names it | The result is for that version of the case. |
| Assumed | The test is linked to a case | The result is taken to be for the case's current version. |
| Unresolved | The test has no case | The result is kept and still counts for the commit's gate. It is not credited to any case. |

[Report results](./report-results.md) shows how a test gets linked to a case.

## Evidence raises questions

Mainworthy does not ask you to look at every red test. It turns evidence into questions, one for each cause.

Mainworthy reduces a failure message to a signature, so occurrences of the same cause share a question.
If a commit's reports together have an assertion signature in more than 50 distinct tests across more than five
reported files, Mainworthy splits that cause by file in the report that crosses those limits and in later reports.
Each question names its file with "Split by file". Earlier results and answers keep their grouping and effects.
Timeouts and infrastructure failures stay grouped.

There are five kinds of question:

- a proposed edit to a case
- a test with no case
- a failed result
- a finding from a review
- a request to close a run

Every open question waits in one place, the queue. [Decide in the queue](./decide.md) lists the answers each kind takes.

## Only a decision changes what is current

Some things are "current": the version of a case that is in force, which case a test belongs to, how a failure counts, whether a run is closed, the policy itself. Each of these changes in exactly one way, through a decision.

A decision is an answer to a question. A person gives it with one key. Where the project's policy says so, a rule gives it at once, and the rule's decision is recorded like a person's.

Decisions carry forward. When the same cause fails again while a decision about it still holds, nobody is asked twice. Withdrawing a decision reverses only that decision's effects. The decision and its withdrawal both stay in the record.

## Runs and the gate

A run says which results count and what is needed before the run is complete. Results exist independently of runs.

Mainworthy has two kinds of run.

- A **change run** exists for each commit that a pipeline or a person has reported. It counts tests.
- A **planned run** is one you start by hand. Each case you pick becomes a slot pinned at the case's version, and people, pipelines and agents can fill the slots. [Planned runs](./runs.md) explains them.

The gate is the answer for a commit, a change or a run. It has four verdicts, and `mainworthy gate` exits with a code for each.

| Verdict | Exit code | What it needs |
| --- | --- | --- |
| `passed` | 0 | Nothing. |
| `failed` | 1 | A fix. A decision said a failure is real. |
| `blocked` | 2 | A decision. A failure has no explanation yet, or two results disagree. |
| `pending` | 3 | Evidence. A report has not arrived or is still being applied, or nothing was proven. |

Mainworthy computes the verdict from the evidence and the decisions in force. The verdict changes when the evidence or decisions change. When you answer a failure in the queue, Mainworthy computes the verdict again at once. If nothing else blocks the gate, excusing a flaky failure can turn the gate green without another pipeline run. A passing retry can do the same without a decision. [Changes and the gate](./changes.md) has the details.

## Policy says who answers

A project's policy says who must answer each kind of question and what an agent's answer is worth. Under `loose`, the default, case edits take effect at once. A rule excuses failures already present on the base while their evidence holds, and a person answers other failures. Under `standard` an agent's edit waits for a person. Under `strict` a person approves case edits, answers failures and findings, and closes runs, with a reason. The policy can still track tests without cases by rule.

The data is the same under all three presets. You can switch without migrating anything. [Policy](./policy.md) compares them.

## People, pipelines and agents use the same operations

The web UI, the `mainworthy` command, the HTTP API and an agent's tools are four ways to call one list of operations. Changes to project records use those operations, whichever client sends them. Ten operations are also agent tools. For another one, such as planning a run, an agent uses the command line or the API.

What a caller may do depends on the caller's identity. A person, an agent and a pipeline each hold capabilities on a project. A pipeline can report results, announce deployments, mark changes as ended and read the gate. It can also hold `read` for project data. It can never edit, answer, plan or administer, whatever it is granted. An agent's report is shown and asked about but never moves a commit's gate. [People, agents and pipelines](./access.md) explains grants and tokens.

## Where to go next

- Follow the [quickstart](./quickstart.md).
- See [what you can customize](./customize.md).
- Look up words in the [glossary](./glossary.md).
