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

Implementation notes for integration:

- All 15 registry operations have generated input/help. Shared names also have
  human adapters. A JSON payload selects the operation form, while bare `--json`
  selects adapter output. `get --refs` selects generated flags.
- Export and import spool to mode-0600 temporary files because the transfer
  callbacks/iterators are synchronous. HTTP and gzip streams use backpressure;
  neither client nor server retains the entire archive. Scratch files are
  removed on completion, cancellation, and errors. Export uses `app.reader`;
  import enters `app.gate` before changing data.
- Import rechecks the current admin grant inside the writer gate after upload.
  A revoked token cannot complete an upload that started while it was valid.
  The regression first failed with HTTP 200; after the fix it returns 403 and
  leaves cases and bootstrap rows unchanged.
- `start()` creates scratch, but `importArchive()` requires no projects. The
  route removes only the untouched bootstrap project inside the same savepoint
  as import. Existing user data is refused. A failed import restores the
  project and tokens; success warns that the previous session may disappear.
- Local `fmt` needs no running server. The Markdown contract defines this as a
  parser/printer operation; it does not write stored data.
- The server's updated session endpoint lists projects for producer tokens.
  CI reporting now works with only the token, without a project flag when the
  instance contains one project. Scoped-admin policy changes use the inbox's
  `you` field, rather than instance capabilities.
- Startup checks request the real UI, archive route and MCP route and exercise
  both SIGINT and SIGTERM. Bun's UI bundle timing diagnostic can appear on
  stderr after a page request; startup stdout stays at two lines in local mode,
  or three when a server owner token is first generated.
- No dependency, changelog, decision record or Git state was changed by this
  worker. The coordinating agent owns those files and final worktree release
  while other workers are using the shared dependency installation.

The full CLI/archive suite contains 31 independent checks. A startup check can
fail while a web module is still being authored in this shared checkout. Do not
replace or weaken the UI check to hide that integration failure.
