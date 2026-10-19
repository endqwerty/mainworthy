# 0105: Give merge conflicts structured addresses

- Date: 2026-10-18
- Status: proposed

A step may have the id `order`. The former string address `steps.order` named both a conflict about that
step and a conflict about the order of all steps. Choosing current could therefore leave a deleted step
absent or retain the draft's fragment pin instead of the current pin. [Issue #370](https://github.com/endqwerty/mainworthy/issues/370)
records both cases.

`ConflictAddress` in `src/core/model.ts` names each kind of overlap with a tagged value:

- `field` carries one of `title`, `pre`, `methods` or `automate` as its `name`.
- `step` carries the step's `id`, including for a fragment pin or a deletion against an edit.
- `step-field` carries the step's `id` and either `action` or `expected` as its `name`.
- `step-order` names the order of the steps and carries no id.
- `custom-field` carries the complete field `key`, including any dots.

`mergeBodies` produces these addresses and `applyMergeChoice` applies them. Display labels do not identify
choices. The web card, saved drafts and their recovery, queue proposal display, proposal replies and
question evidence all use the same address shape. The iPhone contract checks that shape, and its native
resolver holds typed addresses while passing choices to the shared JavaScriptCore bundle. Native case
content retains fragment pins through that exchange.

This revisits the address representation in decision 0058. Its shared merge implementation, neighbour
insertion rule and precedence of an explicitly chosen order remain. We rejected escaped string paths
because they would retain a parser and require every consumer to obey its escaping rules. The tagged
union separates step identity from ordering directly. All consumers change together and the string
parsers are deleted.

The JSON format changes in stored proposals, recorded command replies and saved browser conflict drafts.
Migration 31 rewrites proposal conflicts and recorded propose replies in SQL. It distinguishes the former
`steps.order` meanings by the conflict values. Three arrays of ids name step order. Step objects or an
omitted deleted side name the step `order`. Receipts did not keep those values, so their addresses come
from the matching proposal's conflicts in their original order. This preserves two conflicts that had the
same string path in one proposal. Command ids, request hashes and sequence numbers stay unchanged.

The migration changes exported data, so it raises the archive version. Import refuses older archives
through the existing version check. Upgrade their original database and export again. Historical question
evidence is hashed and remains unchanged. Its readers already tolerate unknown evidence. Older browser
conflict drafts are still dropped. Conflict reply values are optional because JSON omits a deleted side.

Registry regressions read the stored proposal, choose current and check the saved step or pin version.
The shared browser and Swift scenarios include restoration of a deleted step named `order`. Property
generators now produce that id and fragment pins, and a merge-choice property checks that choosing the
surviving step preserves its edit or pin.
