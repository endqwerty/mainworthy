# 0049. Edit policy clauses through the existing decision

Date: 2026-10-14. Implements [issue #45](https://github.com/endqwerty/mainworthy/issues/45).

## Context

Settings already changes presets and the choice for tests with no case through a proposal and an accepting decision. The full clause table is available through `admin`, `policy.show`, to an instance admin. It was read-only in the UI.

## Decision

A separate Settings component owns the editable clause draft. Its raw text keeps invalid conditions and JSON editable. It derives a validated policy with the core schemas, then uses the same totality and case-creation checks as the server. Clauses can be added, removed, and reordered. Settings also edits the hold settings and evidence basis, while retaining the existing preset and tests-with-no-case controls.

Applying uses the existing Settings `propose`, `get`, and `decide` sequence. Only a person with project `admin` and `produce` can use automatic acceptance in Settings. Editing the full clause list additionally needs the existing instance admin read permission. No operation, SQL writer, or witness path is added. The decision handler remains the only way to put the policy in force.

Preview reads up to 20 open and 20 recently settled questions through `inbox`. It matches their current facts and applicable answer choices with the shared core matcher, showing the clause, who may answer, rule answers, and which runs list the question. It compares with the policy read when editing began. It does not replay recorded decisions, execute rules, or predict a gate result.

A policy proposal records the version it was made on in its resolved edit. Sealing refuses a stale explicit base. Adoption checks the base again inside the decision transaction, so simultaneous saves and proposals that wait for another admin cannot silently replace an intervening change. A conflict leaves the proposal open and rolls back every effect of adoption.

Edits carrying clauses or settings must send `base`, the version returned by `policy.show`. These fields replace entire values and cannot safely infer the version a caller read. Preset switches and changes to `unlinked` can omit `base`: they express an action against the current policy, and sealing records that version. Older waiting proposals without a recorded base conflict on acceptance and must be proposed again.

The clause editor keeps its opened version and sends it with Apply. The custom field editor preserves the other settings from its browser read and sends that policy version as its base. Both proposal and adoption conflicts keep its field draft. Event-driven policy reads show a notice if that version changes, including while previewing. A conflict keeps the draft open. Fields disabled in the editor, including answers on clauses answered by people, round-trip unchanged.

## Alternatives

A server preview operation could fetch the sample and return matches. Existing reads already expose the facts, and matching is pure core code used in both browser and server. Keeping preview in the browser avoids another operation and leaves the MCP tool budget unchanged.

A JSON-only editor would expose the same model with less UI code. The editable table keeps each clause's fields and order visible and gives invalid text a place to remain while it is corrected. Rule answers remain JSON because their payload depends on the question kind.

## Limits

The preview is a bounded sample, not an evaluation of every question or historical outcome. Drafts live in the open Settings component and are discarded on cancel, reload, or leaving Settings. A failed request keeps the draft while the editor remains open. Project admins without instance admin can switch presets but cannot read or edit the full clause table.
