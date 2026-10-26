---
id: 457-file-based-automatic-folders
category: Fixed
date: 2026-10-26
issue: https://github.com/endqwerty/mainworthy/issues/457
pr: pending
---

Cases made from tests now use file-based folders when the directory rule would put them in `Automated`. For example, `test/e2e/docs.test.ts` goes to `e2e/docs`, and `test/policy.test.ts` goes to `policy`. New cases use the computed folder even when someone moved other cases from that file. Existing cases keep their folders; maintainers can regroup them through placement proposals.
