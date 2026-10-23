---
name: mainworthy
description: Use when you review a change, write test cases, or record test results and advice in Mainworthy.
---

1. Start with `impact` for a change or `files`, or `inbox` for questions. Page `next` as `cursor` with unchanged inputs until null; save only the final `cursor` for `since`. Restart after project writes. Use `ledger: false` for fresh eyes.
2. Use `get` for only the cases you need, with `as: "md"`. Pass saved document `etag` values in `unless` for the same `as` and `fields` to skip unchanged cases. Use `since` for changes after a cursor.
3. Review the patch and try to break the software with your own tools. Batch findings in `claim` with `about`, `patch` from `impact.change.head`, and `reviewed` entries as `C-1@hash`, even with no findings. Batch observed outcomes in `report`.
4. Read the question's `evidenceHash` from `inbox`. Pass it as `onEvidence` to `decide`, with a reason. Your answer may be `advised`; check the status before saying a question is settled. Read the verdict with `get` on `commit:<hash>`, `change:<key>`, or a run ref. Before working, `work` with `do: "take"`, `run`, and no `slot` takes the next free slot.

Pass `project` when the instance has more than one project. References:

- [Write cases that can fail](references/writing-cases.md), including canonical Markdown and `propose`.
- [Review a change](references/reviewing.md), including finding categories and fresh reviews.
- [Report results](references/reporting.md), including basis and corrections.
- [Tool inputs](references/tools.md), generated from the registry.
