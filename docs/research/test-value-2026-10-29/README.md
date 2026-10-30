# Which tests to keep: research, 2026-10-29

**In short.** Coverage cannot decide which tests to delete. Planted bugs (mutants) can, and they are expensive to
run. A browser test cover built from client source lines kept 208 of 778 tests, and the kept set still missed 2 of
the 18 planted bugs the full set caught. So this repository should not cut its browser suite by coverage. It should
move rendering checks to component tests (shown to work once here), and look into the 11 of 34 planted bugs that no
browser test caught, strengthening an assertion only where the bug has a visible effect. It should run fewer browser
tests per pull request only behind a mutation check. For the product,
the panels settled on a staged design. Mainworthy shows per-test facts and lets a person accept or reject a suggested
action through a review finding. It suggests an action itself only where it holds the evidence that decides it.
[The proposed decision](../../decisions/2026-10-29-suggest-test-actions-from-evidence.md) records it, and the
roadmap issues are listed at the end.

The question, sharpened from the owner's: can Mainworthy tell a team which tests to keep, delete, refactor, merge or
move to a cheaper layer, for automated tests and manual cases alike? What evidence decides each verdict? Start with
this repository's own suite, where the owner says "we have too many e2e tests that take too long". The product
calls no AI APIs; outside agents use its MCP tools and CLI.

This was research and design. No product code changed. The measurements ran on scratch exports of commit
`91ce9287`. Who did what is under [Method](#method).

## What a test is worth

The working definition: a test is worth the defects it catches that no other test would, against what it costs to
run, rerun, triage and edit. The evidence below supports it with two corrections:

- **Silence is not worthlessness.** A test that never fails may be guarding an invariant. At Google 63,000 of
  5.5 million affected tests ever failed ([Memon et al. 2017](https://www.cs.umd.edu/~atif/pubs/Memon_2017_TGC_3103112.3103143-abstract.html),
  read as an abstract), and the advice there and from CloudBees Smart Tests is to run such tests less often, not to
  delete them.
- **Flaky is not the same as useless.** Three flaky-test reports in this repository uncovered real product races:
  [#146](https://github.com/endqwerty/mainworthy/issues/146), [#250](https://github.com/endqwerty/mainworthy/issues/250)
  and [#925](https://github.com/endqwerty/mainworthy/issues/925).

Each verdict therefore needs its own evidence. A single "value score" would hide which evidence is missing.

## What this repository's suite showed

The suite at `91ce9287` has 225 test files. 78 are under `test/e2e/`, and 77 files open a browser
(`scripts/browser-tests.ts`). `scripts/test-timings.json` is out of date for this tree: 12 entries name deleted files and 7 current files have
none. Its entries for current browser files sum to about 731 of 1,749 file-seconds. A full pull-request run took about 1,850 runner-seconds across its jobs (run
[40973499237](https://github.com/endqwerty/mainworthy/actions/runs/40973499237): `tests-1` 1,524 s, `performance`
209 s). At [the dated CI estimate](../../development/tests.md#estimate-the-recurring-ci-cost), one runner-second on
every run is about $0.45 a month.

### Failure history is thin, and nothing labels it

From 2,580 `check.yml` runs (2026-10-12 to 2026-10-30; 463 of 2,963 attempt logs were unavailable, 459 of them because of
GitHub's rate limit):

- 4,611 failing-test rows in 450 runs. Only 314 were the only failing test in their run. The rest failed beside
  others, as happens when a branch in progress breaks many things at once.
- What changed before the test next passed: product code only 5, test code only 710, both 794, nothing (a retry of
  the same commit) 147, undetermined 2,955. A test-only fix may be an intended update, not a false alarm, so these
  classes do not say whether a failure caught a defect.
- `test/e2e/planner-retry.test.ts` costs a median 69 s per run. Its 171 failure rows fall in only 3 runs, all beside
  other failures. Yet it was the only test to catch planted bug m006 (below). Failure history alone would have
  marked it for deletion.

Of 203 issues labelled `bug`, 21 were found by a failing test, 147 by review, 7 by an audit, and 28 by other routes or
unknown. Git history reaches back only to 2026-10-09.

The deciding gap: since 2026-10-20 this repository's CI answers every failure "needs a fix" by rule
([docs/deploy.md](../../deploy.md), the CI policy). A person can overrule that answer, but nothing asks them to.
The current instance started empty on 2026-10-28 ([docs/render-migration.md](../../render-migration.md)), and this
research did not read it. So recent failures are normally answered by rule, and no step asks anyone why a test
failed. A person may have answered some failures, but how many is not known. Answers about why a test failed are
the one signal no competitor records, and this repository has no step that collects them.

### Server operations cannot tell browser tests apart

A scratch export recorded which server operations every test called. 747 of 836 browser tests reached only
operations that cheaper tests also reach. Reading the assertions told a different story: 67 of 78 browser files check
browser-side behaviour (focus, drafts across windows, keyboard handling, rendering). Two files are already
process-level, two are timed performance files, and seven mix browser checks with data-only assertions that could move down.

### Client coverage and planted bugs: the deciding measurement

A second export recorded, for each browser test, the `src/web` lines it ran in Chromium (V8 coverage mapped through
source maps). 778 browser tests covered 14,570 lines. A greedy cover that kept every covered line, plus the server
outcomes only browser tests reach, kept 208 tests and dropped 570. Together the dropped tests ran 1,852 of 2,525
summed callback-seconds. That is test time, not a measured saving in suite wall time.

Then 34 planted bugs (mutants: a flipped condition, a deleted call, a changed key name) were applied one at a time to
lines that both kept and dropped tests ran. Each mutant was tried against every browser test covering its line, and
then against the kept tests alone. The sample used a fixed seed and was filtered by cost, so it is not a random
sample of all defects.

| Measurement | Result |
| --- | --- |
| Mutants the full covering set caught that the kept set also caught | **16 of 18** (88.9%, Wilson 95% interval 67% to 97%) |
| Caught by a dropped test only | m001 (`src/web/ui/result-trail.tsx:30`), m015 (`src/web/lib/device.ts:69`) |
| Survived every covering browser test | 11 of 34 |
| Failed to build or timed out | 5 |
| Caught by a component render, no browser | m001, by rendering the `ResultTrail` component with `react-dom/server` |

The two missed mutants mean deletion by line coverage loses real detection. Only the planted-bug check showed this,
which matches the literature: suites cut by coverage lose 0.2% to about 48% of their fault detection, depending on
the study ([notes/literature.md](notes/literature.md), section 1; figures read secondhand). The 11 survivors are either lines no assertion
really checks or mutants with no observable effect, and each needs a look. The component render shows that at least
some rendering checks can move out of the browser.

Survivors, for the assertion work: `src/web/runs/cockpit.tsx:412`, `src/web/lib/proposals.ts:180`,
`src/web/queue/index.tsx:519`, `src/web/lib/merges.ts:332`, `src/web/app.tsx:1007` and `:1019`,
`src/web/settings/policy.tsx:158`, `src/web/phone.tsx:136`, `src/web/ui/index.tsx:124`, `src/web/lib/keys.ts:175`,
`src/web/lib/drafts.ts:59`.

What this cannot see: CSS-only and layout regressions, the phone layout, the accessibility tree, timing and races
across windows. The 34 mutants took about two hours on 8 CPU threads.

## What others do

From [notes/competitors.md](notes/competitors.md) (vendor pages read 2026-10-29; some were blocked, and each is
marked there):

- Datadog Test Optimization, Trunk, CloudBees Smart Tests, BuildPulse and Currents all offer quarantine, disable or
  "fix" for flaky tests. CloudBees adds "never failing" and "longest" reports. None that could be read offers merge,
  move down a layer, redundancy or staleness detection for automated tests. None records a person's reason for a
  failure; Trunk has a "flag as flaky" switch.
- For manual cases, Qase, and Zephyr by its defaults, offer statuses such as deprecated, and Xray and Zephyr can
  archive a case. Some of this came from community pages, not official docs. TestRail's pages were blocked, so its
  case statuses are not established. In the pages that could be read, no tool suggests retiring or merging a case
  from evidence.
- Meta's predictive test selection caught over 95% of failures while running under a third of the selected tests,
  and it needed de-flaked labels to train ([Machalica et al. 2019](https://arxiv.org/abs/1810.05286)).
- Mutation score tracks real fault detection beyond coverage, but 17% of real faults had no matching mutant
  ([Just et al. 2014](https://cs.ubc.ca/~rtholmes/papers/fse_2014_just.pdf)). No TypeScript or web UI study was
  found.

## What may suggest each action

Evidence gates, not a score. When a gate is not met, the answer is "not enough evidence", together with the next
observation that would decide it.

| Action | Before it may be suggested |
| --- | --- |
| Keep | It caught a defect a person confirmed, or it is the only test that catches a planted bug, or a person named what it guards |
| Delete | The behaviour it guards was removed, or a named remaining test was shown to catch what it catches (planted bugs or compared assertions). Cost, a green history or coverage overlap alone never qualify |
| Refactor | A named problem with the behaviour to keep: repeated false alarms a person answered, flips on the same code, mutants it should catch and does not, or for a manual case unclear steps |
| Merge | Named tests whose assertions or expected results were compared, with the survivor named. Co-failure or text similarity only nominates a pair |
| Move down a layer | A cheaper test shown to catch the same planted bug or replayed failure, and an account of what still needs the browser |
| A person must judge: invariant guard | It never fails and guards something consequential. The product asks who owns it; it never suggests deleting it |

A manual case has the same gates. Its evidence is its versions, runs, last execution, requirement links and
near-duplicate text, and its "delete" is archiving through a proposal and a decision.

## How a suggestion reaches people

Two panels answered independently (GPT 6.1 Sol and Claude Opus 5.5, both at high effort). Because they agreed, a third
pass (GPT 6.1 Sol) argued the strongest alternative. Their answers are in [panels/](panels/); condensed:

- **Both panels:** one shared read per test or case. It carries the facts, a suggested action or "not enough
  evidence", the evidence for and against, and what is missing. It feeds a report page, the CLI and the MCP tools from
  the one operation registry. A person accepts, rejects or defers through a review finding that can name an automated
  test. A rejection holds until the evidence changes. Acceptance changes only what Mainworthy owns (archiving a case,
  quarantine, a link), through a decision. Deleting test code happens in the repository.
- **The contrarian:** the evidence that decided this repository's browser verdicts (assertions, client coverage,
  planted bugs) is code-side, and Mainworthy holds none of it. A server that computes labels would answer "not enough
  evidence" for almost every test. So ship the facts and the findings first, let a repository-side assessor (a script,
  an agent, or a person) attach code-side evidence to a finding, and promote a rule into the server only when its
  deciding inputs live there.

**Settled: staged.** This is the coordinator's synthesis of the three answers, not a point every panel agreed on. Stage one is the per-test facts read and findings that can name a test with a snapshot of their
evidence. Mainworthy suggests actions only where it holds the deciding inputs: a test that stopped reporting, a
manual case not run in a long time, near-duplicate manual cases, and the cost of flips and reruns. Code-side verdicts
come from an assessor in the repository. This repository's own assessor is the first one.

## Mutation testing in the product

The owner's words were "maybe, if optimal". The same two panels answered, and this time they split
([panels/](panels/)).

- **Claude Opus 5.5:** keep it out of the product. Run a weekly sampled job of about 12 mutants in this repository's
  CI, estimated at $3 to $4 a month, and attach its kill rows to findings. Build an importer only once a user asks
  for one, or once eight weekly runs have produced findings that people accepted.
- **GPT 6.1 Sol:** later, accept the standard mutation-testing-elements JSON (StrykerJS, Stryker.NET, and PIT through
  a plugin) as attributed evidence, kept apart from test results and the gate. No recurring job in this repository;
  mutate locally when a specific assertion or removal is being judged. It also found a limit in the format:
  `killedBy` may list only the first test that failed
  ([schema](https://raw.githubusercontent.com/stryker-mutator/mutation-testing-elements/master/packages/report-schema/src/mutation-testing-report-schema.json)).
  So a report alone cannot show that a test is the *only* one that catches a mutant. That needs a full replay.

They agree that Mainworthy should not run mutations, set thresholds, or rank tests by kill count, and that a
finding carrying mutation evidence comes first. **Settled:** no mutation feature in the product now. A finding can
carry mutation evidence as an attachment. An importer waits until a user asks for one, or until findings with
mutation evidence are being answered. In this repository, each move-down or assertion change runs the planted bugs it
is meant to catch. A weekly sampled job starts only once pull requests run fewer browser tests, because then it
guards that selection.

## Agents and AI-written tests

Agent-written suites grow fast and repeat themselves, which makes pruning matter more. Nothing published measures
pruning AI-written tests rigorously. The design above lets an outside agent help without Mainworthy calling an AI
API. The agent reads the per-test facts through MCP and does the code-side work in the repository (comparing
assertions, running planted bugs). It then files a finding with its evidence attached. A person answers the finding.
An agent's finding is labelled as the agent's, and a destructive action needs a person's acceptance.

## What is not established

- Defect yield per test layer for a web app like this one; no study was found.
- Any calibration of the gates: this repository has about 18 days of CI history, and its instance was not read for answers given by a person.
- Whether the 11 surviving mutants are real gaps or mutants with no observable effect.
- Runner-seconds saved by any reduction. No reduced suite was run in CI.
- Manual-case methods (staleness, near-duplicates) were not tried on real manual data. This repository has none.

## Method

Workers read and measured; the coordinator (Claude Opus 5.5) joined and judged. Every worker wrote its raw extracts
and scripts beside its findings in a scratch directory that is not kept. Paths under `out/` or `sources/` in the
notes and panel answers refer to it. The research notes are in [notes/](notes/), the panel answers in
[panels/](panels/), and the tables a reader needs in `data/`. A committed tool that redoes the coverage and
planted-bug measurement is the first roadmap item.

| Slice | Who | Source |
| --- | --- | --- |
| CI history | GPT 6.1 Terra | GitHub Actions run logs and JUnit artifacts, 2026-10-12 to 2026-10-30 |
| Suite history | GPT 6.1 Terra | `git log` of 1,600 commits, 83 flaky-test and 203 bug issues with their closing pull requests |
| Product inventory | Claude Sonnet 5.5 | the source at `91ce9287`; 219 file:line citations, checked to resolve |
| Outside research | Claude Sonnet 5.5 | papers and vendor pages, 2026-10-29; secondhand figures are marked in the notes |
| Server-operation map | GPT 6.1 Sol | an instrumented export: 214 of 225 test files (11 timed performance files skipped), 3 rerun after instrumentation fixes, 4 workers on CPUs 0-7 |
| Client coverage and planted bugs | GPT 6.1 Sol | an instrumented export: 778 tests in 74 functional browser files, served a separately built client bundle with inline source maps in place of the test build; 34 of 60 sampled mutants run within a two-hour budget, seed 20261029 |
| Panels | GPT 6.1 Sol, Claude Opus 5.5, then a GPT 6.1 Sol contrarian | the above |

`data/scorecard.csv` has one row per browser file: tests, CI failures and their classes, failures on `main`, churn,
and flaky issues. `data/mutants.csv` lists each planted bug and the tests that caught it. `data/browser-cover.csv`
lists every browser test the client-line cover keeps or drops. `data/file-assessment.csv` records, for each browser
file, whether its assertions need a browser.

## Roadmap

For this repository's suite (milestone M1, part of [#77](https://github.com/endqwerty/mainworthy/issues/77)):

1. [#1106](https://github.com/endqwerty/mainworthy/issues/1106): a committed command that measures which client lines each browser test runs and which planted
   bugs it catches. The items below use it for their evidence.
2. [#1107](https://github.com/endqwerty/mainworthy/issues/1107): move rendering checks and data-only assertions from browser tests to component tests, each
   shown to catch the same planted bug.
3. [#1108](https://github.com/endqwerty/mainworthy/issues/1108): look into the 11 planted bugs no browser test caught.
4. [#1109](https://github.com/endqwerty/mainworthy/issues/1109), the owner's call: run selected browser tests on pull requests and all of them on `main`, guarded
   by a weekly planted-bug job.
5. [#1110](https://github.com/endqwerty/mainworthy/issues/1110), the owner's call: record why each CI failure happened, beside the rule's answer.

For the product (milestone M5), the stages of [the proposed decision](../../decisions/2026-10-29-suggest-test-actions-from-evidence.md):

1. [#1111](https://github.com/endqwerty/mainworthy/issues/1111): per-test and per-case facts in one read, on the web, CLI and MCP.
2. [#1112](https://github.com/endqwerty/mainworthy/issues/1112): review findings that can name an automated test and keep their evidence.
3. [#1113](https://github.com/endqwerty/mainworthy/issues/1113): suggestions where Mainworthy holds the evidence: tests that stopped reporting, stale manual
   cases, near-duplicate manual cases, and the cost of flips and reruns.
