# Glossary

These definitions explain the words you see in Mainworthy and its command output, with links to the pages that describe them.

## Actor

A person, an agent, a pipeline, or a rule of the policy that produces a record. Every result, edit and decision names its actor. See [people, agents and pipelines](./access.md).

## Agent

An AI model that uses Mainworthy with a token of its own through MCP, the command line or the API. What an agent's edits and answers are worth depends on the policy. See [let an agent in](./agents.md).

## Answer

Your response to a question. For a failure, the choices include defect, test, expected, flaky, infrastructure, already failing on base, or mistake. An answer that the policy accepts becomes a decision. See [decide in the queue](./decide.md).

## Attempt

One try of a pipeline job on a commit. A retry is a higher attempt. See [report results](./report-results.md).

## Basis

Which version of which case a result is for: exact, assumed or unresolved. See [how Mainworthy works](./concepts.md#evidence-comes-with-its-basis).

## Capability

One thing a grant lets an actor do: `read`, `record`, `produce`, `answer`, `plan` or `admin`. See [people, agents and pipelines](./access.md).

## Case

What the software should do, written as a title and steps with expected results. A case has a ref such as `C-12` and a history of versions. See [write cases](./write-cases.md).

## Change

A commit or pull request that results were reported for, shown on the Changes screen with its gate. See [changes and the gate](./changes.md).

## Clause

One row of a policy. For a kind of question and a set of conditions, the clause says who must answer and what an agent's answer is worth. See [policy](./policy.md).

## Decision

A recorded answer that settles a question, with who gave it, on what evidence and under which clause. Only a decision changes what is current. A decision can be withdrawn, and both stay in the record.

## Draft

What you have typed into a case and not yet recorded as a version. A draft is kept on your device, per person. See [write cases](./write-cases.md).

## Finding

Something a review noticed about a case, reported by a person or an agent. A finding is a question until someone accepts, rejects or defers it.

## Gate

The answer to "is this tested?" for a commit, a change or a run. It has four verdicts. `mainworthy gate` prints it and exits with its code. See [changes and the gate](./changes.md).

## Grant

The list of capabilities an actor holds on one project, or on every project. See [people, agents and pipelines](./access.md).

## Invitation

A link an admin hands a person so that they can choose a password or register a passkey. It works once and runs out. For a person who already exists, the invitation is a recovery link. Accepting it replaces every way they signed in. See [people, agents and pipelines](./access.md#sign-in-as-yourself).

## Job

A named part of a pipeline, such as `e2e`. A planned run can require that named jobs have reported.

## Method

How a case may be exercised, by a person, an automated test or an agent. The case declares whether people and agents may exercise it. A link or a case annotation admits an automated test. The run says which methods it accepts.

## Passkey

A key that a device or a password manager holds for one site and unlocks with a fingerprint, a face or a PIN. A person signs in with it in place of a password. It belongs to the host name of the instance.

## Pipeline

A CI system that reports results with a token of its own. A pipeline can also announce deployments, mark changes as ended and read the gate. A grant can let it read project data. It never edits, answers, plans or administers. See [report results](./report-results.md).

## Planned run

A run you start by hand. Each selected case has a slot pinned at its current version. See [planned runs](./runs.md).

## Policy

The table of clauses that determines who answers questions in a project. `loose`, `standard` and `strict` are the three presets. See [policy](./policy.md).

## Project

One suite with its own cases, results, queue and policy. An instance can hold several. A new instance starts with one called `scratch`.

## Proposal

An edit to a case, a link or the policy, as it was submitted. Saving and proposing are the same call. The policy decides whether a proposal takes effect at once or waits for a person. A proposal has a ref such as `P-4`.

## Question

Something that needs an answer: a proposed edit, a test with no case, a failed result, a finding, or closing a run. A question has a ref such as `Q-7` and waits in the queue. See [decide in the queue](./decide.md).

## Queue

The one list of open questions for a project, most blocking first. Open it with <kbd>g</kbd> <kbd>q</kbd>.

## Result

One observation of one test or case, such as a pass or a fail, with who produced it and its basis.

## Rule

The policy acting by itself. Where a clause assigns an answer to a rule, Mainworthy records the rule's decision at once.

## Run

A request for evidence that specifies which results count and what it needs before it is complete. A change run exists for each reported commit. A planned run is started by hand.

## Session

One signed-in browser. By default, its session ends after 14 days without use or 90 days in total. Sign-out, ending the session, or revoking its token or credential also ends it. A person can list and end their own sessions. See [configuration](./configuration.md) for lifetime settings.

## Slot

One case in a planned run, pinned at a version, waiting for a result by a method the run asked for.

## Tag

A word on a case, written `#checkout` in the outline. The sidebar lists tags, and a run can pick cases by tag.

## Test

An automated test, as a runner reported it. A test has a ref such as `T-9` and may be linked to a case. The Tests screen lists automated tests and their latest results. See [report results](./report-results.md).

## Token

A secret that identifies an actor. The actor's current grants determine what the token can do. Mainworthy shows the token once, when it creates it. See [people, agents and pipelines](./access.md).

## Verdict

What a gate says: `passed`, `failed`, `blocked` or `pending`. See [how Mainworthy works](./concepts.md#runs-and-the-gate).

## Version

One recorded state of a case's content. Every edit to the content that takes effect makes the next version. A move, a tag or archiving is recorded in the case's history and makes no version. You can compare two versions and restore an old one.
