---
id: 1084
category: Fixed
date: 2026-10-28
issue: https://github.com/endqwerty/mainworthy/issues/1084
pr: https://github.com/endqwerty/mainworthy/pull/1085
---
A report no longer gets slower with every earlier commit of its pull request. Each report used to recheck every
commit ever reported for that pull request against its base, work that grew with the square of their number; now
it rechecks only its own commit and the pull requests based on it.
