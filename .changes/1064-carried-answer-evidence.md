---
id: 1064
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/1064
pr: https://github.com/endqwerty/mainworthy/pull/1074
---

Changing a standing failure answer after it carries to more failing tests now requires reading the extended evidence. A changed answer sent with the earlier evidence hash returns `conflict` with the current hash, while repeating the standing answer with its original hash still returns `already`.
