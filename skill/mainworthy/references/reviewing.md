# Review a change

1. Call `impact` with a `change` key such as `pr:482`, or with changed `files`. Read the counts, affected cases, reasons, hashes, open questions, and uncovered files. Keep the cursor.
2. Read only the cases you need with `get`, `as: "md"`, and saved hashes in `unless`. Use `fields` for data reads that need only part of a case.
3. Read the patch. Challenge each case's starting state, steps, and expected results. Try the uncovered paths with your own test tools. Mainworthy records observations; it does not run the software for you.
4. Batch findings in `claim`. Set `lens: "adversarial-review"`, `about` to the change key, and `reviewed` to the case refs and hashes, such as `C-1@hash`. Record a review even with no findings. Read `known` before raising the same issue again.
5. To advise on a failure, read its question from `inbox`. Call `decide` with the `evidenceHash` as `onEvidence`, an answer such as `{"is":"defect"}`, and the facts behind it. With only `read` and `produce`, your answer is advice.
6. After a fix, pass the saved cursor as `since` to `impact`. Read what moved. Review the patch at each new head; an unchanged case hash does not mean unchanged code. For a fresh review, set `ledger: false` and read the needed cases again.

Use a category from `FindingCategory`:

| Category | Use when |
| --- | --- |
| `cannot-fail` | The expected result allows a wrong outcome to pass. |
| `ambiguous` | A step or expected result has more than one meaning. |
| `missing-expected` | A step has no expected result. |
| `uncovered-path` | No case tests a relevant path or requirement. |
| `duplicate` | Two cases test the same behavior with the same starting state. |
| `outdated` | The case describes behavior that no longer applies. |
| `defect` | The software fails an expected result. |
| `other` | None of these categories fits. Explain the issue. |

Name the case in `on`, or a step such as `C-1#b7`, a requirement such as `req:WEB-290`, or the change. State the failure in `note`. Put the steps to reproduce it in `repro` and a concrete repair in `suggest` when you have one.
