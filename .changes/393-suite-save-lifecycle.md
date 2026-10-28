---
id: 393
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/393
pr: https://github.com/endqwerty/mainworthy/pull/1050
---
The Suite keeps a successful save while it retries reading the recorded version, and taking over a draft with a newer pending save recovers that command instead of reusing an earlier save's reply. Save recovery, read-back and adoption now have named states in their own module.
