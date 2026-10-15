# 0061: Publish commit gates as GitHub commit statuses

## Problem

[Issue #55](https://github.com/endqwerty/mainworthy/issues/55) completes commitment C3 for GitHub. The pipeline's `gate` exit code cannot change after the job ends. A later decision can change Mainworthy's verdict while GitHub still shows the earlier job result. Outbound requests must release the instance's writer, as in [decision 0051](0051-github-issues-through-a-tracker-port.md).

## Usage

The owner sets `MAINWORTHY_GITHUB_STATUSES=1` and `MAINWORTHY_PUBLIC_URL` alongside `MAINWORTHY_GITHUB_PROJECT`, `MAINWORTHY_GITHUB_REPOSITORY`, and secret `MAINWORTHY_GITHUB_TOKEN`. Use a fine-grained personal access token for that repository with Commit statuses write permission, or a classic personal access token with `repo:status`. The token's user must have push access to the repository. If the same fine-grained token also sends defect requests, it needs Issues write permission.

GitHub's [Create a commit status documentation](https://docs.github.com/en/rest/commits/statuses#create-a-commit-status), read 2026-10-15, lists fine-grained personal access tokens and requires: **"Commit statuses" repository permissions (write)**. Its [scope documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps#available-scopes) says `repo:status` **"Grants read/write access to commit statuses in public and private repositories."** These credentials support the chosen endpoint. Check-run writes require a GitHub App, so they cannot use the personal token this configuration accepts.

A counted report with the configured repository and a full, lowercase, forty-character commit hash enrolls that commit. Reports accepted before publication was enabled are not enrolled retroactively. Reports from agents, session targets, other projects, and other repositories enroll nothing.

A pull request shows `mainworthy/gate` among its status checks, with the gate's reason shortened to 140 characters and a link to the change on the instance. A trunk commit links to its run. `passed` maps to `success`, `failed` to `failure`, `blocked` to `error`, and `pending` to `pending`. This status is separate from the CI job and cannot change that job's exit code.

## Shape

Report acceptance calls `enrollCommitStatus(ctx, target)` inside its transaction. The minute job calls `deliverCommitStatuses(app, port)`. The `statuses` module owns `commit_statuses` and the singleton `commit_status_delivery`; it reads verdicts through the ordinary `gate` function. The GitHub adapter implements `StatusPort.post(draft): Promise<void>`, where a draft carries the commit, verdict, reason, and target URL. It posts to `POST /repos/{owner}/{repo}/statuses/{sha}` with context `mainworthy/gate`. HTTP 201 is acceptance. Response bodies are discarded, and the adapter uses a fifteen-second timeout and rejects redirects.

Each row holds the desired payload, the last payload known to have been accepted, a local random nonce, the next permitted attempt time, a reconciliation deadline, the number of consecutive unsuccessful or interrupted attempts, and a fixed error diagnostic. There is no remote id, lookup, or create/update split. The nonce prevents an in-flight reply from completing a replacement row after an import. The replacement still inherits the attempted commit's minute delay.

Before each post, the claim clears the previously accepted payload because the remote state becomes uncertain until the reply arrives. Success records the payload actually sent, clears the last error, and completes only if that payload is still desired. Any failed or uncertain post leaves the row due with no known accepted payload. A later post always uses the current gate, even if it returned to an earlier value.

The minute job coalesces intermediate verdicts and recomputes enrolled commits, including old commits whose decisions changed. It claims at most twenty commits per run and attempts a commit at most once in sixty seconds. A singleton delivery row holds at most 240 attempt timestamps from the rolling hour, a shared pause deadline, and the consecutive rate-limit failure count. Claims atomically reserve an attempt in both rows before sending. Across jobs, the instance permits at most twenty status posts per rolling minute and 240 per rolling hour, including failed or uncertain attempts. Unchanged accepted payloads send nothing. Every fetch runs outside the write gate. Overlapping jobs share one delivery run; shutdown claims no new rows and waits for an in-flight reply before closing the database.

## Reconciliation lifetime

After thirty days without a desired-payload change or a new counted report, an accepted row stops minute-by-minute gate reconciliation. Its last status remains on GitHub. Later decisions on that inactive commit do not publish until another counted report resumes reconciliation. Rows with failed or uncertain posts stop after sixteen consecutive attempts, regardless of payload changes. Only a new counted report resumes a stopped row and resets its attempt count; existing deadlines still apply. Rows stay in the local table to preserve enrollment and attempt timing; the job skips gate calculation for inactive accepted rows.

Credentials stay in process configuration. `commit_statuses` and `commit_status_delivery` are `UNEXPORTED`, so archives hold neither delivery state nor enrollment. Import does not publish historical commits. A new counted report after import can enroll its commit again. Migration 0014 changes no exported table, so the archive version stays unchanged. It takes the next free number after main's migrations 0008 to 0013. This unshipped status migration replaces the draft check-run table rather than migrating its development data.

## Synthesis decision

We compared a command hook that queues publication on every verdict-changing operation with minute reconciliation of a desired status. The command-hook design would expose enrollment to every writer and still need time-based reconciliation for expiration. We keep report enrollment transactional and reuse `gate` from the minute job. The single-method port hides transport and credential handling without adding a registry operation.

The earlier find/create/update design depended on GitHub App credentials and retained ambiguous remote state after a lost reply. Commit statuses remove that identity problem: GitHub uses the latest posted status for each context. Reposting the current payload after an uncertain write can add a history entry but converges on the gate's current state.

## Failure and retry

An HTTP refusal, server error, timeout, lost reply, or restart during a post consumes an attempt. Before sending, the claim reserves a delay of one minute times two to the number of preceding unsuccessful attempts, capped at one hour. On a failed reply the delay starts again from the reply time. This handles both explicit failures and interrupted posts without bypassing back-off after restart. A successful reply resets the row's attempt count and restores the one-minute spacing for later changes.

After sixteen consecutive unsuccessful or interrupted attempts the row becomes `stopped`. The transition records and logs one fixed diagnostic: "GitHub commit status delivery stopped after 16 unsuccessful attempts; check repository access and Commit statuses write permission, then send a new counted report." No response body or transport exception text enters rows or logs, including exceptions from a supplied port. Decisions and payload changes do not resume a stopped row. A new counted report does.

HTTP 429 pauses every status row, including newly enrolled rows. HTTP 403 does so only with `x-ratelimit-remaining: 0` or a valid `retry-after`. Other 403 replies, including missing permission, use the ordinary per-row back-off, starting at one minute. A shared pause lasts until the longest of the per-row back-off, shared exponential back-off, and applicable header deadlines. `retry-after` accepts seconds or an HTTP date; `x-ratelimit-reset` is UTC epoch seconds and applies only with remaining zero or a valid `retry-after`. Missing or malformed headers leave the exponential delay in force. Each header-derived pause is capped at one day from the reply, so a garbled far-future deadline cannot suspend delivery for years across restarts. One day permits a long cooling-off period while ensuring another attempt after access is repaired. The shared failure count increases across rows and resets after a successful post. Shared deadlines, attempt counts, and rolling timestamps persist across restart. Import clears them along with enrollment.

GitHub's [REST rate-limit documentation](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), read 2026-10-15, gives general content-creation limits of 80 per minute and 500 per hour and requires exponential waits and a finite retry bound for persistent rate limits. The 240-per-hour status budget leaves room for Issues requests using the same token; it cannot reserve capacity against other clients sharing that token. Header deadlines can exceed the one-hour exponential cap, up to the one-day header cap.

We considered an in-memory throttle with a retry counter and a durable scheduler policy. An in-memory throttle forgets both shared pauses and consumed capacity on restart. The durable singleton keeps global scheduling inside the statuses owner, while the existing per-commit row owns its back-off and stop state. The port exposes only numeric rate-limit timing through `StatusRateLimit`, without returning response bodies or credentials.

## Alternatives considered

- Posting directly from `decide` would require asynchronous registry transactions and still miss reports, withdrawals, policy changes, and expiration.
- A GitHub App with installation-token refresh could publish check runs, but adds app keys, installation discovery, and token lifecycle management. Commit statuses support the configured personal token and need one write action.

## Tradeoffs accepted

This slice supports one github.com repository and one project per instance. The minute cadence adds delay; busy instances can need several runs to drain their queue. Accepted commits become inactive after thirty days without a payload change or counted report. GitHub limits each SHA and context to 1,000 status history entries. Unchanged accepted states create none, but repeated changes or lost replies can reach that limit; persistent refusal stops after sixteen attempts and requires operator investigation followed by a new counted report. There is no webhook, new operation, MCP tool, required-status configuration, or GitHub Enterprise support. Existing CI jobs remain independent checks and may still need a rerun.
