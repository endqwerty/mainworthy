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

## Selection work on each page

The 2026-10-23 audit found that continuation repeated full case hydration before slicing out 200 rows.
It also repeated a file query for duplicate paths and looked up each failing test separately.

Selection now passes compact ID projections between the modules that own the data. One set-based
file query takes distinct paths and aggregates candidate IDs and file-coverage flags; requirement
case IDs, failing-test links and question refs are also read in batches. Active case heads and a
batch review-existence query supply the rank. SQLite aggregates the counts and orders IDs at the
existing cursor offset. Only those 200 case rows load titles, file and requirement reasons,
latest-result summaries and open-question summaries. Latest results use three indexed seeks per page
case, one per method. Question summaries retain the existing latest-200-questions window per case.
Neither query reads the full result history or question evidence bodies.

The raw request still determines the fingerprint: `files: ["a", "a"]` and `files: ["a"]` have different
continuations even though their file query is identical. The supplied file count and uncovered-path
reporting retain their existing input order and multiplicity. No schema or cursor semantics change.

A regression uses the registered read as a read-only actor. Continuation with 450 versus 4,500
selected cases executes 18 statements and returns 200 full case rows and 200 requirement links in
both cases. Repeating a linked path 5,000 times executes the same nine statements as supplying it
once, with file reasons fetched only for the page. These are query and
hydration bounds, not constant-time claims: selecting links, reading compact heads, calculating
review bases and sorting IDs still scale with the selected data on every page.

The failing-test branch before this PR, at `650e2a06`, read at most 200 failing run rows and performed
at most 200 individual test lookups. Removing that cap to make the selection complete introduced the
uncapped source read; it was not already uncapped in that branch. It now reads only distinct failing
test IDs, then resolves distinct linked case IDs in one evidence query. No per-test lookup or raw
result payload is loaded. SQLite still scans the run's failing-test source, including its lanes.
The 100,000-result report limit is not a run-size limit: a run can accumulate multiple reports.

There is no new source-row ceiling or per-actor concurrency policy here. The existing 20,000-case
limit belongs to planning one run, not reading a change's impact; applying it would newly refuse
otherwise reachable cases and would not itself bound the source scan. A source-work ceiling needs
its own contract for large changes. This repair removes query amplification and full-selection
hydration without inventing that limit or claiming that all database work is independent of size.

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
