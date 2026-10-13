# How Mainworthy works

The whole product in one page: what it records, how a failed test becomes a question, and why only a decision can change a verdict. Read it once and the screens and commands will make sense.

[Diagram: how Mainworthy works](../diagrams/overview.html)

## Three kinds of record

Mainworthy keeps three things, and keeps them apart.

- **Cases** say what the software should do. A case is a title and steps, each with an expected result. Every edit is a new version. Old versions stay.
- **Results** say what was observed. A person pressing <kbd>p</kbd> in a run, a pipeline uploading JUnit XML and an agent reporting a batch all produce the same kind of record.
- **Decisions** say what people made of it. "This failure is a product bug." "This edit is accepted." Each one names who decided and on what evidence.

Nothing in the record is edited in place. A change of mind is a new row that names the one it replaces, so you can always see what was believed and when.

## Evidence comes with its basis

A result is only worth something if you know which version of which case it was for. Mainworthy calls that the result's basis and never guesses it silently.

| Basis | When | What it means |
| --- | --- | --- |
| Exact | A run pinned the version, or the test names it | The result is for that version of the case. |
| Assumed | The test is linked to a case | The result is taken to be for the case's current version. |
| Unresolved | The test has no case | The result is kept and still counts for the commit's gate. It is not credited to any case. |

[Report results](./report-results.md) shows how a test gets linked to a case.

## Evidence raises questions

Mainworthy does not ask you to look at every red test. It turns evidence into questions, one for each cause.

A failure message is reduced to a signature, so the same cause in 500 tests is one question, not 500. There are five kinds of question: a proposed edit to a case, a test with no case, a failed result, a finding from a review, and closing a run.

Every open question waits in one place, the queue. [Decide in the queue](./decide.md) lists the answers each kind takes.

## Only a decision changes what is current

Some things are "current": the version of a case that is in force, which case a test belongs to, how a failure counts, whether a run is closed, the policy itself. Each of these changes in exactly one way, through a decision.

A decision is an answer to a question. A person gives it with one key. Where the project's policy says so, a rule gives it at once, and the rule's decision is recorded like a person's.

Decisions carry forward. When the same cause fails again while a decision about it still holds, nobody is asked twice. Withdrawing a decision undoes what that decision did and nothing else, and both stay in the record.

## Runs and the gate

A run says which results count and what is needed before it is complete. It does not own the results.

- A **change run** exists for each commit that a pipeline or a person has reported. It counts tests.
- A **planned run** is one you start by hand. Each case you pick becomes a slot pinned at the case's version, and people, pipelines and agents can fill the slots. [Planned runs](./runs.md) explains them.

The gate is the answer for a commit, a change or a run. It has four verdicts, and `mainworthy gate` exits with a code for each.

| Verdict | Exit code | What it needs |
| --- | --- | --- |
| `passed` | 0 | Nothing. |
| `failed` | 1 | A fix. A decision said a failure is real. |
| `blocked` | 2 | A decision. A failure has no explanation yet, or two results disagree. |
| `pending` | 3 | Evidence. A report has not arrived or is still being applied, or nothing was proven. |

When you answer a failure in the queue, the verdict is worked out again at once. A flaky test you excuse turns the gate green without the pipeline running again. [Changes and the gate](./changes.md) has the details.

## Policy says who answers

How strict a project is depends on its policy: a table that says, for each kind of question, who must answer and what an agent's answer is worth. Under `loose`, the default, your own edits take effect at once and a person is asked about failures. Under `standard` an agent's edit waits for a person. Under `strict` a person answers everything and gives a reason.

The data is the same under all three. You can switch without migrating anything. [Policy](./policy.md) compares them.

## People, pipelines and agents use the same operations

The web UI, the `mainworthy` command, the HTTP API and an agent's tools are four ways to call one list of operations. There is no feature that exists in the UI and not in the API.

What a caller may do depends on who it is. A person, an agent and a pipeline each hold capabilities on a project. A pipeline can record results and read the gate, and nothing else, whatever it is granted. An agent's report is shown and asked about but never moves a commit's gate. [People, agents and pipelines](./access.md) explains grants and tokens.

## Where to go next

- Try it: the [quickstart](./quickstart.md).
- Adjust it: [what you can customize](./customize.md).
- Look up a word: the [glossary](./glossary.md).
