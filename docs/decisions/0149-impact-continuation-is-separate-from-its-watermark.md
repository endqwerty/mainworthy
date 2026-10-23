# 0149: Impact continuation is separate from its watermark

2026-10-22. Fixes [issue #396](https://github.com/endqwerty/mainworthy/issues/396).

`impact` selected more cases than its 200-case reply held and returned a project watermark that covered
the omitted cases. A files-only caller could never reach those cases. Processing only 2,000 of the
5,000 accepted paths, 500 tests per file, and 200 failing tests also silently cut the selection short.

Keep the 200-case reply cap. Add input `cursor` and output `next`, separate from the output `cursor`
used as a later `since`. Counts cover the whole selection. Order unreviewed cases first, then by case
number, independently of file and test insertion order. Process every accepted path, every linked
case in each file, and every failing test in the head run. The uncovered-path count is complete; its
list remains the first 50 paths.

An opaque continuation carries the next offset and a fingerprint of the request, caller, project
identity, and project sequence. A retry returns the same page. Different inputs or any project write
refuse continuation with a conflict. Restart without `cursor` and keep the original `since`; finish
paging before writing reviews. A malformed or out-of-range continuation is invalid. No server state
is written by reading a page.

Until `next` is null, the output watermark keeps the original `since` base, or `s:0` when absent.
Only the final page advances it to the read's project sequence. An interrupted reader can repeat
work but cannot mark omitted cases as delivered. This changes the watermark semantics for callers
that treated the first page as complete; no stored data or migration changes.

The registry generates the CLI's `--cursor`, MCP input and OpenAPI. The web's More affected cases
control appends pages and refreshes them together on project changes. The merge receipt remains a
bounded manifest on every page. Its frozen results retain their separate `find` continuation.
The iPhone reads all impact pages before showing affected cases and restarts its detail read once if
continuation conflicts. It checks the complete count and refuses duplicate cases or repeated cursors.

Stored selection snapshots would allow writes between pages but require storage, expiry, and access
rules. Revision-bound continuation follows proposal paging and is enough to repair reachability.
Ranking beyond unreviewed status and case number, snapshots that survive writes, and pagination of
uncovered paths remain separate product choices. This change supplies none of them.

The demo change now names its existing checkout test files as well as source paths, so the default
suite supplies more than 200 affected cases and shows continuation. Its target metadata lives in
`src/cli/demo/history.ts`; `seed.ts` sends it. No cases or random draws change. An earlier demo's
saved seed request has different metadata, so reset that demo or use a new project before reseeding.
Registry, CLI, MCP and browser regressions exercise 450 cases, stopping after one page, completion,
repeated reads, changed state, and the receipt alongside the selection.

Principles: Fix Root Causes (page the shared selection); Model the Domain (separate continuation from
the completed-work watermark); Boundary Discipline (validate the continuation before using its
offset); Laziness Protocol (reuse revision guards without stored snapshots); Test Behavior, Not
Implementation (check the registry, CLI, MCP and web).
