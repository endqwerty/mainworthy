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

Starts of the command: `cli` in `test-support.ts` starts it as a process (about 0.13 s). `run` calls `runCli`
in the test's process, with the environment, working directory and standard input a child would have while the
command runs, and returns what it wrote through `process.stdout.write` and `process.stderr.write` until it
ended. A test uses `cli` for what only the executable does (its exit status, its start, signals, `serve`,
`mcp`) and `run` for what the command does with its input.

What `run` cannot give as a process does, and what stands in for each:

- **Other ways to write.** `run` reads the two write functions only, so a test keeps the terminal behind them. In
  `src/cli` only `output.ts` and `errors.ts` name the process's
  streams. Nothing names `console`, Bun's streams, a device file, a write to a descriptor or a child that
  inherits the streams, and only `target.ts` starts a process (git, with its output piped). The test reads the
  source as text: a comment that names one of these fails it, and a way it does not list, such as a
  dependency that logs, passes it. `run` is a sample of the executable. The tests that start it are the proof
  of its output.
- **Output after the command ended.** A command that ends well, run as a process, prints such output before
  the process exits. Here the answer has gone back by then. The two write functions stay watched until the
  next command of the test or the end of its instance, and a write seen in that time fails there. A write
  later than that is not seen, and one that lands while a later command runs is taken for that command's.
- **Stopping a command.** A child that runs out of its ten seconds is killed. A command in the process cannot
  be: its run is refused, and so is every run after it until it has ended. A test that runs out of Bun's five
  seconds while its command still runs fails, and the tests after it in the file wait for that command, so
  they can fail for its reason. Each test file has its own copy of this state under `bun test --parallel`,
  which is how the check runs.
- **The server.** The test's server is in the same process and sees the command's environment and directory
  while it runs. It reads its configuration at start. A test whose server must read either during a command
  uses `cli`.

One test holds the two to the same answers for twelve argument vectors: each exit code, standard input, a CI
environment, a file named from another working directory. It is a sample, not every command.

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
- `archiveRoutes` accepts an optional owner reference from `start`'s callback.
  Local imports bootstrap the configured machine owner and refresh that live
  reference before another write, preserving attribution when the archive came
  from a different owner. Server imports say to set `MAINWORTHY_OWNER_TOKEN` and
  restart, since replay intentionally discards credentials.
- Typed client calls validate replies against schemas checked against `Api`.
  No casts remain. Generated commands print every batch outcome even when one
  item is refused, then exit 4. Human adapters reject operation-only flags rather
  than silently dropping them.
- Downloads write a private temporary file beside the destination and rename
  only after completion, preserving an existing backup when a stream fails.
  Gzip source failures are archive errors, not connection failures. Startup
  failures exit immediately with code 4, including an occupied port.
- Export requires an NDJSON content type before opening a destination. A proxy
  login page cannot replace an existing backup. Flags beside a JSON payload are
  rejected instead of discarded. A closed stdout is quiet, and the source entry
  is executable through its shebang.
- EPIPE is swallowed without exiting early. A gate still returns 0/1/2/3 after
  a reader that reads nothing (`| true`) closes its pipe. The regression first returned 0 for a pending gate
  and now checks every verdict with a closed stdout. Declined warnings appear
  once, and per-project session capabilities are validated and preserved.
- Cancellation of a valid gzip upload by an early 401/403 response is not a
  decompression failure. Cancellation is tracked, and a non-OK server envelope
  takes precedence. The multi-megabyte valid-backup test failed before with
  "invalid gzip archive" and now checks unauthenticated/forbidden messages.
- The updated report contract's `declined` case/version claims stay visible in
  the receipt; their results remain recorded and failing outcomes still block.
  Older cached receipts default that new field to an empty list. JSON payloads
  can start with whitespace or newlines.
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

The full CLI/archive suite contains 48 independent checks. A startup check can
fail while a web module is still being authored in this shared checkout. Do not
replace or weaken the UI check to hide that integration failure.

Verification rerun after the first independent review:

```text
bun test src/cli src/surfaces/archive.test.ts: 48 pass, 0 fail
bunx tsc --noEmit: exit 0
bunx biome check src/cli src/surfaces/archive.ts src/surfaces/archive.test.ts: clean
```

The independent verifier was Anthropic Claude Opus 5.5. Its first round proved the
archive permission, rollback, nonfresh-target and cancellation checks, and
found the occupied-port blocker and smaller CLI issues. Those findings have
regressions and fixes. The second round passed the 40-check snapshot and proved
a valid 720 MB plain/gzip HTTP import and identical re-exported rows. Its three
new nonblocking findings have fixes and additional regression checks.
The third round caught the gate-pipe exit race and a duplicated declined
warning. The fourth confirmed both fixes and caught the early gzip refusal
race. Those findings have failing-before regressions and fixes. The fifth
round passed the current 48-check snapshot, with 330 assertions, clean global
TypeScript, and clean Biome checks on all 31 owned TypeScript files.

Final independent verdict: **pass**, Anthropic Claude Opus 5.5
(`claude-opus-5-5`), 2026-10-12. The reviewed scoped manifest was
`f36d39afc01aca80965a1308df5e28222cb99b1b7d49159569ef3674e1fd96a1`,
unchanged throughout the review, on shared HEAD
`f44108ad663481986064f6fdf6b2c69b303a4466`. This verification record was
added afterwards; all source, test and fixture bytes remain unchanged, with
their Markdown-excluding manifest at
`44bc3a9a89901d2ce03238c997e8d006d6f92da0ed526aab60e93cd15ad68f7a`.

The last round independently exercised 144 authentication refusals of valid
gzip archives, including 147 MB of uncompressed data, without mislabeling them
as corruption. It exercised 66 owner uploads of damaged gzip archives, verified
unchanged databases and no leftover spool files, and successfully imported
the valid 147 MB archive. All 240 gate runs through closed pipes retained their
verdict's exit code. Reviewers stopped their servers and removed their scratch.

Known limits: export validates the response content type but does not validate
the NDJSON footer before saving; import validates the archive. Streaming
memory is bounded by the largest individual row rather than the whole file.
Existing owner tokens alone do not make an untouched bootstrap target nonfresh;
successful import discards credentials as the reply warns. The last round
reused the earlier 720 MB, identical-row round trip and mid-upload revocation
results; those paths were unchanged.

Use `LC_ALL=C sort` when hashing the file list; different provider locales
sort CHECKS.md differently and otherwise produce different manifest digests.
