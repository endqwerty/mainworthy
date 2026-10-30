# Literature: what is known about the value of a test, and about shrinking a suite

Written 2026-10-29. Scope: which tests to keep, delete, refactor, merge or move down a layer, for a small
TypeScript web app (Bun, PostgreSQL, React) with about 230 test files (81 browser files, about 746 s summed; about
149 other files, about 1003 s summed; `scripts/test-timings.json`).

How to read the labels:

- **[read]** I downloaded the paper (kept in `sources/`, text next to it) and read the quoted lines.
- **[abstract]** I read the abstract or publisher/author page only.
- **[second]** The number comes from a later paper or a search summary. Check it before you cite it.
- **[unconfirmed]** I looked and could not establish it. Said so in the entry.

Every entry ends with "Transfer": how far it carries over to this repository. A short list of evidence that
contradicts the working definition of value ("defects it catches that no other test would, against its cost") is at
the end (section 12).

---

## 1. Test suite minimisation: HGS, greedy set cover, and the loss in fault detection

**What it is.** Pick the smallest subset of tests that still covers every "requirement" (statement, branch, def-use
pair) the full suite covers. That is set cover, NP-hard, so everybody uses a greedy heuristic. Harrold, Gupta and
Soffa (HGS) is a greedy variant that processes requirements by how few tests cover them (cardinality 1 first, and so
on) instead of picking the globally largest test first.

- Harrold, Gupta, Soffa, "A methodology for controlling the size of a test suite", ACM TOSEM 2(3):270-285, July 1993.
  [second: bibliographic details via a citing paper; I did not read the 1993 paper.]
  <https://dl.acm.org/doi/10.1145/152388.152391> (not fetched; DOI page).
- Wong, Horgan, London, Mathur, "Effect of test set minimization on fault detection effectiveness", Software:
  Practice and Experience 28(4):347-369, 1998. Reported (via Jeffrey and Gupta, 2007): size reduction 9% to 68%, fault
  detection loss only 0.19% to 6.55%. [second]
- Rothermel, Harrold, Ostrin, Hong, ICSM 1998, pp. 34-43, and the journal version "Empirical studies of test-suite
  reduction", Software Testing, Verification and Reliability, 2002. The 2002 abstract says fault-detection capability
  "can be severely compromised by test-suite reduction", contradicting the earlier finding. Jeffrey and Gupta (2007)
  cite about 80% size reduction with about 48% average fault-detection loss from the Rothermel study. [second; the
  80% and 48% are not confirmed against the original.]
  Search summary sources: <https://zendy.io/title/10.1002/stvr.256>, <https://bibtex.github.io/ICSM-1998-RothermelHOH.html>.
- Newer, similarity-based: Pan, Ghaleb, Briand, "LTM: Scalable and Black-box Similarity-based Test Suite Minimization
  based on Language Models", arXiv 2304.01397 (v1 3 April 2023, v5 30 September 2024; TSE 2024). Best configuration
  (UniXcoder with cosine) reached fault detection rate 0.84 versus 0.81 for ATM, and a testing-time saving of 41.72%
  versus 41.02%, about five times faster to compute than ATM. [abstract] <https://arxiv.org/abs/2304.01397>

**The finding.** The two classic studies disagree by an order of magnitude on the loss (under 7% versus about 48%),
and the difference comes from what the "requirement" is and from how many faults each test uniquely exposes. A
coverage criterion keeps one test per requirement, and says nothing about what that test asserts. The 2002 paper's
conclusion is the cautionary one: do not trust coverage-equivalence as fault-detection-equivalence.

**Transfer: partial, and mostly as a warning.**

- Mainworthy's tests are mostly few tests per large scenario. Statement-level coverage minimisation on 230 files
  will find little to remove because browser tests share pages and the same lines, and what a browser test adds is
  often an interaction or a rendering state, not a new line.
- Coverage-only minimisation says a test is redundant when its lines are a subset of others'. That is a candidate list
  for a human, not a delete list. Combine with the failure history (section 3 and `methods.md`).
- The numbers (6% versus 48%) cannot be carried over; both studies used the Siemens-style C programs and seeded
  faults, not web apps.

---

## 2. Mutation score as a measure of a test's detection ability

**Just et al. (FSE 2014).** "Are Mutants a Valid Substitute for Real Faults in Software Testing?" Just, Jalali,
Inozemtseva, Ernst, Holmes, Fraser. ACM SIGSOFT Distinguished Paper.
<https://people.cs.umass.edu/~rjust/publ/JustJIEHF2014b-abstract.html> (abstract page returned 404 on fetch; text read
from the author's PDF copy, `sources/just.txt`) [read].

- 357 real, developer-fixed and reproduced faults in 5 Java programs (321 KLOC, 211 KLOC of tests, 20,109 tests in
  Table 1), 230,000 mutants. Developer-written and generated test suites (EvoSuite, Randoop, JCrasher).
- Mutant detection correlates with real fault detection with a statistically significant correlation, stronger than
  the correlation between statement coverage and real fault detection, controlling for coverage.
- Coupling effect: mutants are coupled to 73% of the real faults. About 10% of real faults need a new or stronger
  mutation operator. 17% are not coupled to any mutant.
- The generated suites detected 198 of the 357 faults in aggregate (Table of generated suites).

**Successors.**

- Chekam, Papadakis, Le Traon, Harman, ICSE 2017, "An empirical study on mutation, statement and branch coverage
  fault revelation that avoids the unreliable clean program assumption" [read; `sources/chekam.txt`]. Using real
  faults and recomputing suites per faulty version (they show the "clean program assumption" fails): strong mutation
  testing has the highest fault revelation; for statement, branch and weak mutation, more coverage has little or no
  effect on fault revelation until "relatively high" coverage levels are reached (a threshold effect).
  <https://discovery.ucl.ac.uk/10058915/7/Chekam_ICSE17.pdf>
- Petrović, Ivanković, Kurtz, Ammann, Just, "An Industrial Application of Mutation Testing: Lessons, Challenges, and
  Research Directions", Mutation workshop, 9 April 2018, pp. 47-53 [abstract]: 30,000+ developers, 1,890,442 change
  sets, four languages. The authors argue mutation adequacy is the wrong goal; the goal is "just make a test suite
  better". <https://research.google/pubs/an-industrial-application-of-mutation-testing-lessons-challenges-and-research-directions/>
- Petrović, Ivanković, Fraser, Just, "Practical Mutation Testing at Scale: A view from Google", IEEE TSE, August 2021
  (arXiv 2102.11378, 22 February 2021) [abstract]: mutate only changed lines and report in code review; 24,000+
  developers, 1,000+ projects; "orders of magnitude fewer mutants". Developers initially classed 85% of reported
  mutants as unproductive (from a search summary of the paper [second]); the system then selects operators by
  history and caps mutants per line and per review. <https://arxiv.org/abs/2102.11378>
- Ivanković, Petrović, Just, Fraser, "Code Coverage at Google", ESEC/FSE 2019, pp. 955-963 [abstract]: coverage for
  1 billion lines a day in 7 languages; a survey of 3,000 developers gave 512 responses. A secondary blog says the
  median coverage was about 80% and that coverage was not always seen as helpful [second].
  <https://research.google/pubs/code-coverage-at-google/>

**What it means for a single test.** Mutation score is a property of a suite over a region of code, not of one test.
For a single test, the useful derived quantity is its **unique kill set**: the mutants only this test kills. A test
with an empty unique kill set is redundant in the minimisation sense. A test with a non-empty unique kill set that
is high-value is justified. Stryker computes this directly when per-test coverage is on (see `methods.md`).

**Transfer: strong in principle, limited in practice here.**

- All the mutation studies are on Java. JavaScript/TypeScript mutation works (StrykerJS) but no study I found
  measured mutation-versus-real-fault correlation on a TypeScript web app. [unconfirmed: I searched and found none.]
- The 17% of real faults not coupled to any mutant is an upper bound on how much a mutation-based keep/delete
  verdict can miss. For a UI test the share is probably higher: a mutant on server code does not model a layout
  or a focus bug, which are exactly what a browser test exists to catch.
- Cost: a mutation run needs the whole suite many times. Google's diff-based answer (mutate only changed lines) is the
  design to copy, not a full-suite run.

---

## 3. Flaky tests

### 3.1 Luo, Hariri, Eloussi, Marinov, FSE 2014 [read; `sources/luo.txt`]

"An Empirical Analysis of Flaky Tests", pp. 643-653. FSE 2024 Test of Time runner-up.
<https://2024.esec-fse.org/details/fse-2024-plenary-events/10/An-empirical-analysis-of-flaky-tests>

- 201 commits that likely fix flaky tests, in 51 Apache projects.
- Top three root causes: Async Wait, Concurrency, Test Order Dependency (counts in its table: 74, 32, 19 of the
  inspected commits).
- 96% of flaky tests are independent of the platform. 34% of Async Wait flaky tests use "a simple method
  call with time delays to enforce orderings" (F.4); 54% were fixed with `waitFor` (F.8). 47% of Order Dependency
  flakes are caused by dependency on external resources (F.7), and 74% were fixed by cleaning the shared state
  between test runs (F.10).
- It warns against removing or disabling flaky tests, because they may reveal real bugs, and against "rerun until
  it passes".

**Transfer: high for browser tests.** The categories (waiting for UI, shared state, order) are the ones that make a
browser test costly. Mainworthy's rules already treat shared ports and directories as fixable defects, which fits
F.10.

### 3.2 iDFlakies, Lam, Oei, Shi, Marinov, Xie, ICST 2019 [read; `sources/idflakies.txt`]

- Ran 683 Java projects; 82 had at least one flaky test; 422 flaky tests, 50.5% order-dependent and 49.5% not.
- Method: rerun in the original order, then in shuffled orders; a test failing only in some orders is order-dependent.
- Dataset: <https://sites.google.com/view/flakytestdataset>

**Transfer: the technique transfers directly** (Bun can run a file set in a different order, and each file already
gets its own clone database). The 50% order-dependent share does not; it is a Java/Maven number.

### 3.3 DeFlaker, Bell, Legunsen, Hilton, Eloussi, Yung, Marinov, ICSE 2018 [abstract]

If a test fails and covers none of the changed code, report it flaky without rerunning. On project histories: 1,874
flaky tests from 4,846 failures, 1.5% false alarms, recall 95.5% versus 23% for Maven's default rerun detector. On
TravisCI: 96 Java projects, 87 previously unknown flaky tests in 10 of them.
<https://cs.cornell.edu/~legunsen/pubs/BellETAL18DeFlaker.pdf> (search summary [second] for the numbers)

**Transfer: good in design, thin in cost.** The differential-coverage rule needs per-test coverage for each commit.
For browser tests that coverage is expensive (it needs V8 coverage collection in each browser test). A cheaper proxy is
available (section 3.6 and `methods.md`).

### 3.4 FlakeFlagger, Alshammari, Morris, Hilton, Bell, ICSE 2021 [abstract + partial read]

- Reran 24 projects' suites 10,000 times each; even then, some previously identified flaky tests were not found.
- Predicts flakiness from test features (execution, coverage, test smells) without rerunning. On their dataset of 23 projects with flaky tests, it beat the
  prior classifier (by F1) on 16 projects and tied on 4; precision rose from 11% to 60% (as quoted in a search summary; the
  recall for FlakeFlagger itself I could not confirm) [second].
  `sources/ff2.txt` is the paper (author copy); my grep did not read the results tables.
- Follow-up, Flakify (Fatima, Ghaleb, Briand, IEEE TSE submission, arXiv 2112.12331 [read; `sources/flakeflagger.txt`; note this file is Flakify, not FlakeFlagger]): precision 70%,
  recall 90%, F1 79% on the FlakeFlagger dataset; "cross-validation"; 73% F1 per-project (3,862 test cases, 312 Java projects).

FlakeFlagger's introduction (read, `sources/ff2.pdf`) says: "Google has reported that 4.56% of test failures are
caused by flaky tests [1], and Microsoft's Windows and Dynamics products report a similar 5% [5]." Its reference [1]
is a Google source I did not open, so the 4.56% and 5% are [second]. The Flakify paper (`sources/flakeflagger.txt`)
repeats "almost 16% of their 4.2 million" tests, from the Google blog above.

**Transfer: low.** It is trained on Java and needs 10,000-run labels. The lesson is the baseline one:
rerunning is not a complete detector, and a predictor from static features has precision around 60-70% at best.
A human label is a stronger signal than any of these features; this is where Mainworthy has data these papers lacked.

### 3.5 Google

- John Micco, "Flaky Tests at Google and How We Mitigate Them", Google Testing Blog, 27 May 2016 [read the page
  chrome only; the body was not returned by my fetch tool]. From the search summary of the same post [second]:
  about 1.5% of all test runs report a flaky result; "almost 16%" of tests have some flakiness; about 84% of
  pass-to-fail transitions involve a flaky test. Mitigation: rerun only failing tests, mark known flaky tests so they
  fail only after 3 failures in a row. <https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html>
- Memon et al., "Taming Google-scale continuous testing", ICSE-SEIP 2017, pp. 233-242 [abstract + search summary]:
  very few tests ever fail; of 5.5 million affected tests analysed over a period, 63,000 ever failed (about 1.1%);
  tests that fail are "closer" to the code; code modified recently by more than three developers breaks more often.
  The paper's text I could download was an HTML wrapper, so I did not read the table myself. [second]
  <https://www.cs.umd.edu/~atif/pubs/Memon_2017_TGC_3103112.3103143-abstract.html>
- Google's presubmit reruns a failing test 10 times to label it flaky (as quoted in Luo et al. citing personal
  communication with John Micco) [read in Luo].

### 3.6 Microsoft

- Lam, Godefroid, Nath, Santhiar, Thummalapenta, "Root Causing Flaky Tests in a Large-Scale Industrial Setting",
  ISSTA 2019 [abstract]: instruments flaky tests and logs runtime properties of passing and failing runs, RootFinder
  compares the logs. <https://www.microsoft.com/en-us/research/publication/root-causing-flaky-tests-in-a-large-scale-industrial-setting/>
- Lam, Muslu, Sajnani, Thummalapenta, "A Study on the Lifecycle of Flaky Tests", 6 large Microsoft projects
  [abstract via search summary]: async calls the leading cause; some claimed fixes did not reduce failure frequency;
  FaTB cut test runtimes by up to 78% without materially changing flaky-failure frequency. Venue not confirmed
  (I believe ICSE 2020, [unconfirmed]). <https://www.microsoft.com/en-us/research/?p=671544>
- FlakeFlagger's intro (above) quotes a similar 5% share of failures for Microsoft's Windows and Dynamics [second].

### 3.7 Others

- Lampel, Just, Apel, Zeller, "When life gives you oranges", ESEC/FSE 2021 (industry): classify Mozilla CI job
  failures as bug versus flaky from job telemetry; precision 73% on average, recall 82% on average (up to 94%).
  [abstract] <https://www.se.cs.uni-saarland.de/publications/docs/LJA+21.pdf>
- Parry, Kapfhammer, Hilton, McMinn, "A Survey of Flaky Tests", ACM TOSEM 31(1), 2022 (accepted 2021): 76 papers
  reviewed. Cited industrial survey: 20% of respondents met flakiness monthly, 24% weekly, 15% daily. [abstract]
  <https://eprints.whiterose.ac.uk/id/eprint/230095/1/parry2021.pdf>
- Cost: an industrial case study puts developer time on flaky repairs at up to 1.28%; an ICST 2024 study puts lost
  productive time at about 2.5% for a 30-developer team (1.3% of it repair) [second, via a search summary of two
  papers I did not open]. <https://www.researchgate.net/publication/383471682_Cost_of_Flaky_Tests_in_Continuous_Integration_An_Industrial_Case_Study>
- UI-based flaky tests, "An Empirical Analysis of UI-based Flaky Tests", arXiv 2103.02669: argues earlier flaky-test
  research is almost all about unit tests. [abstract] <https://arxiv.org/pdf/2103.02669>
- A 2026 industry blog repeats a "10% flakiness for end-to-end versus under 1% for unit tests, Meta" figure. I could not
  trace it to a primary Meta paper. [unconfirmed] Do not cite.

**Transfer for flakiness as a whole.** All the large studies agree that flakiness is a property of a test plus its
environment, that the cost is dominated by reruns and by triage, and that a test that fails once in a hundred is
still costly at scale. At this repository's size (about 230 files, one CI run per PR) the cost is more likely to be
the **rerun and the trust** than the machine time. The working definition above already includes reruns and triage.

---

## 4. Predictive test selection

### 4.1 Meta (Facebook), Machalica, Samylkin, Porth, Chandra, ICSE-SEIP 2019 [read; `sources/pts.txt`]

"Predictive Test Selection", arXiv 1810.05286 (v1 11 October 2018, v2 29 May 2019).
<https://arxiv.org/abs/1810.05286>

- A gradient-boosted classifier picks, for each code change, the tests to run from the tests whose build
  dependencies include the changed files.
- Results: catches over 95% of individual test failures and over 99.9% of faulty changes, while selecting fewer than
  a third of the tests that build-dependency selection would pick, and cutting infrastructure cost by a factor of two.
- Features include file extensions, change history, and failure rates of the test over the last 7, 14, 28 and 56 days.
- Flakiness: training on raw outcomes gives "very poor predictions", so they re-run to de-flake the training labels;
  the paper says about the flake handling that the estimate of recall "should be treated as a lower-bound".
- The average change has about 1,000 dependent test targets; at the operating point the cutoff was 230 per change.

**Transfer: low for the model, high for the idea.** It needs thousands of changes a day to train. This repository has
a few PRs a day. What transfers is the observation that *recent failure history of a test* is the strongest single
feature, which is a plain query on stored results.

### 4.2 Google TAP

See 3.5 (Memon et al. 2017): 63K of 5.5M affected tests ever failed; Google proposed running the "always passing"
tests less often. Elbaum, Rothermel, Penix, "Techniques for improving regression testing in continuous integration
development environments", FSE 2014 is the earlier Google work (windowed prioritisation by recent failure); I did
not fetch it. [unconfirmed]

### 4.3 Microsoft

Azure DevOps Test Impact Analysis (the product) is treated in `competitors.md`. I did not find a peer-reviewed
Microsoft paper that I could read within this run.

### 4.4 Ekstazi, Gligoric, Eloussi, Marinov, ISSTA 2015 (ACM SIGSOFT Distinguished Paper) [abstract, via search summary]

Dynamic file-dependency regression test selection for Java: about 32% average end-to-end time reduction versus
running everything, about 54% for the longer-running suites. <https://users.ece.utexas.edu/~gligoric/papers/abstracts/GligoricETAL15Ekstazi.txt> [second]

**Transfer.** Selection is the cheap alternative to deletion: nothing is lost, the test just does not run when its
files did not change. Bun does not ship a dependency-based selector; a file-level one can be built from the import
graph (`methods.md`, method M7).

---

## 5. Test smells

- tsDetect, Peruma et al., "tsDetect: An Open Source Test Smells Detection Tool",
  ESEC/FSE 2020 tool demo: 19 smell types (not 21 as I first assumed), evaluated on a 65-file benchmark; average
  precision 96% and recall 97% (project page: precision 85-100%, recall 90-100%). [abstract]
  <https://testsmells.github.io/pages/testsmelldetector.html>
- Spadini, Palomba, Zaidman, Bruntink, Bacchelli, "On the Relation of Test Smells to Software Code Quality", ICSME
  2018, pp. 12-23: 221 releases of 10 systems, more than a million test cases, six smells. Smelly tests are more
  change-prone and more defect-prone than clean ones; production code exercised by smelly tests is more defect-prone.
  Indirect Testing, Eager Test and Assertion Roulette are most linked to change-proneness. [abstract]
  <https://repository.tudelft.nl/record/uuid:4555186f-113c-45c0-8b06-fb106295ae8e>
- FlakeFlagger found that adding a selected set of test smells improved Flakify's precision and recall (5 and 6
  percentage points) [read, `sources/flakeflagger.txt`].

**Transfer: the catalogues are for Java/JUnit; the smells that carry to TypeScript tests are
Conditional Test Logic, Sleepy Test, Eager Test, Assertion Roulette, Mystery Guest, Magic Number, Empty Test,
Ignored Test, Redundant Assertion, Unknown Test (no assertion).** A smell is a *refactor* signal, not a delete
signal: Spadini's result is that smelly tests are changed more, which is a maintenance cost that goes into the cost side of the definition.
The tsDetect numbers are about detecting the smell, not about whether the smell matters.

---

## 6. The test pyramid, the testing trophy, and the cost of end-to-end tests

- Mike Wacker, "Just Say No to More End-to-End Tests", Google Testing Blog, 22 April 2015 [page read, but the
  body was not returned; I only saw the comment section]. The post argues for few end-to-end tests: slow feedback, flaky,
  hard to debug, environment-dependent. Readers quote a 70/20/10 split (unit/integration/end-to-end); I could not
  find it in the post text itself. [unconfirmed; do not cite as Google's number]
  <https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html>
- The trophy (Kent C. Dodds, "The Testing Trophy and Testing Classifications") and Spotify's honeycomb are
  recommendations from practitioners, not measurements. I could not read the primary posts in this run; the secondary
  descriptions agree: static checks at the base, mostly integration tests in the middle, few end-to-end tests at the
  top. The line "Write tests. Not too many. Mostly integration." is credited to Guillermo Rauch in several secondary
  sources [second]. <https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications>
- **Evidence that decides it:** I did not find a controlled study of defect yield per layer on a web app. [unconfirmed]
  What exists is cost evidence: UI flakiness (arXiv 2103.02669), web GUI test issues dominated by flakiness and slowness
  (Information and Software Technology, 2025, <https://www.sciencedirect.com/science/article/pii/S0950584925002678>)
  [abstract via search summary], and Google's practice.

**Transfer.** The shape arguments are about cost per bug found. For this repository the cost side is measured
(`scripts/test-timings.json`: 81 browser files, 746 s). The yield side is the missing number, and no outside study
supplies it; it has to come from this repository's own failure history (the thread's other research slices).
The pyramid and the trophy disagree on the middle layer, not on the top: both say few e2e tests.

---

## 7. Kent Beck, Test Desiderata

Twelve properties; the list, read at <https://testdesiderata.com/> (page has no date or author in the text I
fetched; it links to Kent Beck's Medium essays, which carry the names): Isolated, Composable, Deterministic, Fast,
Writable, Readable, Behavioral, Structure-insensitive, Automated, Specific, Predictive, Inspiring. Stated trade-off: making a
test more predictive of production makes it slower. Beck's framing (essay on Medium, <https://medium.com/@kentbeck_7670/test-desiderata-94150638a4b3>):
no test needs all twelve, but give one up only for something of greater value.

**Use.** A test's verdict reasons map to the properties: *Fast* and *Deterministic* are the cost side; *Specific* is
triage cost; *Structure-insensitive* is edit cost; *Predictive* and *Behavioral* are the value side. This is a naming
scheme, not evidence, and it fits the five costs in the working definition.

---

## 8. Duplicate manual cases, AI-generated tests, and pruning

- Viggiato, Paas, Buzon, Bezemer, "Identifying Similar Test Cases That Are Specified in Natural Language", arXiv
  2110.07733 (14 October 2021; TSE): text embedding, similarity and clustering over test steps; 5 embedding
  techniques, 2 similarity metrics, 2 clustering methods; F-score 87.39% for clustering similar steps and 83.47% for
  identifying similar test cases, on an industrial suite; developers saw uses for finding redundant and legacy
  cases. [abstract] <https://arxiv.org/abs/2110.07733>
- Flemström et al., Mälardalen University: similarity function over 65,000 manual test steps with Postgres string
  functions; clusters could be reduced further on manual inspection. [second]
  <https://www.es.mdu.se/publications/4713-Tech__Report__Similarity_Function_Evaluation>
- A QualityLogic white paper applied Jaccard and cosine similarity to 5,000 manual regression cases to find
  consolidation candidates. Vendor material, not peer-reviewed. [second]
  <https://qualitylogic.com/wp-content/uploads/2019/06/QL-Case-Study-Similarity-Analysis-Using-AI.pdf>
- AI-generated test pruning: I found no rigorous empirical study. [unconfirmed] The closest are LTM (section 1),
  an LLM-unit-testing survey with a test-minimisation section (arXiv 2506.15227) and single-author tool anecdotes
  (a dev.to post claiming 72% removable in a 54-test AI-generated suite: one tool author's anecdote, not evidence).
- MinHash: Broder's min-wise hashing (1997) estimates Jaccard similarity of shingle sets cheaply. I did not need a source
  that applies it to test cases; the method is in `methods.md` (M5) with its original citation.

**Transfer: strong for manual cases, because Mainworthy stores case text, and the Viggiato pipeline shows plain text
similarity gets to 80%+ F-score on someone else's labelled pairs.** The caveat is that F-scores were measured against
labels from that company's engineers. A similarity score is a candidate generator and needs a human "duplicate" label
(Mainworthy's own answer kind `duplicate`, see `docs/open-questions.md` question 22).

---

## 9. What an outside signal does and does not tell you about *one test*

| Signal | Source | Tells you | Does not tell you |
| --- | --- | --- | --- |
| Never failed in N runs | TAP (63K of 5.5M ever failed) | cheap to run less often | the test is worthless: a smoke test also never fails |
| Failure history, recent | Meta PTS features (7/14/28/56 days) | which tests to run first | why it failed |
| Unique kill set | Just 2014, Stryker | what only this test catches in the mutants modelled | UI/layout faults (17% uncoupled) |
| Coverage subset | HGS family | candidate for merging | fault detection equivalence (Rothermel 2002) |
| Flaky rate | Luo, Google, DeFlaker | cost of reruns | whether the flake hides a real bug |
| Smells | Spadini 2018 | edit cost | whether the test finds bugs |
| Text similarity | Viggiato 2021 | candidate duplicates (manual) | whether the two cases differ in intent |

---

## 10. Missing evidence (stated plainly)

- Defect yield per layer for a web app. None found.
- Mutation-versus-real-fault correlation on TypeScript. None found.
- A rigorous study on pruning AI-generated tests. None found.
- Microsoft's predictive test selection or TIA numbers from a primary source. Not read.
- Whether a human's labelled reason for a failure (defect / test / flaky / infra / expected) improves any of the above.
  No study uses one; the closest is Lampel 2021, which classifies from telemetry, and Meta's de-flaking by rerun.
  That gap is where this product would differ from everything above (see `competitors.md`).

---

## 11. Summary for a 230-file TypeScript suite

1. Every outside study agrees that the failure history of a test is the cheapest strong signal. Use it first.
2. Coverage-only redundancy is a candidate generator. The classic studies disagree by 6% versus 48% on the loss.
3. Mutation is the best published proxy for fault detection, but costs full-suite runs; do it on changed lines.
4. Flakiness is mostly waiting, shared state and ordering (Luo 2014), and the fix is in the test, not deletion.
5. Pyramid versus trophy is untested outside practitioner opinion; use the measured cost here.
6. For manual cases, text-similarity clustering is the one method with reported F-scores around 83-87% on real data.

## 12. Evidence against the working definition of value

- **A test that never fails is not worthless.** TAP shows most tests never fail, and the lesson was run them less
  often, not delete them. A smoke or invariant test is valuable because it fails rarely.
- **A test's value depends on the others.** "Defects only this test catches" is the unique-kill definition; adding a
  second similar test makes the first one look redundant and the second one too. Minimisation must be done greedily
  and re-evaluated, not scored once per test (HGS, section 1).
- **Flaky tests can hide real bugs** (Luo 2014): a flake's failure may be real. Cost-only scoring would delete
  exactly the tests whose failures need investigating.
- **Edit cost and readability matter apart from defects** (Spadini 2018, Beck's Readable and Structure-insensitive).
  A test that never breaks but forces 30 lines of change on every refactor has a cost no failure log shows.
- **Mutation's own critics at Google:** adequacy is the wrong goal; the right goal is a suite that is better, not
  mutation-adequate (Petrović 2018). So a low mutation score is a prompt, not a verdict.
- **Detection ability is not the only reason to run a test.** Documentation of behaviour and regression confidence
  at release time are real benefits that no study above puts a number on.
