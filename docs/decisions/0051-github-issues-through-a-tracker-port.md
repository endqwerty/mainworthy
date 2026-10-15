# 0051: GitHub Issues through a tracker port

## Problem

[Issue #32](https://github.com/endqwerty/mainworthy/issues/32) needs outbound tracker integrations. The MVP kept pasted references only. The registry runs operations in synchronous database transactions. An external request must not hold that transaction or the instance's writer while it waits.

## Usage

The operator sets `MAINWORTHY_GITHUB_PROJECT`, `MAINWORTHY_GITHUB_REPOSITORY`, and `MAINWORTHY_GITHUB_TOKEN` outside the repository. The token needs Issues write permission on the destination repository, as specified in the [GitHub Issues REST documentation](https://docs.github.com/en/rest/issues/issues#create-an-issue). A caller with `produce` queues a request through `tracker`:

```
mainworthy tracker --json '{"do":"create","result":123,"cmd":"defect-result-123"}'
mainworthy tracker-status --id defect-result-123
mainworthy tracker --json '{"do":"link","result":123,"key":"42","cmd":"link-result-123"}'
```

The caller uses the returned issue URL as the reference in an ordinary `defect` answer. The answer still follows the project's policy. Creating or checking an issue does not excuse the failure.

## Shape

`TrackerPort` has two asynchronous methods: `createDefect({ title, body })` and `getItem(key)`. Both return a tracker reference, a URL, and the item's open or closed state. The GitHub adapter owns the API protocol and validates replies, including rejecting pull requests from the Issues endpoint. Later Jira and Azure DevOps adapters can implement this boundary without changing failure decisions.

The `trackers` module owns `tracker_requests`. The `tracker` operation snapshots the failed result, its recorded case version, and its build URL. The minute job claims queued work under the write gate, releases the gate, calls the port, then records the outcome under the gate. Delivery uses a random request nonce so a response cannot attach to a replacement row after an archive operation. Overlapping minute jobs share one delivery run.

Credentials are process configuration. No operation accepts a tracker token, and no database row holds one. `tracker_requests` is `UNEXPORTED` because an archive must not replay delivery on another instance. Restoring an archive discards delivery status, including completed references that have not been recorded in a decision. Existing command receipts remain historical and do not recreate those requests. Migration 0019 changes no exported table, so the archive version stays unchanged.

## Synthesis decision

A synchronous operation that enqueues work keeps the registry's transaction contract intact and makes a queued request durable before any external write. The port hides the GitHub transport, response parsing, timeout, and canonical reference format from delivery and decisions.

## Alternatives considered

- An asynchronous operation inside the existing registry would require a new transaction lifecycle across every caller. It could hold the writer during network waits or leave the external write outside the registry's normal retry guarantees.
- A prefilled GitHub web URL would avoid server credentials and delivery state, but could not validate an existing issue or create an issue through the outbound API.

## Tradeoffs accepted

GitHub offers no creation idempotency key here. Every queued request gets one delivery attempt. A lost reply, timeout, or crash can leave an issue created without a recorded reference. Failed requests are not retried automatically, and a request left `sending` stays uncertain after restart. The caller checks GitHub before creating another request, and can link an issue they find. Retrying the same command id never creates another issue.

Delivery runs once a minute, up to twenty requests per run, with a fifteen-second timeout per GitHub call. The first slice configures one github.com repository for one project per instance. It has no dedicated web or iPhone controls and adds no MCP tools. Requirement mirroring, ending defect holds when an issue closes, Jira, Azure DevOps, and GitHub Enterprise remain later slices of issue #32.
