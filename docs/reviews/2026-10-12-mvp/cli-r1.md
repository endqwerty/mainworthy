# CLI and workflow QA review

Revision: `46a58d99a306d7b5630107c5a29661c7337be0da`, compared with `f5146c43142dc0905c1c67424a7d0339948ed371`.
Reviewer: Codex, GPT-6 Astra. This is a fresh review session; provider independence from the author must be assessed by the coordinating agent.

All work is in the requested clean archive under `cli-r1/tree`. No shared checkout edits or cleanup. Bun 1.4.3. `bun install --frozen-lockfile` passed, 117 packages installed.

## Checks planned before running

- Read all four changed files and relevant callers. Check environment fallback, explicit flags, and server-mode authentication.
- Run each of health, inbox, report and gate with each variable absent, empty and populated, then check overriding flags and explicit empty flags.
- Remove each fix independently in the export and run the new regression test, restoring the source after each run.
- Run passing and failing workflow sequences with empty environment settings and GitHub pull-request metadata.
- Run CLI tests, TypeScript and Biome. Retain commands, outputs and exit codes.

Safety fact: empty environment settings must select the same behavior as absent settings, without permitting unauthenticated application operations in server mode. Explicit `--url ""` must still fail validation.

## a. Scope review: pass

`git diff f5146c4 46a58d9` changes only `.github/workflows/check.yml`, `src/cli/client.ts`, `src/cli/commands/health.ts`, and `src/cli/main.test.ts`. The workflow adds `mkdir -p test-results`; client environment defaults change from nullish to truthy fallback while flags retain nullish precedence; health adds an empty-port fallback; one regression test is added. No operation, server authentication, or gate logic changes.

Port restriction: all listeners started by this review use ports 8900–8949. The built-in default is 7357. Successful workflow checks therefore use `--url http://127.0.0.1:<reserved port>` for report and gate, with all three MAINWORTHY environment settings still empty. Literal unmodified workflow startup on port 7357 is outside the allowed ports and is not claimed as tested.

## Results in progress

## b. Real CLI matrix

Full commands, environment differences, stdout, stderr and exit codes are in `matrix.json`. GitHub metadata used in every command identifies PR 75 and revision 46a58d9 in a synthetic qa/mainworthy repository; no remote service is contacted. Local/server listeners used 8900/8901.

| Case | Exit | Output |
| --- | --- | --- |
| MAINWORTHY_URL absent: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_URL absent: inbox | 4 | connection: cannot connect to http://127.0.0.1:7357; start the server with mainworthy serve |
| MAINWORTHY_URL absent: report | 4 | connection: cannot connect to http://127.0.0.1:7357; start the server with mainworthy serve |
| MAINWORTHY_URL absent: gate | 4 | connection: cannot connect to http://127.0.0.1:7357; start the server with mainworthy serve |
| MAINWORTHY_URL empty: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_URL empty: inbox | 4 | connection: cannot connect to http://127.0.0.1:7357; start the server with mainworthy serve |
| MAINWORTHY_URL empty: report | 4 | connection: cannot connect to http://127.0.0.1:7357; start the server with mainworthy serve |
| MAINWORTHY_URL empty: gate | 4 | connection: cannot connect to http://127.0.0.1:7357; start the server with mainworthy serve |
| MAINWORTHY_URL set: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_URL set: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| MAINWORTHY_URL set: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven |
| MAINWORTHY_URL set: gate | 0 | mainworthy gate    passed: 1 result proven |
| MAINWORTHY_TOKEN absent: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_TOKEN absent: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| MAINWORTHY_TOKEN absent: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| MAINWORTHY_TOKEN absent: gate | 0 | mainworthy gate    passed: 1 result proven |
| MAINWORTHY_TOKEN empty: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_TOKEN empty: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| MAINWORTHY_TOKEN empty: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| MAINWORTHY_TOKEN empty: gate | 0 | mainworthy gate    passed: 1 result proven |
| MAINWORTHY_TOKEN set: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_TOKEN set: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| MAINWORTHY_TOKEN set: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 2 results proven |
| MAINWORTHY_TOKEN set: gate | 0 | mainworthy gate    passed: 2 results proven |
| MAINWORTHY_PROJECT absent: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_PROJECT absent: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| MAINWORTHY_PROJECT absent: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| MAINWORTHY_PROJECT absent: gate | 0 | mainworthy gate    passed: 2 results proven |
| MAINWORTHY_PROJECT empty: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_PROJECT empty: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| MAINWORTHY_PROJECT empty: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| MAINWORTHY_PROJECT empty: gate | 0 | mainworthy gate    passed: 2 results proven |
| MAINWORTHY_PROJECT set: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_PROJECT set: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| MAINWORTHY_PROJECT set: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| MAINWORTHY_PROJECT set: gate | 0 | mainworthy gate    passed: 2 results proven |
| MAINWORTHY_PORT absent: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_PORT absent: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| MAINWORTHY_PORT absent: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| MAINWORTHY_PORT absent: gate | 0 | mainworthy gate    passed: 2 results proven |
| MAINWORTHY_PORT empty: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_PORT empty: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| MAINWORTHY_PORT empty: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| MAINWORTHY_PORT empty: gate | 0 | mainworthy gate    passed: 2 results proven |
| MAINWORTHY_PORT set: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| MAINWORTHY_PORT set: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| MAINWORTHY_PORT set: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| MAINWORTHY_PORT set: gate | 0 | mainworthy gate    passed: 2 results proven |
| URL None with flag: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| URL None with flag: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| URL None with flag: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| URL None with flag: gate | 0 | mainworthy gate    passed: 2 results proven |
| URL '' with flag: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| URL '' with flag: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| URL '' with flag: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| URL '' with flag: gate | 0 | mainworthy gate    passed: 2 results proven |
| override MAINWORTHY_URL empty: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| override MAINWORTHY_URL empty: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| override MAINWORTHY_URL empty: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| override MAINWORTHY_URL empty: gate | 0 | mainworthy gate    passed: 2 results proven |
| override MAINWORTHY_URL nonempty: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| override MAINWORTHY_URL nonempty: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| override MAINWORTHY_URL nonempty: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| override MAINWORTHY_URL nonempty: gate | 0 | mainworthy gate    passed: 2 results proven |
| override MAINWORTHY_TOKEN empty: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| override MAINWORTHY_TOKEN empty: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| override MAINWORTHY_TOKEN empty: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 2 results proven /   already received; nothing was written |
| override MAINWORTHY_TOKEN empty: gate | 0 | mainworthy gate    passed: 2 results proven |
| override MAINWORTHY_TOKEN nonempty: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| override MAINWORTHY_TOKEN nonempty: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| override MAINWORTHY_TOKEN nonempty: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 2 results proven /   already received; nothing was written |
| override MAINWORTHY_TOKEN nonempty: gate | 0 | mainworthy gate    passed: 2 results proven |
| override MAINWORTHY_PROJECT empty: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| override MAINWORTHY_PROJECT empty: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| override MAINWORTHY_PROJECT empty: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| override MAINWORTHY_PROJECT empty: gate | 0 | mainworthy gate    passed: 2 results proven |
| override MAINWORTHY_PROJECT nonempty: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| override MAINWORTHY_PROJECT nonempty: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| override MAINWORTHY_PROJECT nonempty: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| override MAINWORTHY_PROJECT nonempty: gate | 0 | mainworthy gate    passed: 2 results proven |
| explicit empty --url: health | 4 | invalid: --url must be an HTTP or HTTPS URL |
| explicit empty --url: inbox | 4 | invalid: --url must be an HTTP or HTTPS URL |
| explicit empty --url: report | 4 | invalid: --url must be an HTTP or HTTPS URL |
| explicit empty --url: gate | 4 | invalid: --url must be an HTTP or HTTPS URL |
| explicit empty --token: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| explicit empty --token: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| explicit empty --token: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| explicit empty --token: gate | 0 | mainworthy gate    passed: 2 results proven |
| explicit empty --project: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8900 |
| explicit empty --project: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| explicit empty --project: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven /   already received; nothing was written |
| explicit empty --project: gate | 0 | mainworthy gate    passed: 2 results proven |
| server token absent: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8901 |
| server token absent: inbox | 4 | unauthenticated: a token is required |
| server token absent: report | 4 | unauthenticated: a token is required |
| server token absent: gate | 4 | unauthenticated: a token is required |
| server token empty: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8901 |
| server token empty: inbox | 4 | unauthenticated: a token is required |
| server token empty: report | 4 | unauthenticated: a token is required |
| server token empty: gate | 4 | unauthenticated: a token is required |
| server token valid: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8901 |
| server token valid: inbox | 0 | { /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / } |
| server token valid: report | 0 | mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check /   1 results   1 pass   0 fail   0 skip  (R-1) /   1 tests have no case (tracked) /   basis: unresolved 1 (tests without a case or version) / mainworthy gate    passed: 1 result proven |
| server token valid: gate | 0 | mainworthy gate    passed: 1 result proven |
| server token invalid: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8901 |
| server token invalid: inbox | 4 | unauthenticated: a token is required |
| server token invalid: report | 4 | unauthenticated: a token is required |
| server token invalid: gate | 4 | unauthenticated: a token is required |
| server empty token flag overriding valid: health | 0 | healthy: Mainworthy 0.1.0 at http://127.0.0.1:8901 |
| server empty token flag overriding valid: inbox | 4 | unauthenticated: a token is required |
| server empty token flag overriding valid: report | 4 | unauthenticated: a token is required |
| server empty token flag overriding valid: gate | 4 | unauthenticated: a token is required |

## d. Workflow reproduction: pass with port adaptation

Exact environment is in `workflow.py`; all three MAINWORTHY client settings are empty, with all requested GitHub PR variables set. The passing and failing sequences each ran install, typecheck, lint, mkdir, tests, serve, report, gate in that order. The failing sequence added one deliberately failing core test after lint and removed it after producing JUnit. Each sequence used a fresh database. Full stdout/stderr are retained in the named logs. Report and gate used `--url` for allowed ports 8902/8903.

### passing-install

`bun install --frozen-lockfile` exited 0.

```text
bun install v1.4.3 (c6da4a4d3)

Checked 120 installs across 143 packages (no changes) [3.00ms]
```

### passing-typecheck

`bun run typecheck` exited 0.

```text
$ tsc --noEmit
```

### passing-lint

`bun run lint` exited 0.

```text
Checked 133 files in 161ms. No fixes applied.
$ biome check .
```

### missing-report-directory

`bun test src/core --reporter=junit --reporter-outfile=$HOME/.cache/mainworthy-arena/verify/cli-r1/missing-directory/junit.xml` exited 0.

```text
::group::src/core/text.test.ts:
(pass) clip never leaves half of a two-unit character [0.11ms]
(pass) malformedText finds half a character anywhere in an input, and says where [0.16ms]

::endgroup::

 179 pass
 0 fail
 11869 expect() calls
Ran 179 tests across 8 files. [1.58s]
JUnitReportFailed: Failed to write JUnit report to $HOME/.cache/mainworthy-arena/verify/cli-r1/missing-directory/junit.xml
ENOENT: $HOME/.cache/mainworthy-arena/verify/cli-r1/missing-directory/junit.xml: No such file or directory (open())
```

### passing-mkdir

`mkdir -p test-results` exited 0.

```text

```

### passing-tests

`bun test src/core --reporter=junit --reporter-outfile=test-results/junit.xml` exited 0.

```text
::endgroup::

::group::src/core/text.test.ts:
(pass) clip never leaves half of a two-unit character [0.07ms]
(pass) malformedText finds half a character anywhere in an input, and says where [0.11ms]

::endgroup::

 179 pass
 0 fail
 11897 expect() calls
Ran 179 tests across 8 files. [1.63s]
```

### passing-report

`bun src/cli/main.ts report test-results/junit.xml --url http://127.0.0.1:8902` exited 0.

```text
mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check
  179 results   179 pass   0 fail   0 skip  (R-1)
  179 tests have no case (tracked)
  basis: unresolved 179 (tests without a case or version)
mainworthy gate    passed: 179 results proven
```

### passing-gate

`bun src/cli/main.ts gate --url http://127.0.0.1:8902` exited 0.

```text
mainworthy gate    passed: 179 results proven
```

### failing-install

`bun install --frozen-lockfile` exited 0.

```text
bun install v1.4.3 (c6da4a4d3)

Checked 120 installs across 143 packages (no changes) [4.00ms]
```

### failing-typecheck

`bun run typecheck` exited 0.

```text
$ tsc --noEmit
```

### failing-lint

`bun run lint` exited 0.

```text
Checked 133 files in 169ms. No fixes applied.
$ biome check .
```

### failing-mkdir

`mkdir -p test-results` exited 0.

```text

```

### failing-tests

`bun test src/core --reporter=junit --reporter-outfile=test-results/junit.xml` exited 1.

```text
::error file=src/core/reviewer-forced-failure.test.ts,line=2,col=72,title=error: expect(received).toBe(expected)::Expected: 2%0AReceived: 1%0A%0A      at <anonymous> ($HOME/.cache/mainworthy-arena/verify/cli-r1/tree/src/core/reviewer-forced-failure.test.ts:2:72)
(fail) reviewer deliberately failing workflow check [0.07ms]

::endgroup::

1 tests failed:
(fail) reviewer deliberately failing workflow check [0.07ms]

 179 pass
 1 fail
 11958 expect() calls
Ran 180 tests across 9 files. [1.75s]
```

### failing-report

`bun src/cli/main.ts report test-results/junit.xml --url http://127.0.0.1:8903` exited 0.

```text
mainworthy report  scratch @ 46a58d9  pr #75  attempt 1  job check
  180 results   179 pass   1 fail   0 skip  (R-1)
  1 new   Q-1 "expect(received).toBe(expected) | at src/core/reviewer-forced-failure.test.ts"   (1 test)
  180 tests have no case (tracked)
  basis: unresolved 180 (tests without a case or version)
mainworthy gate    blocked: 1 failure unexplained, 1 question open
```

### failing-gate

`bun src/cli/main.ts gate --url http://127.0.0.1:8903` exited 2.

```text
mainworthy gate    blocked: 1 failure unexplained, 1 question open
  Q-1 needs an answer
```


## c. Regression-test sensitivity

Ran `bun test --preload ../ports.js src/cli/main.test.ts --test-name-pattern "an empty MAINWORTHY_URL"` after restoring the original source before each mutation. The review-only preload allocates requested port 0 listeners within 8910–8948; it does not change client behavior. `TMPDIR` points inside this review directory. Restored both source files after all runs.

### current

Exit 0. Full log: `mutation-current.log`.

```text
bun test v1.4.3 (c6da4a4d3)

src/cli/main.test.ts:
(pass) an empty MAINWORTHY_URL, MAINWORTHY_TOKEN or MAINWORTHY_PROJECT is the same as none [439.93ms]

 1 pass
 33 filtered out
 0 fail
 4 expect() calls
Ran 1 test across 1 file. [552.00ms]
```
### all-removed

Exit 1. Full log: `mutation-all-removed.log`.

```text

- Expected  - 1
+ Received  + 2

      at <anonymous> ($HOME/.cache/mainworthy-arena/verify/cli-r1/tree/src/cli/main.test.ts:571:25)
      at async withInstance ($HOME/.cache/mainworthy-arena/verify/cli-r1/tree/src/cli/test-support.ts:40:16)
      at async <anonymous> ($HOME/.cache/mainworthy-arena/verify/cli-r1/tree/src/cli/main.test.ts:567:8)
(fail) an empty MAINWORTHY_URL, MAINWORTHY_TOKEN or MAINWORTHY_PROJECT is the same as none [290.56ms]

 0 pass
 33 filtered out
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [413.00ms]
```
### url-removed

Exit 1. Full log: `mutation-url-removed.log`.

```text

- Expected  - 1
+ Received  + 2

      at <anonymous> ($HOME/.cache/mainworthy-arena/verify/cli-r1/tree/src/cli/main.test.ts:571:25)
      at async withInstance ($HOME/.cache/mainworthy-arena/verify/cli-r1/tree/src/cli/test-support.ts:40:16)
      at async <anonymous> ($HOME/.cache/mainworthy-arena/verify/cli-r1/tree/src/cli/main.test.ts:567:8)
(fail) an empty MAINWORTHY_URL, MAINWORTHY_TOKEN or MAINWORTHY_PROJECT is the same as none [275.56ms]

 0 pass
 33 filtered out
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [385.00ms]
```
### token-removed

Exit 0. Full log: `mutation-token-removed.log`.

```text
bun test v1.4.3 (c6da4a4d3)

src/cli/main.test.ts:
(pass) an empty MAINWORTHY_URL, MAINWORTHY_TOKEN or MAINWORTHY_PROJECT is the same as none [369.50ms]

 1 pass
 33 filtered out
 0 fail
 4 expect() calls
Ran 1 test across 1 file. [463.00ms]
```
### project-removed

Exit 0. Full log: `mutation-project-removed.log`.

```text
bun test v1.4.3 (c6da4a4d3)

src/cli/main.test.ts:
(pass) an empty MAINWORTHY_URL, MAINWORTHY_TOKEN or MAINWORTHY_PROJECT is the same as none [453.32ms]

 1 pass
 33 filtered out
 0 fail
 4 expect() calls
Ran 1 test across 1 file. [562.00ms]
```
### port-removed

Exit 0. Full log: `mutation-port-removed.log`.

```text
bun test v1.4.3 (c6da4a4d3)

src/cli/main.test.ts:
(pass) an empty MAINWORTHY_URL, MAINWORTHY_TOKEN or MAINWORTHY_PROJECT is the same as none [404.15ms]

 1 pass
 33 filtered out
 0 fail
 4 expect() calls
Ran 1 test across 1 file. [504.00ms]
```

## Additional boundary checks

Full commands and environment in `edges.json`. The baseline-client check restored only the three clientOptions expressions to the baseline, then restored the reviewed revision.

- health with no URL and port absent exited 1: `{ /   "url": "http://127.0.0.1:7357", /   "healthy": false, /   "version": null / }`.
- health with empty URL and port absent exited 1: `{ /   "url": "http://127.0.0.1:7357", /   "healthy": false, /   "version": null / }`.
- health with no URL and port empty exited 1: `{ /   "url": "http://127.0.0.1:7357", /   "healthy": false, /   "version": null / }`.
- health with empty URL and port empty exited 1: `{ /   "url": "http://127.0.0.1:7357", /   "healthy": false, /   "version": null / }`.
- health with no URL and port set exited 0: `{ /   "url": "http://127.0.0.1:8904", /   "healthy": true, /   "version": "0.1.0" / }`.
- health with empty URL and port set exited 0: `{ /   "url": "http://127.0.0.1:8904", /   "healthy": true, /   "version": "0.1.0" / }`.
- current explicit empty token exited 0: `{ /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / }`.
- current explicit empty project exited 0: `{ /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / }`.
- base-client explicit empty token exited 0: `{ /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / }`.
- base-client explicit empty project exited 0: `{ /   "counts": { /     "open": 0 /   }, /   "items": [], /   "cursor": null / }`.
- invalid nonempty MAINWORTHY_URL exited 4: `invalid: --url must be an HTTP or HTTPS URL`.
- invalid nonempty MAINWORTHY_TOKEN exited 4: `unauthenticated: a token is required`.
- invalid nonempty MAINWORTHY_PROJECT exited 4: `not_found: no project named missing-project`.
- port ignored when URL flag provided exited 0: `healthy: Mainworthy 0.1.0 at http://127.0.0.1:8904`.

## e. Automated checks: pass

- `TMPDIR=$HOME/.cache/mainworthy-arena/verify/cli-r1/tmp bun test --preload $HOME/.cache/mainworthy-arena/verify/cli-r1/ports.js src/cli` exited 0. Deciding lines in `cli-tests.log`: `43 pass`, `0 fail`, `314 expect() calls`, `Ran 43 tests across 4 files.` The preload only allocates port-0 listeners within the requested range. Tests and application source were otherwise unmodified during this run.
- `bunx tsc --noEmit` exited 0, no output. Log: `tsc.log`.
- `bunx biome check src test bench` exited 0. `Checked 129 files in 189ms. No fixes applied.` Log: `biome.log`.
- Both workflow runs also passed `bun run typecheck` and `bun run lint` before their test steps.

## Findings and interpretation

No blocking application defect found in the reviewed diff.

1. Non-blocking test coverage gap, `src/cli/main.test.ts:565`. The added test distinguishes MAINWORTHY_URL only. With all fixes removed or just the URL fix removed, it fails with `Expected: ""` and `Received: "invalid: --url must be an HTTP or HTTPS URL\n"`. Removing only token normalization, project normalization, or the health port change leaves the test passing. Token and project were already tested by truthiness in `Client.request` and `Client.project`, so their old empty-string representation had the same runtime behavior. The added test supplies a nonempty port and never exercises the empty-port change. A small additional health check with an empty port would protect that changed branch. The live boundary checks here confirm the intended behavior.

2. Non-blocking clarification of the brief's empty-flag claim. `--url ""` is rejected for all four commands, exit 4. `--token ""` and `--project ""` are accepted locally, exit 0. Reverting the client expressions to the baseline produces the same results. This is pre-existing behavior, not newly permitted behavior. An empty token flag overriding a valid token still receives `unauthenticated: a token is required`, exit 4, for application operations in server mode. Health remains public by design.

3. The workflow directory fix addresses a reproduced failure. Without a parent directory, Bun prints `JUnitReportFailed: Failed to write JUnit report` and `ENOENT`, while exiting 0 after successful tests. No report file is created. With `mkdir -p test-results`, JUnit is created, report exits 0, and gate reflects the test evidence: exit 0 for 179 passing tests; exit 2, `blocked: 1 failure unexplained, 1 question open`, for 179 passing and one failing test. The gate is not expected to use the test runner's exact nonzero exit code.

## Safety fact: proven

Empty and absent tokens both fail inbox, report and gate in server mode with exit 4 and `unauthenticated: a token is required`. A real issued token succeeds, and an invalid nonempty token is refused. Explicit URL flags override empty or nonempty environment settings; an explicit empty URL is never replaced by the fallback. Invalid nonempty URL, token and project settings remain errors. Health with no named URL and absent or empty MAINWORTHY_PORT selects the identical `http://127.0.0.1:7357` address; a real allowed port selects the running server.

## Limits and final state

- Did not start a server on the built-in default port 7357, because the task restricts listeners to 8900–8949. Default-port selection and its connection-failure result were checked directly with that port unused. Successful real-server commands and workflow reproduction use reserved ports and explicit URL flags. The exact unmodified GitHub YAML was therefore not executed literally end to end. No GitHub-hosted runner, remote deployment, or configured external Mainworthy was contacted.
- Used the requested core-test subset for the workflow; did not rerun the entire src/test suite, browser checks, or performance budgets. CLI tests, typecheck and lint passed.
- This reviewer is Codex/GPT-6 Astra. This report alone does not establish the project's different-provider verification gate if the author also used Codex. The coordinating agent must assess that separately.
- After mutation tests and the deliberate workflow failure, every tracked file in the export was compared byte-for-byte with `git show 46a58d9:<path>` and matched. Shared checkout status was clean. All servers started by this review were terminated. No commits, repository edits, or shared worktree cleanup were performed.

PASS (no blockers)
