---
id: 891
category: Fixed
date: 2026-10-24
issue: https://github.com/endqwerty/mainworthy/issues/891
pr: https://github.com/endqwerty/mainworthy/pull/920
---

Folder creation and version-restore Undo belong to the project loaded by the suite page. Both keep the same command when a reply is lost and check its recorded outcome before retrying. A recorded restore leaves later edits alone, and a replaced project refuses the old action.
