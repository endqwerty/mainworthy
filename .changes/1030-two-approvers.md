---
id: 1030
category: Added
date: 2026-10-27
pr: https://github.com/endqwerty/mainworthy/pull/1054
---

Sign-off clauses can require multiple distinct people to approve the same planned-run evidence. Pending approvals keep the run open; changed evidence requires fresh approvals. The queue and decision replies record each approver's reason and policy basis. One approval remains the default. Queue distinguishes recording an approval from closing a run, acknowledges your pending approval, and hides Approve once you have approved. Pending lists omit approvals that no longer qualify. Custom sign-off clauses now enforce `notProducer: true`, including the default one-approval path; previously this restriction was ignored for sign-off.
