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
