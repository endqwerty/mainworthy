---
id: 979
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/979
pr: pending
---

A report that creates cases for tests in many files reads the project's folders once, instead of again for every file and for every folder it creates on the way down. A report creating cases in 50 new folders read every folder 344 times and now reads them once; the folders and cases it makes are the same.
