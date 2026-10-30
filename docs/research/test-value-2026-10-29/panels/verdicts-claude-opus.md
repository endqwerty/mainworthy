# Panel 1: how a test verdict should reach users (claude-opus)

Evidence directory: the investigation's scratch directory (not kept; see the research README). Checkout `91ce9287`. Paths without a prefix
are lines in the checkout; `inventory.md` is `out/product/inventory.md`.

## 1. Recommended shape: (f) = (d) as the source, (a) as its screen, (c) as the way a person answers

**One read-only operation computes the evidence and a suggestion. A person turns a suggestion into a decision only by
raising it as a finding on the test.** Nothing is pushed into the queue by default.

**The read.** A new `stats` kind, `of: "tests"`, one row per test over a window, plus a compact `value` block on
`get T-n` so MCP agents get it without a new tool (`stats` is `mcp: null`, `src/server/ops/stats.ts:233`; tool budget,
decision 0118:24-30). Facts only, like the other reports ("Facts only: nothing here changes a gate or an excuse",
`src/server/evidence/stats.ts:1`). It reuses the gate's counting rule so a report and a gate agree
(`docs/decisions/0095-reports.md:19-24`).

Each row carries:

- `facts`: window and days of history; runs; failing **runs** (not occurrences) and runs where it was the only failing
  test; failures by answer class (defect / test / flaky / infra / expected), **split into person and rule**; flips;
  rerun ms; median and p95 duration; runs × duration; strongest co-failure partner with Jaccard and both counts;
  linked case and requirements; last reported; quarantine days; any held decision.
- `suggestion`: one of `keep`, `refactor`, `merge`, `move-down`, `delete`, `guard: a person must judge`, or
  `not-enough-evidence`.
- `because`: the facts that met each threshold, each with a ref (`Q-n`, `T-n`, result ids); `missing`: what is short
  ("41 of 300 runs", "0 person-answered failures"). This follows the rule that a sentence on a screen about the server
  is a claim (`AGENTS.md`, rules table): the screen says "Suggested: refactor, because 4 flips in 14 days", never
  "this test is worthless".

**Module map.** SQL for the facts in `src/server/evidence/` (it owns results, flips and excuses, `inventory.md` E1-E12);
the thresholds and verdict as a pure function in `src/core/` (e.g. `test-value.ts`) beside `src/core/stats.ts:18-64`,
so the web, CLI and agents get the same answer and it is unit-testable without a database; the op in
`src/server/ops/stats.ts`, so HTTP, CLI and OpenAPI come from the one registry. The web report screen
(`src/web/reports/`) shows the suggestion as a column with the facts beside it; it imports only `src/core`.

**Who sees it, when.** Anyone with `read`, on demand (report page, `mainworthy stats --of tests`, `get T-n`).

**Accept, reject, defer.** Extend a review finding's locus to name a test (`T-12`); today it takes a case, step,
requirement or change (`src/core/ops.ts:240-246`), and an unlinked test has no anchor (`inventory.md` E19). Add one
category, `test-verdict`, with the suggested verdict and a snapshot of `facts` as structured evidence (findings
carry only prose today, `inventory.md` §"Two gaps"). A person or agent raises it with `claim` (an MCP tool), and it
becomes a `finding` question. The answers already exist: accept / reject / duplicate / defer
(`src/core/kinds.ts:174-179`). A rejection holds (`decisions.holds`, `schema.sql:241`), and the review basis hash
re-asks only when the evidence changes (`src/server/evidence/findings.ts:35-36`), so "this is an invariant guard"
is said once. An accepted verdict changes standing only where Mainworthy owns standing, through the existing
Witness-taking writers (`src/server/kernel/witness.ts:23`): archive a manual case (`StateEdit`,
`src/core/proposals.ts:49-53`), quarantine (`src/core/proposals.ts:33-39`), unlink. Deleting an automated test happens
in the repository. The accepted finding is the record of why.

## 2. Minimum evidence before the product may suggest

General floor for every history verdict: at least 56 days of history (Meta's longest window, `research/methods.md`
M1), and a stable test identity (CI history keys tests by file and name across revisions, `ci/RESULT.md` §Scope).
Without these, the row is `not-enough-evidence` and lists what is missing.

| Suggestion | Minimum | Must show |
| --- | --- | --- |
| keep | one **person**-answered `defect` on a cause this test failed, or a sole-failing run answered `defect` | the questions; whether the catch was unique |
| refactor | flips ≥ `minFlips` in `windowDays` (2 in 14, `src/core/flaky.ts:5-11`), or ≥ 3 person answers with ≥ 50% `test`/`flaky`/`infra` | flip pairs; rerun ms; a note that a flaky report can be a product race (#146, #250, #925, `history/RESULT.md`) |
| merge | automated: both tests have ≥ 5 failing runs answered `defect` by a person, Jaccard ≥ 0.9, and distinct signatures; manual: text similarity plus a person's `duplicate` (`research/methods.md` M5) | the pair, the shared runs, the shared causes |
| move-down | a declared layer (tests have none, `inventory.md` E27) **and** a named lower test that failed on every defect cause this one failed on | both tests and causes; otherwise `not-enough-evidence` |
| delete | all of: zero person-answered defects; ≥ 300 runs with no failure (to bound a 1% failure rate at 95%: 0.99^299 ≈ 0.05; 20 runs leave 82%, `research/methods.md` M1); a second, different signal (a held merge or duplicate decision, or a lower test covering its causes); not the only test of a requirement; no held guard decision | each condition with its value |
| guard: a person must judge | zero failures **and** (linked to a requirement, or a held guard decision) | never paired with delete |

Raw failure counts must not stand in for runs. `test/e2e/planner-retry.test.ts` has 171 failure occurrences in 3
failing runs, none of them sole (`synth/scorecard.csv`). Changed paths cannot stand in for answers either: of 4,611
occurrences, 5 are `src-only` and 2,955 are `unknown` (`ci/RESULT.md` §Findings). Operation coverage alone cannot
justify move-down: almost every browser file has all its operations covered below (`tests_ops_all_below` ≈ `tests`),
yet the file review judged most "needs a browser" (`synth/scorecard.csv`).

## 3. Rejected

- **(a) alone.** A verdict column without the decision path invites sorting and acting on the label. It is also not
  agent-readable (`stats` has no MCP).
- **(b) a queue question for every suggestion.** It would put hundreds of tests into the queue at once, against
  "Mainworthy does not ask you to look at every red test" (`docs/guide/concepts.md:31`). The queue is for questions
  someone chose to raise.
- **(c) alone.** Findings are written by reviewers, and nothing derives them from results (`inventory.md` E19). On its
  own it has no source of evidence.
- **(e) a scheduled digest.** A stale snapshot that asks for no decision; an agent can build one from (d).
- **Auto-action** (Datadog-style quarantine or disable, `research/competitors.md` §1): standing without a Witness.
- **A single value score**: hides the evidence and is the easiest number to game.

## 4. The strongest case against this

With deterministic thresholds and short or rule-answered history, the product will say `not-enough-evidence` for
nearly every automated test. This repository has about 18 days of CI (2026-10-12 to 10-30, `ci/RESULT.md`), and CI
answers every failure "needs a fix" by rule (`AGENTS.md`), so there are no person answers at all. Most of this
investigation's verdicts came from evidence the product never sees: operation maps, coverage, mutation, file review
(`out/e2e-map/`, `out/phase2/`). The honest product might be (d) with facts only, no verdict field, leaving every verdict
to outside agents that can read the code, through `claim`. Extending the finding locus also changes `claim`'s schema,
which costs MCP tokens (decision 0118).

I keep the suggestion anyway. Refactor-from-flips and manual duplicates work today, "not enough: 41 of 300 runs"
tells a team what to collect, and agents attach code-side evidence to the same `test-verdict` finding.

## 5. Risks

- **Goodhart.** A rule answer of "needs a fix" makes every failing test look like a defect catcher, so count only
  person answers and show the rule share (`inventory.md` §contradictions 3). Retries hide flaky tests in the pass rate
  (`docs/guide/reports.md:38-50`), so refactor reads flips and reruns, not pass rate. A "time saved if deleted"
  headline would reward deletion: show cost beside catches, never alone. Only 21 of 203 bugs were found by a failing
  test, and 147 by review (`history/RESULT.md`), so "caught defects" undercounts value. Do not rank on it alone.
- **Deleting an invariant guard.** A guard that never fails and a dead test look identical. Zero failures alone never
  yields delete. A held guard decision suppresses delete until the evidence changes. Once an accepted delete is
  carried out, the "stopped reporting" signal (`tests.last_seq`, written but unread, `inventory.md` E18; not built,
  `docs/decisions/0095-reports.md:72`) should raise a question if a guarded test disappears.
- **Too little history.** Every row shows its window and run count; below the floor the product says
  `not-enough-evidence`. The report window is capped at 90 days (`src/core/stats.ts:8`), so "never failed in a year"
  needs a longer window or a stored rollup. Renamed tests restart their history.
