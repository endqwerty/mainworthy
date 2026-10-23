# 0143: Pending run plans have separate device keys

2026-10-22. Fixes [issue #781](https://github.com/endqwerty/mainworthy/issues/781).

Two tabs can submit different run plans before either sees the other's saved request. A shared localStorage
key lets the second plan overwrite the first. If the second succeeds and the first request fails, the first
tab mistakes the missing record for a completion or Discard and clears its choices.

Each new command gets its own key under the existing person and project prefix. A saved plan carries its key
and parsed input together. Retry checks that record first; opening the planner discovers a remaining record.
Success, an operation refusal, and Discard remove only that command's record. The original project
identity remains part of the saved input and every replay. Existing records under the former shared key are
read as individual plans without rewriting them.

Web Locks could serialize the shared claim, but the API requires a secure context. Mainworthy supports plain
HTTP at network names, as checked by `test/e2e/followups.test.ts`. Separate keys also let independent plans
proceed without waiting for one another. Recovery presents remaining requests one at a time, with the existing
Retry and Discard actions.

The browser regression holds both claims out of storage until both submissions have read it empty. It then
publishes both, lets the second tab finish or fail, and checks that the first plan survives through reload and
retries unchanged. The existing cross-tab Discard and queued-retry checks still apply.

Principles: Separate Before Serializing Shared State (one key per independent command); Make Operations Idempotent
(retry the saved command unchanged); Minimize Reader Load (keep a storage key with its parsed input).
