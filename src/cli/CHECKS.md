# CLI completion checks

Written before implementation. All commands run against a real `start()` instance
on an ephemeral port and a separate temporary data directory per test.

- A JUnit upload names one new failure cause and exits 0. The gate exits 2.
  Answering its evidence through the generated `decide` command makes the gate
  exit 0 without another upload.
- A repeated upload prints the same receipt and a nothing-written note. Stored
  result and batch counts stay unchanged.
- Outside a Git checkout with no CI commit, an upload exits 4 and names the
  missing commit, `--commit`, and `--session`. An explicit session works.
- A CI token can report and cannot decide. Project selection, environment and
  command-line precedence, multiple projects, connection errors, and operation
  errors have actionable output and exit 4.
- Switching to standard records a policy proposal and decision. The table names
  the standard clauses and who answers them.
- Outline stdin creates a case. `get --md` and `fmt` preserve its canonical text,
  while invalid Markdown reports source line numbers and exits 4.
- Suite checks exit 0 without problems and 1 with problems grouped by rule.
- Plain and gzip exports import into a second fresh instance with equal cases.
  Both HTTP archive routes require admin. Invalid archives leave the target
  unchanged. Streams clean up temporary files on completion and cancellation.
- Every registry operation appears in command help, including union-schema
  fields. Generated flags handle numbers, booleans and repeated string arrays.
- Startup prints the quickstart lines and stops on SIGTERM. MCP stdio emits
  only protocol output.

Required commands:

```sh
bun test src/cli src/surfaces/archive.test.ts
bunx tsc --noEmit
bunx biome check src/cli src/surfaces/archive.ts src/surfaces/archive.test.ts
```

The coordinating agent owns repository documentation, commits, publishing,
integration and the independent verdict on the integrated change. This worker
edits only the paths in its implementation brief.
