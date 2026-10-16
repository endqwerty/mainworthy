# Import cases from CSV

Preview a CSV file, map its columns to case content and project fields, then
confirm one import.

Use `mainworthy import-csv` or the same `import-csv` operation through HTTP.
You need `produce` on the project. The web app does not yet have a mapped CSV
import dialog. This operation is not an MCP tool.

## Preview the file

The file can contain up to 5,000 cases and 8 MiB. Each record is one case. Quoted cells can contain commas,
doubled quotes, and line breaks. A multiline steps cell becomes one action block.

To preview the import, follow these steps.

1. Save the file as UTF-8 CSV with a header row.
2. Give every case a foreign id and a title.
3. Map the destination names to your CSV column headers.
4. Run `mainworthy import-csv` with that mapping.

For a file with `Source ID`, `Name`, `Action`, `Result`, and `Path` headers, use this command:

```sh
mainworthy import-csv cases.csv --project checkout \
	--mapping '{"id":"Source ID","title":"Name","steps":"Action","expected":"Result","folder":"Path"}' \
	--json
```

The reply shows each record's alias, folder, mapped case body, and refusal reasons.
`create` counts valid records and `refused` counts invalid records. A refused
record has a null body. The preview creates no cases, folders, proposals, or decisions.
The request still advances the project sequence, and a supplied
`cmd` records its preview receipt like other write operations.

Fix every refused record before importing. If any record is refused,
`confirmation` is null and the entire import is blocked. CSV quoting errors,
missing mapped columns, empty files, and invalid headers reject the request.

## Map project fields

Optional mapping keys are `pre`, `steps`, `expected`, `folder`, and `execution`.
An absent or empty folder becomes `Unsorted`. Folder values are paths such as
`Checkout/Coupons`. A title must contain 1 to 300 characters.
An expected result without a step action is refused.

Use `fields` to map your project's custom field keys to source columns:

```json
{"id":"ID","title":"Title","fields":{"priority":"Priority","risk":"Risk notes"}}
```

Create the field definitions in **Settings**, **Fields** before importing.
The importer refuses a record with a missing definition, an invalid choice, or a missing required value.
The importer does not add definitions or invent priority values.
The importer ignores columns you do not map, including source history and dates.

The execution values `manual` and `human` select the `human` method.
`automated` and `auto` select `auto`. `to-be-automated` selects `human` with
`wanted` intent. The value `wanted` has the same effect.
`not-applicable` selects `human` with `not-applicable` intent.
An empty value, `none`, or `is-not-automated` selects `human` with no automation intent.
The importer refuses unknown values.

## Confirm the reviewed import

To confirm the import, follow these steps.

1. Review the full preview reply.
2. Choose a new command id for the confirmed request.
3. Repeat the same file and mapping with the returned `confirmation` value and the new command id.

For example, use this command:

```sh
mainworthy import-csv cases.csv --project checkout \
	--mapping '{"id":"Source ID","title":"Name","steps":"Action","expected":"Result","folder":"Path"}' \
	--confirm 012345abcdef --cmd import-checkout-001 --json
```

Replace `012345abcdef` with the value your preview returned. A changed file,
mapping, preset, or policy requires another preview. The server checks aliases
and field values again inside the confirmed transaction.

Confirmation proposes all cases together in one recorded write. The project's
[policy](./policy.md) decides whether to adopt the proposal immediately or
ask for acceptance in the queue. Check `proposal.status`, `proposal.question`,
and `proposal.needs`. An open proposal has created no cases yet.

A foreign id becomes a case alias, so `mainworthy get C1234` and tests annotated
with `@C1234` resolve the imported case. Aliases follow the rules in
[Your data](./data.md). Existing aliases and duplicate ids within the file are
refused. Reimporting never updates a case or creates a duplicate with that alias.
Changes made in Mainworthy after the first import remain intact.

If a confirmed request loses its reply, retry the same input and `cmd` to receive
its recorded receipt. Reusing that id with different input is a conflict. Use
separate ids for the preview and the confirmed import.

The file command exits 2 for refused records or a proposal waiting for
acceptance, with or without `--json`. The generated `--json '<input JSON>'` operation form
prints the full reply. Check its `refused` count and `proposal.status` yourself.

## Use the TestRail preset

TestRail's [export documentation](https://support.testrail.com/hc/en-us/articles/15144643126932-Export-test-cases)
links a CSV sample with `ID`, `Title`, `Section`, `Section Depth`, `Type`, and
`Steps (Expected Result)` headers. Preview that format with:

```sh
mainworthy import-csv testrail.csv --preset testrail --json
```

The preset reads the optional step, expected result, and precondition columns
when present. `Automation Type` takes precedence over `Type`. `Type` equal to
`Automated` or `Manual` selects its execution method. Other testing types keep
`human`. Supply a complete `--mapping` with the preset to select custom fields
such as priority. Without a custom mapping, priority and other extra columns
are ignored.

`Section Depth` reconstructs nested paths in source order. Each parent section needs a row.
The export cannot name an empty parent that has no case row.
Before confirming, inspect the preview's folder paths.

This preset accepts one record per case. Separate-row steps are refused as
missing or duplicate ids. For the existing importer that joins TestRail's
separate-row steps and retains every source row, see
[case snapshots in Your data](./data.md). That importer has no mapped dry run.

## Call the operation directly

To import through HTTP, follow these steps.

1. Send `POST /api/p/<project>/import-csv` with the file text in `csv` and no `confirm` value.
   Include the column mapping in `mapping`, or use `preset: "testrail"`.
2. Review the dry-run reply.
3. Send the same input with the returned confirmation in `confirm`.

The generated CLI form is `mainworthy import-csv --json '<input JSON>'`.
See the [API reference](./api.md) for authentication and reply envelopes.
