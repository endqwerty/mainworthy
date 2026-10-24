---
id: 903
category: Changed
date: 2026-10-23
issue: https://github.com/endqwerty/mainworthy/issues/903
pr: https://github.com/endqwerty/mainworthy/pull/909
---
The configured demo refreshes once per deployed commit. Same-revision restarts preserve edits and renew featured work. New revisions swap a fresh demo into the same URL with existing grants, then delete retired data in yielding transactions. Interrupted seeds and cleanup resume on restart. Whole-instance exports ask for a retry while retirement cleanup is pending; active-project exports remain available. Unknown revisions and unmarked projects are refused. Seed command ids now include project identity, so an old incomplete seed made before this build cannot be resumed with the new command format.
