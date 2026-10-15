# 0080: Mapped CSV imports preview a create-only proposal

Date: 2026-10-15. Status: proposed.

Part of [issue #33](https://github.com/endqwerty/mainworthy/issues/33).
Decision [0047](./0047-case-imports-propose-cases-and-keep-foreign-aliases.md)
added CLI-only snapshot importers. They translate fixed columns before calling
`propose`, with no server-side mapping or preview. This slice adds a mapped
CSV operation and a file adapter. It does not complete the issue.

## Ownership and call flow

The registry owns `import-csv`, with input `CsvImportInput` and reply
`CsvImportReply`. Its CLI command and HTTP endpoint come from the registry.
The file adapter reads UTF-8 and forwards the same input.

The pure core owns CSV quoting, column mapping, execution values, and row
validation. The earlier snapshot adapters share its CSV parser and execution
mapping. The operation reads the current policy and existing aliases through
the owning modules. On confirmation it calls the existing `propose` function
once. Sealing, policy decisions, alias collisions, and witnessed case creation
remain in their existing owners. There is no SQL, migration, dependency, second
witness path, or direct case writer in the importer.

Usage has two calls:

```ts
const preview = await client.call("import-csv", { csv, mapping });
const result = await client.call("import-csv", {
	csv, mapping, confirm: preview.confirmation!, cmd: "import-file-001",
});
```

`mapCsv(text, mapping, definitions, preset?)` returns headers and per-record
bodies, folder paths, aliases, and errors. Confirmation is a content hash of
the file, mapping, preset, project, and policy version. Alias and field checks
run again inside the write transaction. A stale confirmation or any invalid
record prevents the whole import. One record is one case and one action block.

The preview creates no domain records. Because the registry declares one static
write effect per operation, a successful preview advances the project sequence
and records a command receipt if a command id is supplied. Adding conditional
write effects to the registry solely for this importer would affect every
execution path. Separate preview and confirmation command ids keep replay clear.

## Synthesis decision

Two shapes were considered. Extending `propose` with CSV input and a preview
reply would preserve the MCP tool count, but would change the contract and
meaning of a save for every client. A separate operation can return complete
row diagnostics and compose the same proposal function without changing saves.
The latter is the chosen shape.

A separate persistence model for imports was rejected. The existing transaction,
proposal, decision, and alias rules already define how cases become current.
Foreign ids are required and existing aliases are refused. Updating on identity
alone would overwrite local edits without the source having a base version.
The command id handles retries of a confirmed write, and aliases prevent a
second successful creation under another command id.

Custom field mappings require existing project definitions. Choice and required
validation reuse `fieldErrors`. Unmapped source columns are omitted. Unlike the
older snapshot importer, this operation does not retain source rows as free-text
fields or claim to reconstruct source history.

## TestRail evidence and limits

The sources were checked again on 2026-10-15:

- [TestRail's export documentation](https://support.testrail.com/hc/en-us/articles/15144643126932-Export-test-cases)
  links its [CSV sample](https://support.testrail.com/hc/article_attachments/15150901396884).
  The downloaded header states `ID`, `Title`, `Section`, `Section Depth`, `Priority`,
  `Type`, and `Steps (Expected Result)`. Its cases include `Automated` and other types.
- [TestRail's Azure DevOps migration documentation](https://support.testrail.com/hc/en-us/articles/18691410380180-Migrate-from-Azure-DevOps)
  names its step action and expected result fields and explains multiple-row layouts.

The preset reads those known columns, with optional text step and precondition
columns also recognized by the existing adapter. It reconstructs section depth,
refuses unavailable parents, and leaves unmapped fields out. An empty parent
without a source row cannot be recovered. Preview folder paths must be checked.
This operation refuses continuation records rather than silently combining them.
The earlier vendor importer remains available for that layout.

## Remaining work and checks

The mapped web dialog is deferred. The MCP surface already exposes its maximum
ten tools, and its token budget is full. This operation has `mcp: null` to
preserve both enforced limits. Exposing it to MCP needs a decision about fitting
it into an existing tool or replacing one. Neither limit was raised.

Regression tests exercise the real registry, a generated executable CLI call,
the file adapter, and HTTP. They cover preview-only behavior, confirmation,
field definitions, malformed records, alias refusals, retries, policy review,
and all 2,000 generated cases and aliases. The parent integration run owns the
whole check, test timing refresh, and independent verification.
