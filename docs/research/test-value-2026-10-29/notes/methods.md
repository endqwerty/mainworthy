# Methods: deterministic ways to judge a test from result history, coverage and case text

No AI API is used by any method here. Each method gives its inputs, the formula, how it fails, a citation, and
what it would need in this repository. Written 2026-10-29. Labels as in `literature.md`: **[read]** I read the source,
**[abstract]** abstract only, **[second]** via a later paper or summary, **[own]** my derivation with no direct source.

Conventions. A **test** is a file, or a file plus test name. A **run** is one execution of the test on one commit. For
each (test, run): outcome `pass|fail|skip`, duration `d`, commit `c`, and optionally a human **answer** to the
failure (this product's own: `defect | test | expected | flaky | infra`). `W` is a window (e.g. 56 days).

Backtest rule for every method (taken from how Meta evaluated predictive test selection [read, `sources/pts.txt`]):
fit on history before a date, judge on history after it. A method is only "good" if the tests it would have removed
or demoted would not have missed a *defect-labelled* failure in the later period. Report the missed count, not just a
percentage saved.

---

## M1. Recent failure rate and never-failed (history)

- **Inputs:** outcome per (test, run) over `W`.
- **Formula:** `fail_rate(t, W) = fails / (passes + fails)`; `never_failed(t) = fails == 0 and runs >= R`.
  Meta used the test's failure rates over the last 7, 14, 28 and 56 days as features [read]; Launchable's Never
  Failing report requires at least 5 runs a week for inclusion [read, <https://help.launchableinc.com/features/unhealthy-tests/>].
  Suggested: require `runs >= 20` before calling a test never-failing.
- **Use:** a test with many runs and no failure is a candidate to run less often (Launchable: "move to the right") or
  to move down a layer. It is not a delete verdict.
- **Failure modes:** (a) a smoke or invariant test fails rarely by design; (b) a short window or few runs makes zero
  failures likely by chance (with `n` runs and true failure rate `p`, the chance of zero failures is `(1-p)^n`; for
  `p = 0.01` and `n = 20` that is 82%, so 20 runs cannot separate a 1% test from a dead one); (c) failures that
  were fixed in a PR before merge never reach trunk history; (d) it measures detection of *past* faults only.
- **Citations:** Machalica et al., ICSE-SEIP 2019 [read]; Memon et al., ICSE-SEIP 2017 (63K of 5.5M affected tests ever
  failed) [abstract+second]. See `literature.md` sections 3.5 and 4.
- **Needs here:** per-test results over many commits, including PR-branch runs. Whether the instance stores that history
  for this repository's own CI is a question for the data slices; I did not check it.

## M2. Same-code flip (flakiness)

- **Inputs:** outcomes of one test on the *same commit and same inputs*, across attempts or jobs.
- **Formula:** `flaky(t, c) = exists attempts a1, a2 on c with outcome(a1)=pass and outcome(a2)=fail`.
  `flake_rate(t, W) = commits_with_flip / commits_with_>=2_attempts`. Develocity: fail then pass in one execution is
  `FLAKY` [read]; Launchable's score is the probability of fail-then-pass on rerun, needs a retry mechanism [read];
  Trunk's Pass-on-Retry monitor flags fail-then-pass on the same commit [read]. Mainworthy's own: decision 0045
  "same-code detector suggestions" (`docs/decisions/0045-same-code-detector-suggestions.md`; I did not open it).
- **Failure modes:** needs retries or a second job to exist; underestimates rare flakes (FlakeFlagger: some flakes were
  not found even in 10,000 reruns [read, `sources/ff2.pdf`]); a flip can be a real nondeterministic bug (Luo 2014: do not
  delete flaky tests as if they carry no signal [read]); an infra outage looks like a flip.
- **Differential-coverage variant (DeFlaker):** a test that fails and covers none of the lines changed in the commit is
  flaky, with no rerun: 1.5% false alarms and 95.5% recall in their histories [abstract, second]. Needs per-test coverage
  per commit, so only affordable for the non-browser tests here.
- **Citations:** Luo et al., FSE 2014; Bell et al., ICSE 2018; Lam et al., ICST 2019. `literature.md` section 3.

## M3. Coverage subset and greedy set cover (redundancy candidates)

- **Inputs:** for each test, the set `C(t)` of covered requirements (statements, branches, or, cheaper, source files).
- **Formula:** classic greedy: repeat `pick argmax_t |C(t) \ covered|` until `covered = union C(t)`; tests never picked are
  redundant *with respect to that requirement set*. HGS orders by how few tests cover each requirement (cardinality-1
  requirements first, so the only test for a line is always kept) [second]. Unique coverage:
  `U(t) = C(t) \ union_{s != t} C(s)`. `U(t) = {}` marks `t` as subsumed.
- **Failure modes:** coverage equivalence is not fault-detection equivalence: Rothermel et al. 2002 report severe loss,
  Wong et al. 1998 report 0.19% to 6.55%, the two disagree by an order of magnitude [second]. Browser tests cover the
  same server lines as API tests but check different things (what is rendered, focus, layout). A test with `U(t) = {}`
  may be the only one that asserts a particular value. Greedy depends on order; re-run after each removal.
- **Cheaper variant:** use files, not lines, as the requirement; use branch coverage, not statement coverage, when
  available.
- **Citations:** Harrold, Gupta, Soffa, TOSEM 1993; Rothermel et al. 1998, 2002; Wong et al. 1998 (bibliographic details
  only, not read). `literature.md` section 1.
- **Needs here:** per-test (file) coverage. Bun's built-in coverage is per run; per-file coverage would need running
  each test file separately. I did not verify Bun 1.4's coverage output format in this run.

## M4. Co-failure clustering (merge candidates)

- **Inputs:** the set of tests failing in each failed run.
- **Formula:** for tests `a, b`: `J(a,b) = |F(a) ∩ F(b)| / |F(a) ∪ F(b)|` where `F(t)` is the set of runs (commits) where
  `t` failed. Pairs with `J` near 1 and at least `k` failures each always break together.
- **Use:** two tests that always fail together are measuring the same thing, or one is downstream of the other. A
  candidate to merge, or to keep only the cheaper one.
- **Failure modes:** a shared setup failure (one broken fixture fails every test using it) creates `J = 1` without any
  redundancy; small `k` gives meaningless `J`; a flake that hits a whole shard looks like co-failure. Condition on
  the human answer: use only failures answered `defect`.
- **Citation:** [own]. The idea of clustering failures by shared signature is in Lampel et al. 2021 (job telemetry, not
  co-failure) [abstract]. I found no paper that merges tests this way. Treat as a hypothesis to back-test.

## M5. Text similarity of case bodies (duplicate manual cases)

- **Inputs:** case title, steps, expected results (text).
- **Formula (cheap, deterministic):**
  1. Normalise (lowercase, strip punctuation, collapse whitespace, drop stop-words).
  2. Shingle: set `S(c)` of word 3-grams.
  3. Exact set resemblance `J(a,b) = |S(a) ∩ S(b)| / |S(a) ∪ S(b)|`. MinHash approximates `J` with `k` hash functions:
     `Pr[min_h(S(a)) = min_h(S(b))] = J(a,b)`, so the fraction of equal signature slots estimates `J` with standard error
     about `sqrt(J(1-J)/k)` (k = 128 gives about 0.04 at J = 0.5). Locality-sensitive hashing over bands finds pairs
     above a threshold without comparing all pairs. At a few thousand cases all-pairs `J` is cheap and MinHash is not
     needed; it matters beyond ~100,000 cases.
  4. Alternative: TF-IDF cosine of the same text. Step-level clustering, then case-level, is the Viggiato pipeline.
- **Thresholds:** unknown for this corpus; choose by labelling 100 pairs. Viggiato et al. report F-scores of 87.39% (steps) and
  83.47% (cases) with embeddings and clustering on an industrial suite; their text-embedding techniques are not
  deterministic-without-a-model in the sense used here, so the bag-of-shingles result may be lower. [abstract, <https://arxiv.org/abs/2110.07733>]
- **Failure modes:** same words, different intent (login as admin versus login as viewer differ in one token); same
  intent, different words; templated cases (every case starts with the same 8 setup steps) inflate similarity, so strip
  shared boilerplate or weight by IDF; MinHash estimate noise near the threshold.
- **Citations:** Broder, "On the resemblance and containment of documents", Compression and Complexity of Sequences
  1997 (DOI 10.1109/SEQUEN.1997.666900) [not fetched this run, from memory; verify before citing]; Viggiato et al. 2021
  [abstract]; Flemström (Postgres string-similarity over 65,000 test steps) [second].
- **Needs here:** case text is stored; this is the one method that needs no run history. Output is a candidate pair
  list; the verdict comes from a human `duplicate` answer (`docs/open-questions.md` question 22 mentions that answer
  kind; I did not read the rest).

## M6. Mutation: the unique kill set (detection ability)

- **Inputs:** source under test, the tests, a mutation tool producing per-test kill data.
- **Formula:** `K(t)` = mutants killed by `t`. `unique_kills(t) = |K(t) \ union_{s != t} K(s)|`. Suite mutation score
  `= killed / (total - equivalent)`. `unique_kills(t) = 0` with `|K(t)| > 0` means `t` is redundant for those mutants.
- **Failure modes:** equivalent mutants (undetectable by design; Google found 85% of reported mutants unproductive before
  filtering, from a summary [second]); a mutant model does not model layout, focus, CSS or timing (Just et al.: 17% of
  real faults are not coupled to any mutant [read]); cost is full-suite runs per mutant; survivors in code with no
  test are a coverage question, not a test-quality one.
- **Practical form:** mutate only changed lines per pull request (Google, TSE 2021 [abstract]) and with per-test coverage
  so each mutant runs only the tests that reach it.
- **Citations:** Just et al., FSE 2014 [read]; Chekam et al., ICSE 2017 [read]; Petrović et al. 2018, 2021 [abstract].

### M6a. Does StrykerJS (or another mutation tool) run under Bun 1.4 today?

**Short answer: yes for a community plugin, not official, and not run by me. Checked 2026-10-29.**

- StrykerJS core is current: `@stryker-mutator/core` 10.1.1, published 2026-10-23, `engines.node >= 22`
  (npm registry: <https://registry.npmjs.org/@stryker-mutator/core>). It runs on Node; only the test processes run on Bun.
- No official Bun runner. The official test runner list is cucumber, Jasmine, Jest, Karma, Mocha, Tap, Vitest; the page
  does not mention Bun and says other runners can use the generic "command test runner"
  (<https://stryker-mutator.io/docs/stryker-js/plugins/>, fetched 2026-10-29). The feature request "Support bun test
  runner" is open: <https://github.com/stryker-mutator/stryker-js/issues/4439> (updated 2026-09-23); "Add Bun test runner
  plugin to @stryker-mutator scope" is open too: <https://github.com/stryker-mutator/stryker-js/issues/5424> (2026-05-15).
  In issue 4439 a contributor who had investigated wrote in 2023-10 that Bun's test runner "doesn't have a public API yet".
- Community runner that targets Bun 1.4: **`@hughescr/stryker-bun-runner` 1.6.0**, published 2026-10-13, created
  2026-01-16, Apache-2.0, 8 GitHub stars at the time. npm `engines`: `bun >= 1.4.0, node >= 20`; peer deps:
  `@stryker-mutator/core ^9 || ^10`, `typescript <7`. Its README: tested with Bun 1.4.0, 1.4.2 and 1.4.3; per-test
  coverage; "a crash or a run that proves nothing is an Error, not a kill"; works with incremental mode, `testFiles`,
  `ignoreStatic`, the TypeScript checker. Config: `appendPlugins: ['@hughescr/stryker-bun-runner']`,
  `testRunner: 'bun'`. (<https://github.com/hughescr/stryker-bun-runner>, README read through the GitHub API on
  2026-10-29; npm: <https://registry.npmjs.org/@hughescr/stryker-bun-runner>.)
- An older community plugin, `stryker-mutator-bun-runner` 0.4.0, was last published 2025-07-07 and declares `bun >= 1.0.0`
  (<https://registry.npmjs.org/stryker-mutator-bun-runner>). A Codeberg issue reports timeout and WebSocket problems with a
  Bun runner in another project (<https://codeberg.org/glueckauf/bergwerk/issues/40>) [search]. Prefer the newer one.
- **Things in this checkout that bear on it** (read-only look at commit `91ce9287`):
  - `package.json` pins `"typescript": "^7.0.2"`. The runner README says TypeScript 7 breaks Stryker's config read with
    `TypeError: ts.parseConfigFileTextToJson is not a function`, and that its peer dependency is `typescript <7`. So a
    run needs TypeScript 6 in a scratch copy, which I did not try. This is the first thing that would fail.
  - Tests run one at a time in the runner (documented limitation): per-test coverage is exact but mutation runs are
    slower than parallel `bun test`. Several files are long (`test/sequences-*.test.ts` run 50 to 100 s in
    `scripts/test-timings.json`), which makes per-mutant reruns expensive; those files are poor candidates for a first run.
  - `mock.module()` appears in 1 file in `test/`, `src/` and `scripts/` (grep count of files); the runner documents that
    mocking a mutated module has no effect after the dry run's imports.
  - The 81 browser files in `test/e2e/` drive Chromium through `playwright-core`; mutation of server code through them is
    possible in principle but each mutant would rerun real browser sessions, which is not affordable. Restrict a first
    experiment to `src/core` (pure, per `AGENTS.md`) and its non-browser tests.
- **Other tools:** I did not evaluate another JavaScript mutation tool. The generic Stryker "command test runner" can run
  `bun test` as an opaque process, but then it has no per-test coverage and reruns the whole suite for every mutant.
- **Not run.** My brief says I need not run code. Whether the runner works on this repository (Bun 1.4.4 is installed
  here) is unknown until someone installs it in a scratch export with TypeScript 6.

## M7. File-level dependency selection (run fewer, delete none)

- **Inputs:** the import graph (static) or the set of files each test file loads (dynamic), plus the files changed in the
  commit.
- **Formula:** run test `t` iff `deps(t) ∩ changed ≠ {}`, plus always-run triggers (config files, lockfile, schema).
  Ekstazi: dynamic file dependencies, about 32% average and 54% (long suites) end-to-end time saving [second].
  Datadog TIA documents the failure modes: data files, external services and library changes are invisible; commits
  touching more than 5,000 files run everything; tests covering more than 16,000 files are never skipped [read].
- **Failure modes:** a test that reaches code through a database, a URL or a generated file has hidden dependencies; a
  skipped test can hide a regression until the next full run; false negatives are silent.
- **Needs here:** the checkout's own `scripts/ci-scope.ts` already decides what CI runs for a branch (AGENTS.md); I did
  not read it. Ekstazi (ISSTA 2015, ACM SIGSOFT Distinguished Paper) is the reference design.

## M8. Cost per test (the cost side of the working definition)

- **Inputs:** duration `d_t` (per run), runs per period `n`, runner price `p`, rerun count `r_t`, failures `f_t` with human
  triage minutes `m`, edit count `e_t` from git.
- **Formula (own, assembled from the definition):**
  `cost(t) = n * d_t * p`                         (machine)
  `+ n * flake_rate(t) * d_t * p`                 (rerun machine)
  `+ f_t^(noise) * m * wage`                      (triage on failures answered test/flaky/infra)
  `+ e_t * edit_minutes * wage`                   (churn from git blame/log on the test file).
  Datadog reports the same shape: "Time Wasted in CI" split into flaky and non-flaky failures [read].
  Waiting time matters more than machine time for the owner: the longest *shard* sets the PR wait, so for a sharded suite
  use `wall(t) = d_t` only if `t` is on the critical shard.
- **Reference rate:** `AGENTS.md` prices one added runner-second on every run at about $0.45 a month at private Linux rates,
  dated 2026-10-28 (a "dated estimate, not a spending limit"). That gives `p`.
- **Failure modes:** the triage-minutes and edit-minutes inputs are guesses unless measured; machine cost is cheap here, so
  the ranking is dominated by wait time and by trust, which the formula does not price.

## M9. Layer fit (move down a layer)

- **Inputs:** per browser test: the set of server operations (from the one registry, `src/server/ops/index.ts`) it calls,
  and the set of assertions it makes (DOM text/role versus data).
- **Formula (own):** `ui_share(t) = DOM_assertions / all_assertions`. A browser test with `ui_share` near 0 asserts only
  server state and could be an operation-level test. A browser test whose operations are all already covered by a faster
  test (set cover over operations) and whose `ui_share` is low is a move-down candidate.
- **Failure modes:** a browser test also proves wiring (that the button calls the operation); counting assertions
  misses that. Needs a human check per candidate.
- **Citation:** none directly; the argument for few end-to-end tests is Wacker 2015 (Google Testing Blog) [page read, body not
  returned] and the practitioner trophy. `literature.md` section 6. I found no controlled study.

## M10. Staleness

- **Inputs:** git history of the test file and of the source files it depends on; last failure date; last edit date.
- **Formula (own):** `stale(t) = last_fail(t) older than W_f and last_edit(t) older than W_e and deps(t) changed since
  last_edit(t)`: the production code moved and the test did not, and it has not failed in either case. For manual cases:
  case not run in `W` and linked requirement closed.
- **Failure modes:** a stable subject legitimately leaves its tests untouched; "not edited" is also what a good test
  looks like.
- **Citation:** co-evolution of production and test code is studied in Zaidman, Van Rompaey, Demeyer, van Deursen, Empirical
  Software Engineering 2011 [not fetched this run; from memory, verify before citing]. No source I read gives a threshold.

## M11. Labelled-answer ledger (this product's own signal)

- **Inputs:** each failure carries a human answer from `{defect, test, expected, flaky, infra}` (Mainworthy's kinds).
- **Formulas (own):**
  `yield(t) = count(failures of t answered defect) / count(runs of t)`
  `noise(t) = count(failures answered test or flaky or infra) / count(failures of t)`
  `first_catch(t)` = defect-answered failures where `t` failed and no other test failed on that commit (the strongest form
  of "caught something no other test caught").
  A test with high cost and `yield = 0`, `first_catch = 0` over a long window is a delete or move-down candidate with
  direct evidence. A test with high `noise` is a refactor candidate. A test with `first_catch > 0` is protected.
- **Failure modes:** answers are sparse unless people give them; an answered `defect` may be the reason for several tests
  failing at once, so `first_catch` undercounts redundancy when two tests catch the same defect (both look
  "not first"; compute it as the defect's *minimal covering set* of tests instead); survivorship (defects fixed before
  merge are never answered).
- **Why it matters:** the closest published analogue is Meta's use of de-flaked outcomes as the labels for its model
  [read]; without them the classifier gave "very poor predictions". No tool in `competitors.md` records a human reason.
- **Citation:** [own]; supporting argument from Machalica et al. 2019 and Lampel et al. 2021 [read/abstract].
- **Needs here:** this repository's own CI results on the instance with answers attached. How many failures exist and how
  many are answered is a measurement for the data slice, not this one.

---

## Combining, and ranking

Suggested order of evidence strength for a **delete or demote** verdict (strongest first):

1. `first_catch > 0` protects (M11).
2. A demote verdict needs two independent signals from different families: for example M1 (no failures) **and** M3 or
   M6 (nothing unique), or M4 (always fails with another test) **and** M8 (high cost).
3. A refactor verdict comes from M2 (flip) or M11 `noise`, or from smells (`literature.md` section 5), not from cost alone.
4. A merge verdict for manual cases comes from M5 plus a human `duplicate` answer.
5. Every verdict lists the evidence it used, the window, and the backtest miss count.

Methods that need no history at all (usable on day one): M3 (given coverage), M5, M7, M10-manual. Methods that need
history: M1, M2, M4, M8, M11.

## Not established

- Whether Stryker plus the Bun runner works on this repository: documented, not run (TypeScript 7 conflict is the known
  first failure).
- Bun 1.4's per-file coverage output format and cost: not checked.
- Thresholds for M1, M4, M5, M10 for this repository: no source gives them; they need a labelled sample.
- Broder (1997) and Zaidman (2011) are cited from memory; I did not fetch them in this run.
