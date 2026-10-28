---
id: 987
category: Fixed
date: 2026-10-27
issue: https://github.com/endqwerty/mainworthy/issues/987
pr: https://github.com/endqwerty/mainworthy/pull/1037
---
The run cockpit selects, previews and advances only to work that admits your human or agent method through both the pinned case and run requirement. It says "Nothing left for you to run" when only other methods have work remaining. Slot API replies include deduplicated pinned case methods and the methods admitted by that slot's own exercise requirement. Duplicate methods remain accepted and are deduplicated for slot admission. Missing pinned versions retain case metadata and admit no methods; upgrading a stored body without a valid methods array gives it an empty method projection. New plans and case proposals normalize repeated method names before storage. Slot reads index only the first obligation matching each page ID and stop once all those IDs are resolved. Slot admission reads stored version methods without parsing case bodies. New plans and archive imports accept at most 1,024 obligations and 1,024 jobs per obligation. Archive format 46 replaces format 45; older archives must be exported again after upgrading the source instance.
