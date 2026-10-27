---
id: 972
category: Fixed
date: 2026-10-26
issue: https://github.com/endqwerty/mainworthy/issues/972
pr: https://github.com/endqwerty/mainworthy/pull/983
---

Creating cases for a file's tests with no case, by the **Create** setting or a `create` answer, now makes a case for every test in the file. A file with more than 500 such tests used to get cases for its first 500 and leave the rest unlinked with no question. The question about such a file counts all of its tests, and a file answered **Track** is asked about again when a test past the 500th turns up.
