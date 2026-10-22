# Native report fixtures

Sources checked on 2026-10-14 for [issue #37](https://github.com/endqwerty/mainworthy/issues/37).
These reports exercise each adapter's actual input representation. The tests
also construct small variants for malformed data, retries, and runner errors.

| Fixture | Provenance |
| --- | --- |
| `playwright.json` | Generated with cached `@playwright/test` and `playwright` 1.63.0, using the JSON reporter. The four tests pass, fail, skip, and pass on their first retry. Absolute generator and cache paths were replaced with `/workspace` and `/runner/cache`; result values and fields are unchanged. No browser was launched. |
| `jest.json` | Written from Jest's documented formatted result types. The offline install could not resolve all cached dependency manifests, and the cached packages could not run a complete test suite. This is a schema fixture, not generated Jest output. |
| `vitest.json` | Written from Vitest's documented JSON reporter types and example. Vitest was not cached. This is a schema fixture, not generated Vitest output. |
| `pytest.json` | Written from the `pytest-json-report` plugin's documented report, test, and stage schema. Neither pytest nor the plugin was installed or cached. This is plugin output, not a format built into pytest. |
| `sample.trx` | Written from Microsoft's TRX field mapping and VSTest result/definition serializers. No .NET SDK was available. Includes results before definitions, a namespaced root, entity text, CDATA, and a seven-digit fractional duration. |

## Real runner regression fixtures

The `real-*.json` fixtures were generated on 2026-10-14 with Node 26.11.1,
Jest 30.5.2, Vitest 5.0.4, Playwright 1.64.1, Python 3.9.6,
pytest 8.4.2, and pytest-json-report 1.5.0. These supplement the older small
schema fixtures above. The adapter regressions and CLI upload tests read them.

Each runner project is preserved under `sources/<runner>/`. Copy the files to
an isolated directory and remove the `.txt` suffix. Install the JavaScript
runners in a parent directory, and pytest plus pytest-json-report in a virtual
environment. Run the corresponding command from each project directory:

```sh
jest --runInBand --json --outputFile=out.json
vitest run --reporter=json --outputFile=out.json
FORCE_COLOR=1 playwright test
pytest --json-report --json-report-file=out.json
```

All four commands exit 1 because the samples deliberately include failures.
Jest, Vitest, and Playwright include pass, fail, skip, todo or fixme,
parameterized cases, and a test that passes after a retry. Playwright retains full retry history; the other reporters retain partial evidence, described below. Pytest includes two different failing
assertions in one class, parameterized tests, skip, expected failure, and a
fixture setup error. Playwright uses no browser fixtures and launches no browser.

Only whitespace and path prefixes in the captured JSON were changed. The
project's absolute path becomes `/home/robin/project`, the tools directory
becomes `/runner/cache`, and any remaining home path becomes `/home/robin`.
Absolute `testResults[].name` fields remain absolute in both real Jest and
Vitest fixtures. No `rootDir` was added. Tests supply the source root separately,
just as the CLI obtains it from Git or its working directory. Pytest's class
instance lines, memory addresses, crash messages, and Playwright's ANSI colour
escapes remain in the fixtures so regressions exercise real reporter output.

Official format references:

- [Playwright JSON types](https://github.com/microsoft/playwright/blob/main/packages/playwright/types/testReporter.d.ts)
  and [JSON reporter](https://github.com/microsoft/playwright/blob/main/packages/playwright/src/reporters/json.ts).
- [Jest JSON CLI option](https://jestjs.io/docs/cli#--json)
  and [formatted result types](https://github.com/jestjs/jest/blob/main/packages/jest-test-result/src/types.ts).
- [Vitest JSON reporter example](https://vitest.dev/guide/reporters#json-reporter)
  and [reporter types and serialization](https://github.com/vitest-dev/vitest/blob/main/packages/vitest/src/node/reporters/json.ts).
- [pytest-json-report format](https://github.com/numirias/pytest-json-report#format)
  and [pytest's built-in JUnit export](https://docs.pytest.org/en/stable/how-to/output.html#creating-junitxml-format-files).
- [Microsoft TRX field mapping](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/publish-test-results-v2?view=azure-pipelines#result-formats-mapping),
  [test definitions](https://github.com/microsoft/vstest/blob/main/src/Microsoft.TestPlatform.Extensions.TrxLogger/ObjectModel/UnitTestElement.cs),
  and [outcome enum](https://github.com/microsoft/vstest/blob/main/src/Microsoft.TestPlatform.Extensions.TrxLogger/ObjectModel/TestOutcome.cs).

To regenerate the Playwright sample in an isolated directory, use this test
as `sample.spec.cjs`:

```js
const { test, expect } = require('@playwright/test');
test.describe('checkout', () => {
	test('passes @C-1@v1', () => expect(1).toBe(1));
	test('fails', () => expect(1).toBe(2));
	test.skip('skipped', () => {});
	test('retry', ({}, info) => expect(info.retry).toBe(1));
});
```

Configure one worker, one retry, a project named `chromium`, and the JSON
reporter writing `playwright.json`. The fixture was generated from the same
tests on one line; source snippets in failures reflect that layout.

The selected formats are those explicitly requested by the issue. CTRF stays
deferred: no concrete Mainworthy pipeline requiring it was identified, and no
adapter or adoption claim is made here. The pytest selection follows the
plugin's published schema rather than assuming a pytest-native JSON standard.

## Retry evidence regression fixtures

`jest-retries.json`, `vitest-retries.json`, and `pytest-retries.json` were generated
on 2026-10-22 with Node 26.12.0, Jest 30.5.2, Vitest 5.0.4, Python 3.15.0,
pytest 8.4.2, pytest-json-report 1.5.0, and pytest-rerunfailures 16.7.
Their sources are `sources/jest/sample.test.cjs.txt`,
`sources/vitest/sample.vitest.test.js.txt`, and `sources/pytest/test_sample.py.txt`.
Copy them into an isolated runner project and remove `.txt`, then run:

```sh
jest sample.test.cjs --runInBand --json --outputFile=jest-retries.json
vitest run sample.vitest.test.js --reporter=json --outputFile=vitest-retries.json
pytest --reruns 2 --json-report --json-report-file=pytest-retries.json
```

Each command exits 1. Each report has a test that fails twice then passes, an
exhausted failure, a clean pass, and a skip. Only whitespace and path prefixes were changed to
`/workspace`, and the scratch directory's keyword was changed to `retry-samples`.
Values, stack traces, reporter metadata, durations, and timestamps remain as generated.

Jest retains `invocations` and, with `logErrorsBeforeRetry`, `retryReasons`.
Jest flattens errors, so multiple errors per try can lose diagnostic boundaries.
Vitest keeps earlier errors in a passed assertion's `failureMessages`, but its
JSON reporter omits retry counts and boundaries. Pytest overwrites stages on
each execution; a recovered test retains the overall `rerun` outcome beside
passing final stages. Exhausted pytest failures retain no retry marker.
The adapter tests check these limits rather than assuming each error is one try.

The serialization code for these installed versions was checked alongside the
reports. The upstream sources are [Jest's circus result conversion](https://github.com/jestjs/jest/blob/main/packages/jest-circus/src/utils.ts),
[Vitest's JSON reporter](https://github.com/vitest-dev/vitest/blob/main/packages/vitest/src/node/reporters/json.ts),
and [pytest-json-report's report hook](https://github.com/numirias/pytest-json-report/blob/master/pytest_jsonreport/plugin.py).
