# 0084: Jira Cloud and ending defect holds

## Problem

[Issue #32](https://github.com/endqwerty/mainworthy/issues/32) still needs Jira Cloud and an end to a defect hold when its issue closes. Decision 0051 introduced the tracker port and durable outbound requests. A defect answer currently carries while its evidence holds, even after its external issue closes.

## Usage

Set these variables in the server process, outside the repository:

```
MAINWORTHY_JIRA_PROJECT=scratch
MAINWORTHY_JIRA_SITE=https://example.atlassian.net
MAINWORTHY_JIRA_PROJECT_KEY=QA
MAINWORTHY_JIRA_ISSUE_TYPE=Bug
MAINWORTHY_JIRA_EMAIL=robin@example.com
MAINWORTHY_JIRA_TOKEN=<secret>
```

Use the existing operations. No new registry operation or MCP tool is needed:

```
mainworthy tracker --json '{"do":"create","result":123,"cmd":"defect-result-123"}'
mainworthy tracker-status --id defect-result-123
mainworthy tracker --json '{"do":"link","result":123,"key":"QA-42","cmd":"link-result-123"}'
```

Record the returned URL in a normal `defect` answer. A pasted canonical issue URL or tracker reference works too, provided it names the configured project and destination. Jira references are `jira:https://example.atlassian.net#QA-42`. GitHub references keep `github:example/shop#42`. Arbitrary references remain valid answers, but are not polled.

Jira is the destination for new defect requests when both adapters name the same Mainworthy project. GitHub can still publish commit statuses and both adapters can read existing defect holds. Already queued requests keep their original destination and fail without sending if that destination is no longer configured.

## Shape

The adapter implements the existing `TrackerPort`. It sends `POST /rest/api/3/issue` with `fields.project.key`, `fields.issuetype.name`, `fields.summary`, and an Atlassian Document Format description. Each line becomes a paragraph of plain text. Empty lines become empty paragraphs. A successful create reply supplies a key, so the adapter then reads `GET /rest/api/3/issue/{key}?fields=status` to learn its actual status category. Only category `done` maps to closed. Status names and resolution text do not decide closure. Reads reject another key or a key outside the configured Jira project.

These shapes come from Atlassian's public [create issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post), [get issue](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get), [REST v3 OpenAPI document](https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json), and [document format](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/) documentation. Authentication uses the account email and API token as described in Atlassian's [basic authentication guide](https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/). The account needs Browse projects and Create issues permission. The configured issue type must be available on the project's create screen. Projects requiring other fields may reject creation.

The server accepts an HTTPS site origin only, with no embedded credentials, path, query, or fragment. Credentials live only in process configuration. Requests never follow redirects, time out after fifteen seconds, and return fixed diagnostics without copying response bodies, transport exceptions, or configuration values. Outbound creation still gets one attempt. If creation succeeds but the status read fails, the caller must check Jira before creating another issue.

`server/tracker-holds.ts` coordinates decisions and tracker reads without changing the module map. The trackers module owns polling deadlines and nonces. The decisions module owns live defect selection and ending standing decisions. It shares the timed-hold ending path: revert the kind handler, record an `outdated` decision signed by the rule with clause `tracker-closed` and a reason naming the issue, reopen the question, and recompute affected runs. The ledger event supersedes the defect decision. A failure still shown is asked again. A failure that has disappeared stays out of the queue. Closure never counts as a passing result, and reopening the external issue does not restore the old excuse.

The existing minute job checks up to twenty due defect decisions, oldest deadline first. Open issues are checked again after a minute. Failed or unreadable status requests preserve the hold and retry after one, two, four, eight, sixteen, thirty-two, then at most sixty minutes. Success resets the back-off. Poll state persists over restart. Overlapping jobs share one run, the writer is free during each network wait, and shutdown stops new reads and waits for the current read before closing the database. Each completion rechecks configuration and the current decision. A random nonce in `tracker_polls` prevents a reply from an earlier archive state ending a replacement hold.

Migration 0018 adds only `tracker_polls`, which is omitted from archives and cleared on import. The archive version stays unchanged. Imported live defect decisions can be polled afresh under the destination instance's process configuration. Poll rows for old decisions can remain locally, but only current defect decisions are scheduled.

## Synthesis decision

Keep the existing port and registry. The caller does not need to manage subscriptions or issue state. The adapter hides Jira's wire format, while the coordinator passes closure evidence to the decisions module. This keeps transport separate from standing and gives the ending the same ledger and run recomputation guarantees as timed expiry.

## Alternatives considered

- Webhooks would avoid polling latency but require new inbound authentication, replay handling, and setup in each tracker. They would expose a second integration workflow before it is needed.
- Ending holds from completed `tracker_requests` would miss pasted references and imported decisions. The live decisions are the authoritative set of holds.
- Writing excuses from the adapter would bypass decisions and lose the ending's reason and supersession chain.

## Tradeoffs accepted

Polling can learn a closure late, especially after failed reads or with more than twenty due decisions. It never guesses closure from a failed read. The limit counts decisions rather than distinct issues, so several holds on one issue can cause several reads. No live tracker account was used for local verification.

The owner's question of who may send to a tracker is unchanged. Today anyone with `produce` can queue a defect, including an agent. Sending can disclose failure and case content to the configured destination. Requirement mirroring, Azure DevOps, and GitHub Enterprise remain outside this slice.
