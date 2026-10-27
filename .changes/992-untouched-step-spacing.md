---
id: 992
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/992
pr: https://github.com/endqwerty/mainworthy/pull/999
---
Saving a case from the Suite editor no longer rewrites the spacing inside steps you did not change. Before, changing only the title also joined double spaces and removed indentation in every step's action and expected result, including spacing another session had just stored. Only the text you changed is cleaned now.
