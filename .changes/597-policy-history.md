---
id: 597
category: Changed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/597
pr: https://github.com/endqwerty/mainworthy/pull/1043
---

Policy adoption skips ended changes whose commits have no open head or planned consumer. Their gates keep their last recalculated answers until another evidence change or reopening needs them. Later plans and new merge receipts reconcile ended evidence under the current policy before using it. Open changes, including heads shared with ended changes, and planned runs, including closed plans with pinned evidence, still update immediately.
