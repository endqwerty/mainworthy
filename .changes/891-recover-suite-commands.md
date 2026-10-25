---
id: 891
category: Fixed
date: 2026-10-24
issue: https://github.com/endqwerty/mainworthy/issues/891
pr: https://github.com/endqwerty/mainworthy/pull/920
---

Folder creation and version-restore Undo belong to the project loaded by the suite page. Both keep the same command when a reply is lost and check its recorded outcome before retrying. A recorded restore leaves later edits alone, and a replaced project refuses the old action. Leaving a case or parent folder, or cancelling folder creation with Escape, checks the old request once, names its outcome, and drops it without retrying. A new action belongs to the current case or parent. Final refusals show the server message without promising recovery of a dropped request.
