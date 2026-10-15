# 0052: Custom field definitions belong to the versioned project policy

- Date: 2026-10-14
- Status: proposed
- Issue: [Shared steps and custom fields](https://github.com/endqwerty/mainworthy/issues/54)

## Existing behavior

`CaseBody.fields` already stores arbitrary string values. Canonical Markdown reads and prints them, and `cleanBody` preserves them when a partial edit omits `fields`. Case bodies and their versions already travel in archives. The old model comment that fields were always empty was wrong.

`propose` seals content, and policy determines who adopts it. `adopt` requires a decision witness before it writes a case head. Policy settings already have the same proposal, decision, history, and archive ownership through `policies`.

## Alternatives

A separate field-definition table and operations would separate project metadata from policy settings. It would also require another history, migration, read contract, and witness-backed writer for this slice.

A `fields` map in policy settings uses the existing administrative proposal and decision. The definition is a constraint on future content, which fits that setting. This is the chosen design. No migration changes the existing value storage. Existing settings without definitions remain valid.

## Types and ownership

The pure case model defines `FieldDefinitions`, a map of keys to a discriminated union. Both variants have a label and required flag. `text` admits any string; `choice` carries a nonempty list of unique nonblank choices. `fieldErrors(values, definitions)` returns validation messages without I/O.

`PolicySettings.fields` is optional. The policy module owns its storage and keeps definitions when a preset changes. An explicit replacement settings object can remove them. Settings reads the existing policy operation and sends definition changes through `propose` and `decide`, using the same path as a preset change. Its form checks duplicate keys before constructing the map and refuses to overwrite definitions that changed while the form was open.

The suite validates creates, edits, and restores when sealing, against the batch's final policy. At adoption it validates the actual content after any merge, against the current policy or the policy adopted in the same batch. This prevents a pending content proposal from bypassing definitions introduced while it waited. A failure rolls the transaction back. Placement edits do not change content and do not require new field values.

## Meaning of a definition change

Definitions never rewrite old content. Old versions and existing heads remain readable even if a later definition would refuse their values. A future content change must meet the definitions. Missing or blank values satisfy optional fields, and choice values compare exactly. Undefined keys remain free text. Removing a definition preserves all stored values.

Required fields cannot coexist with automatic creation for tests with no case. That rule creates a case without field values; allowing the combination would make report processing fail. Optional fields work with it. Manual case creation supplies required values through Markdown or a content proposal.

Definitions are editable in the web Settings form and through CLI and HTTP operations. The case editors still preserve field values without editing them. This slice does not implement fragments, pinned references, or consumer batch updates.

## MCP budget

The tools/list budget is full. Optional input properties marked `x-mcp-hidden` are omitted from the advertised MCP schema. Field definitions use that marker; HTTP and CLI validation keep the complete registry schema. Existing MCP definitions and their measured token counts stay unchanged. This is a discovery limit, and definition editing is documented for Settings, CLI, and HTTP.

## Checks

Policy operation tests cover administrative acceptance, required and choice validation, unchanged unknown values, preset changes, validation of pending proposals, restores, batch edit order, and project isolation. Real archive replay compares policy history, all case versions, proposals, and decisions. The Settings browser test adds a required choice field, saves it through a decision, and refuses duplicate choices without changing the stored definition. Existing MCP tests retain their exact counts and total budget.
