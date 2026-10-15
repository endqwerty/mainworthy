# 0047: Case imports propose cases and keep foreign aliases

Date: 2026-10-14. Status: accepted.

Issue [#33](https://github.com/endqwerty/mainworthy/issues/33) asks for TestRail,
Qase and spreadsheet importers, preserving foreign ids, execution type and any
available history. The first slice imports case snapshots from CSV.

## Where it belongs

`mainworthy import file.csv --format testrail` translates records into create
edits and calls the registry's `propose` operation once. The adapter for a
Mainworthy archive continues to work without a format flag. A second operation
with its own import persistence would duplicate case creation and policy handling.
Translation keeps the existing transaction, capabilities, policy and witness rules.
There is no new MCP tool, HTTP route, database migration, or dependency.

The parser is in `src/surfaces/formats/cases.ts`. It produces
`Extract<Edit, { op: "create" }>[]` without I/O. The CLI reads the file, chooses
the parser, then calls `propose`. The suite module owns alias validation against
stored cases and writes `cases.aliases` and `case_aliases` only during witnessed
adoption. It checks collisions during sealing and again during adoption, since
another pending proposal may have used an alias in the meantime. A collision
rolls back the complete write. Aliases never shadow native refs or bare case numbers.

## Formats checked

The implementation was based on published documentation and downloaded examples
on 2026-10-14, rather than the hypotheses in `docs/competitors.md`:

- [TestRail export documentation](https://support.testrail.com/hc/en-us/articles/15144643126932-Export-test-cases)
  links a real [reference.csv](https://support.testrail.com/hc/article_attachments/15150901396884).
  The sample has 82 cases, ids such as `C3863`, `Title`, `Section`, `Section Depth`,
  dates, `References`, `Type` including `Automated`, and `Steps (Expected Result)`.
  Its step cells are empty. The documented separate-row option and
  [field mapping for separated steps](https://support.testrail.com/hc/en-us/articles/18691410380180-Migrate-from-Azure-DevOps)
  establish the `Steps (Step)` and `Steps (Expected Result)` pairing. Synthetic
  fixtures check continuation rows; a populated real TestRail step export was not obtained.
- [Qase's step-format documentation](https://docs.qase.io/en/articles/14441496-qase-csv-adding-test-steps)
  links [v1](https://drive.google.com/file/d/1oc01pmMZ5fnP_bCEBRGT52TjnOr2tbzj/view)
  and [v2](https://drive.google.com/file/d/1QGcRpFcoQk8tJnObh_u7E-gRVjhsJi9c/view)
  CSV examples. Both were downloaded and inspected. They establish `id` versus
  `v2.id`, suite rows, `steps_actions`, the singular `steps_result`, `steps_data`,
  numbered lines, tab-indented children, JSON string encoding in v2 classic
  steps, and unquoted numbered Gherkin actions. All five cases of the v2 example
  parse. The v1 example's rich multiline step content is ambiguous and refused;
  simple v1 numbered steps are supported. Qase itself recommends v2 for these exports.
- [Qase's property documentation](https://docs.qase.io/en/articles/14423241-qase-csv-test-case-properties)
  supplies the automation slugs. `automated` becomes `auto` with no outstanding
  automation intent, `to-be-automated` becomes `human` with `wanted`, and
  `is-not-automated` becomes `human` with `none`.
- Spreadsheet CSV uses [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180) quoting
  and the explicit column contract in the [data guide](../guide/data.md).
  Those columns are Mainworthy's own format, not a claim about another vendor.

No authenticated customer account or customer export was used. The checked samples
are case snapshots and have no revision stream. Native source history reconstruction,
run/result migration, XML, JSON, XLSX and attachments remain later slices of the issue.

## What is retained

TestRail ids remain aliases directly. Qase exports have numeric ids; the source
project prefix supplied with `--case-prefix` creates aliases such as `PAY-123`,
with `QASE` as the explicit default. This avoids collision with native bare-number
lookup. Importers create cases only, and refuse existing aliases rather than update
or overwrite another import. Files without ids can be imported, but cannot detect
repeated creation by foreign identity.

Every original case row is JSON in the imported body's `fields`, including dates,
descriptions, hierarchy, custom fields and any history column. Recognized fields
also become native case content. This preserves source text without treating
foreign dates, authors or results as native decisions or evidence. New cases begin
at version 1, attributed to the importing actor at import time. There is no claim
that source history has been replayed.

A file is at most 32 MB and 5,000 cases. Parsing finishes before the network request;
one proposal either adopts all cases, waits for policy review, or writes no cases.
An unknown execution value is an error. Unrecognized source columns and invalid
native tags stay in the retained source row. Hierarchical Qase steps become flat
steps with their child paths in the action. Folder names containing `/` are refused
because `/` has structural meaning in Mainworthy paths.

## Checks

The executable CLI imports 2,000 synthetic cases and reads all of them back by
foreign alias over HTTP. Parser tests cover checked headers and encodings, source
metadata retention, malformed quoting, Unicode, nested sections and suites,
execution mapping and import limits. Registry tests check witnessed aliases,
idempotency, transaction rollback and competing pending proposals under strict policy.
The parent integration run owns the whole check, timing refresh and independent verdict.
