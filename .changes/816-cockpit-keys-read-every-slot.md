---
id: 816
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/816
pr: https://github.com/endqwerty/mainworthy/pull/986
---

In the run cockpit, <kbd>j</kbd> and <kbd>k</kbd> now move through every slot, including slots other people, pipelines or agents filled. Before, they passed over those slots, so in a run others had filled completely they did not move at all. Recording a result still moves on only to a slot waiting for your first report.
