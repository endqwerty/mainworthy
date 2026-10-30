# Competitors: what they show or recommend about test health, redundancy, staleness and retirement

Read 2026-10-29 from vendor pages (URLs below, fetched that day). Labels: **[read]** I fetched the vendor page and it
says this; **[search]** a web-search summary of the vendor page, not read by me; **[not found]** I looked and the
page does not say it (which is weaker than "the product does not do it": product behaviour behind a login or in other
docs pages was out of reach).

What this repository already has, so I do not repeat it: `docs/competitive-analysis.md` (13 test management tools,
pricing, verified/reported) and `docs/strategy-review.md` section 3.2 (Buildkite, CircleCI, Datadog, Azure DevOps,
Sentry, GitHub flaky detection and quarantine, plus the one-line mention of Trunk, Mergify, Currents, Cypress Cloud,
BrowserStack, Develocity, CloudBees Smart Tests, ReportPortal). Neither says what each tool *recommends doing* with a
test, or what it shows about slow, never-failing, redundant or stale tests. That is what this file adds.

---

## 1. Feature matrix: automated-test health

Cell values: **yes** = documented on the page I read; **partly** = something close, described below;
**no** = I read the page and it is not there; **?** = not established.

| Capability | Datadog Test Optimization | Trunk Flaky Tests | CloudBees Smart Tests (Launchable) | BuildPulse | Currents | Develocity |
| --- | --- | --- | --- | --- | --- | --- |
| Flaky detection | yes (Early Flake Detection on new tests; flaky-test management) | yes (monitors: Pass-on-Retry, Failure Rate, Failure Count) | yes (flakiness score) | yes, from CI results, no SDK | yes (analytics) | yes (`FLAKY` outcome: fail then pass in one execution) |
| Quarantine | yes, per policy (Quarantined: keeps running, does not fail CI) | yes, auto or manual | yes (isolate noisy tests from the critical path, keep history) | yes, auto for "the worst offenders" | yes (Actions: alert, skip, quarantine) | not on the page I read |
| Disable / skip | yes ("Disabled": skipped in CI) | quarantine instead of disabling | not stated | not stated | yes (skip) | not stated |
| Auto-release from quarantine | yes: "Fixed" after 30 days with no flake (not customisable) | ? | ? | ? | ? | ? |
| Predictive or impact-based selection | yes: Test Impact Analysis (per-test coverage vs changed files) | no | yes: test prioritisation, shows what ran and was skipped | no | partly: "CI Optimization", Test Orchestration | yes (Predictive Test Selection, product page only [search]) |
| Never-failing tests report | no | no | yes: "Never Failing Tests", needs 5+ runs a week | no | no | not found |
| Slowest-tests report | no (total test time only) | not found | yes: "Longest Tests" | not found (build duration per repo) | not found | not found |
| Most-failed tests | via flaky and failure rate | yes (dashboard list) | yes: "Most Failed Tests" | yes (disruption counts) | yes | not found |
| Stale / obsolete test detection | no | no | no | no | no | no |
| Redundancy / duplicate detection | no | no | no | no | no | no |
| Retirement guidance | "Disabled" state | none given | "repair or remove" flaky; for never-failing, "move to the right" (run less often) | none | none | none |
| Ticketing | yes (work item, Jira) | yes (Jira, Linear, webhooks) | triage grouping | owner insights | ? | ? |
| Cost / waste estimate | yes: Time Wasted in CI, Time Saved, Pipelines Failed by flaky vs non-flaky | PRs affected, PRs rescued | CI waste calculator, observation mode | CI Waste Calculator ("$280K/yr" headline) | ? | ? |

Sources and the lines that decide each cell:

- **Datadog Flaky Test Management** <https://docs.datadoghq.com/tests/flaky_management/> [read]. Four states: Active
  ("known flaky and still running in CI"), Quarantined ("keeps running, but failures don't affect CI status"),
  Disabled ("skipped entirely in CI"), Fixed ("has passed consistently"). Policies per repository: Quarantine triggers
  on how long a test has been Active, flaking on specified branches, or a 7-day failure rate threshold; Disable has
  similar triggers; "Attempt to Fix" retries on the fix commit; "Fixed" moves a test after 30 days without
  flaking, "can't be customized". Impact metrics: pipeline failures, CI time wasted, failure rate.
- **Datadog Test Impact Analysis** <https://docs.datadoghq.com/tests/test_impact_analysis/> [read]. Per-test coverage
  vs changed files; JavaScript supported. Limits: analyses up to the 100 most recent commits; commits changing more
  than 5,000 files are not analysed; tests covering more than 16,000 files are not skipped; "can't detect changes in
  library dependencies, compiler options, external services, or data files"; `ITR:NoSkip` to force all tests. The
  page does not mention unused, slow or obsolete tests.
- **Datadog Test Health** <https://docs.datadoghq.com/tests/test_health/> [read]. Summary metrics: Pipelines Failed,
  Time Wasted in CI, Pipelines Saved, Time Saved in CI. Recommendations are to turn on Auto Test Retries and Test Impact
  Analysis, with an estimated reduction. "The page doesn't cover" slow, redundant or unused tests.
- **Trunk detection** <https://docs.trunk.io/flaky-tests/detection> and overview <https://docs.trunk.io/flaky-tests>
  [read]. Three monitors classify a test as flaky or **broken** ("fail consistently at a high rate and need real
  fixes rather than quarantining"); broken outranks flaky. Detection within 20 minutes of upload. **Flag as Flaky**
  is a persistent manual override from the test page; muting a monitor for a test lasts 1 hour to 30 days. The page
  names no retirement or deletion guidance. 2025-09-09 changelog: auto-quarantine no longer applies to broken tests
  <https://docs.trunk.io/changelog/2025-09-09-flaky-tests-auto-quarantine-no-longer-applied-to-broken-tests> [search].
- **Launchable / CloudBees Smart Tests, Unhealthy Test Insights** <https://help.launchableinc.com/features/unhealthy-tests/>
  [read]. Four insights: Flaky Tests (flakiness score = probability a test fails but later passes on rerun; needs a retry
  mechanism; "repair or remove"), **Never Failing Tests** ("may take up execution time without adding value"; a test
  must run at least five times a week to be included; "consider moving it 'to the right' so it runs less
  frequently"), Longest Tests (no threshold stated), Most Failed Tests ("suspicious"; causes to investigate:
  flakiness, fragility or high maintenance, or testing too many things at once). The vendor's current product page
  <https://www.cloudbees.com/capabilities/cloudbees-smart-tests> [read] lists "test behavior analysis" (flaky,
  long-running, consistently reliable tests), quarantine, an "Observation mode" that runs beside the pipeline, "up to
  80% reduction in test execution time", and "AI-powered failure triage".
- **BuildPulse** <https://buildpulse.io/> [read]. Flaky detection from CI results with no annotations or SDK; the
  worst offenders auto-quarantined; per-repo pass rate, build duration, flaky disruption; a CI waste calculator.
- **Currents** <https://docs.currents.dev/> [read]. Flakiness, regressions and trends over time; Test Suite Explorer
  "to discover problematic tests"; Actions can alert, skip or quarantine; Test Orchestration. The page says nothing
  on stale or obsolete tests, and the overview names no "test health" feature.
- **Develocity** <https://docs.develocity.ai/2026.2/guides/flaky-test-detection-guide/index.md> [read]. A test outcome
  is `FLAKY` if it fails and then passes in one execution; shown in the Build Scan and the Tests Dashboard; detection
  by retries; "Test Failure Analytics" identifies the most severe flaky tests. Named views, quarantine, slow-test and
  never-failing views are not on the page I read.

---

## 2. Feature matrix: manual cases (test management)

| Capability | TestRail | Qase | Xray | Zephyr (Scale) | Testmo |
| --- | --- | --- | --- | --- | --- |
| Case lifecycle status | ? (page blocked) | yes: Status `Active` / `Draft` / `Deprecated` | workflow is user-defined; communities use "Deprecated" | defaults Approved / Draft / Deprecated, project-scoped [search] | ? |
| Flaky flag on a case | ? | yes: `Is Flaky` ("Flag unstable test cases"), `Is Muted` [search] | not found | not found | derived for automation: `flaky_percent` in the API [search] |
| Layer field | ? | yes: `Layer` = End-to-end, API, Unit | not found | not found | not found |
| Automation status | ? | yes: Manual / Automated, plus "To be automated" | via test type | via automation link | automation linking of cases to runs |
| Archive a case | not established | not established (Deprecated status) | no per-version archive [search] | archives a case with all its versions; no single-version archive [search] | not found |
| Reports on duplicate or stale cases | no (report list below) | not found | not found | not found | not found |
| Reports | Coverage for References, Summary for Cases/References (Defects), Comparison for Cases (Results), Activity Summary (Cases), Property Distribution (Results), Workload Summary (Users) [search] | analytics with QQL queries [search] | Jira-based | Jira-based | "flaky, slow, and often-failing automated tests" via automation linking [search] |

Sources: Qase fields <https://docs.qase.io/administration/workspace-management/fields> [read: "Status: Active, Draft,
or Deprecated", "Layer: End-to-end, API, or Unit", "Is Flaky: Flag unstable test cases"]; TestRail reports
<https://support.testrail.com/hc/en-us/articles/9285210470420> [search; the page itself returned 403 to me];
Zephyr/Xray archive behaviour from Atlassian and SmartBear community answers
<https://community.smartbear.com/discussions/zephyrscale/test-case-version/233881> and
<https://community.atlassian.com/forums/Jira-questions/How-to-delete-archive-version-of-test-case/qaq-p/2977782>
[search; community answers, not official docs]; Testmo <https://docs.testmo.com/docs/automation/advanced/automation-linking>
[search; the redirected help-center page returned 403]; Testmo automation runs: completed runs are archived after an
admin-set period, keeping only the first 50 failing tests without comments [search]
<https://support.testmo.com/hc/en-us/articles/47713806374797-Automation-Runs>.

TestRail (Enterprise), Xray, Qase and the rest: `docs/competitive-analysis.md` already records pricing and history
gating; I could not add more on TestRail or Xray than the report names above.

---

## 3. What they recommend doing with a test (the verdict vocabulary)

| Vendor | Verdicts they offer a human or a policy |
| --- | --- |
| Datadog | Active, Quarantined, Disabled, Fixed (policy-driven; a human can set the state) |
| Trunk | healthy, flaky, broken; manual Flag as Flaky; mute a monitor 1 h to 30 d |
| CloudBees Smart Tests | repair or remove (flaky), move to the right (never failing), investigate (most failed) |
| BuildPulse | quarantine, then fix |
| Currents | alert, skip, quarantine |
| Qase | Active, Draft, Deprecated; Is Flaky; Is Muted |
| Zephyr / Xray | Approved/Draft/Deprecated (Zephyr defaults); archive whole case |

The shared vocabulary is **quarantine, disable, fix, deprecate, move later**. Nobody offers **merge**
(two tests into one), **move down a layer** (an end-to-end test to an API or unit test), or **delete as redundant**,
except by telling the user to "remove" in prose. The only layer concept found is Qase's `Layer` field, which is a
label on a manual case, not a verdict.

---

## 4. What none of them do

1. **They infer; they do not ask.** Every flaky detector above decides from outcomes (pass-after-fail on the same
   code, failure rate over a window, coverage diff). The only human input I found is Trunk's "Flag as Flaky", a
   boolean override, and Datadog's manual state change. None records *why* a failure happened (defect in the product,
   defect in the test, expected change, flaky, infrastructure) as a labelled answer attached to the failure.
   Mainworthy's answer kinds are exactly that (`docs/product-design.md` line 727 area; kinds `failure`, `flaky`).
   [Based on the pages above; a login-only feature could differ.]
2. **No one tells a never-failing test from a valuable invariant.** Smart Tests lists Never Failing Tests and says
   "consider moving it to the right". That is a cost verdict with no value evidence. A labelled history
   ("this test failed 3 times and each was a real defect") is the missing value side.
3. **No redundancy or duplicate detection for automated tests** in any of the six CI/test-health products. For manual
   cases the research exists (Viggiato 2021, `literature.md` section 8) and I found no product page that reports it.
4. **No stale-test detection** (a test whose subject no longer exists, or that has not been edited or failed in a
   year). Not in any page above.
5. **Impact analysis is about running less, not about deleting.** Datadog's Test Impact Analysis and Smart Tests'
   prioritisation keep every test and skip it for some commits. Datadog documents the failure mode: changed
   dependencies, data files and external services are invisible to it.
6. **No tool joins manual and automated at the verdict level.** Testmo's automation linking and Qase's
   `Automated` status link a manual case to automated runs, but none proposes "this manual case duplicates that
   automated test, retire one".
7. **Flakiness definitions differ and are not portable.** Develocity: fail then pass in one execution. Launchable: a
   probability of failing then passing on rerun, needs retries. Trunk: three configurable monitors. Datadog: policy
   thresholds. A migration from one to another changes which tests are "flaky".

## 5. Not established

- TestRail, Xray and Zephyr official docs on case cleanup: pages blocked (403) or not surfaced; only community answers.
- Testmo's flaky thresholds and the exact wording of its pages: help-center article returned 403.
- Develocity's named dashboard views for slow or never-failing tests: not on the page I read.
- Pricing and free tiers: left to `docs/strategy-review.md`.
- Whether any vendor uses a human-labelled failure reason in a non-public or paid-tier feature. I can only say the
  public documentation I read does not.
