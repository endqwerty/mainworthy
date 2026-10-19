# Report results

Use one `report` call for a batch. Give `target: {commit: "<the whole hash>"}` for a commit, or `run: "R-4"` for a planned run. Use the whole hash the pipeline reports: a report under an abbreviated hash is recorded as another commit. For work without a commit, use `target: {session: "checkout-review"}`. Include the tested commit, branch, environment, job, and attempt when you know them.

The HTTP MCP endpoint accepts request bodies up to 4 MiB. Use the HTTP API or CLI for larger reports.

Each result names an automated test with `test: {key, name, file}` or a case with `test: {case: "C-1"}`. Set `outcome` to `pass`, `fail`, `skip`, `blocked`, or `error`. For a failure, give the observed and expected values in `failure.message`; put needed detail in `failure.detail`. Report only what you observed.

Read the receipt's counts, `basis`, questions, rejected results, and gate. A refused result has a reason in `rejected`; fix the input before reporting it again. An automated result kept without the case it claimed has its reason in `declined`. A recorded result does not by itself mean the gate passed.

An agent's results are recorded and shown, but no commit's gate counts them. They count only in a planned run that asked for agents, on a case that admits them. A failure you report is put to a person as a question. Where only an agent has shown the failure, a pipeline's pass does not close the question: it stays open until a person answers. A commit that only an agent has reported has no gate: it reads `pending` with nothing counted. The `pr` or `branch` you name is not taken either: until a pipeline or a person reports that commit, your findings on it are asked about under the commit itself, and they move to its pull request or line when one of them does.

## Exact basis

Use `annotation: {case: "C-1", version: 2}` when you know which version ran, or report to a run that pins it. The server records that version as `exact` and rejects a result when the annotation and run pin disagree.

## Assumed basis

When a test is linked to a case or names one without a version, the server uses the case's current version as `assumed`. This records a guess about the tested version, so do not call it exact evidence.

## Unresolved basis

When the server cannot name a case for the result, its basis is `unresolved`. The result stays in the record but does not prove that a version of a case passed.

## Corrections

For a wrong result of yours, report a replacement with `corrects` set to the earlier result id. Small-report receipts return these ids in `results`. Keep the test and target clear and explain the correction in `note`. The earlier result stays in the record; the replacement changes which result counts.

Use `inbox` to read any failure question before `decide`. Pass its `evidenceHash` as `onEvidence`. With only `read` and `produce`, your answer is advice, so read `get` with `commit:<hash>`, `change:<key>`, or the run ref for the verdict that counts.
