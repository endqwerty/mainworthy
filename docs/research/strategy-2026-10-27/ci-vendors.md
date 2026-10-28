# CI and observability vendors: test features that compete with Mainworthy

Research worker, 2026-10-27. Primary sources only unless marked "reported". "verified 2026-10-27" = read on the vendor page today (WebFetch summary of the page, not a screenshot). Tool-summarised pages can miss detail; items flagged "not stated on page" were not found, not proven absent.

## 1. CircleCI

**Product names today**
- Test Insights (Tests tab in Workflow Insights): https://circleci.com/docs/guides/insights/insights-tests/ (verified 2026-10-27)
- Smarter Testing (intelligent test selection via Test Impact Analysis, dynamic test splitting, dynamic parallelism, auto-rerun failed tests, test analytics dashboard): https://circleci.com/blog/smarter-testing-stop-running-tests-that-dont-matter/ (verified 2026-10-27; page says "Last Updated Oct 27, 2026"; its FAQ calls these GA). Docs setup guide: https://circleci.com/docs/guides/test/getting-started-with-smarter-testing/index.md (verified 2026-10-27, last updated 2026-10-13, does not say GA or beta).
- Chunk by CircleCI (AI agent, "Fix Flaky Tests" task, beta): https://circleci.com/docs/guides/test/fix-flaky-tests/index.md (verified 2026-10-27)
- CircleCI MCP server: https://circleci.com/blog/circleci-mcp-server (verified 2026-10-27)

**What it does**
- Ingest: tests must run in CircleCI and use the `store_test_results` step; Smarter Testing requires JUnit XML matched to `outputs.junit` in `.circleci/test-suites.yml` (getting-started guide, verified 2026-10-27). From Sept 14, 2026 CircleCI enforces valid JUnit output for Smarter Testing suites (changelog: https://circleci.com/changelog/junit-output-requirements-for-smarter-testing-action-required-by-september-14/ , surfaced by search snippet only, page not fetched).
- History per test: Test Insights shows most recent 100 runs and a performance summary (insights-tests page, verified 2026-10-27). The Smarter Testing dashboard shows skip rates, run-time trends, per-test history, and which tests ran or were skipped per commit (blog, verified 2026-10-27).
- Flaky detection: a test is FLAKY if it "failed and passed on the same commit in a 14-day window"; labelled FLAKY in the app (insights-tests page, verified 2026-10-27). Same-commit flip method, no retry needed.
- Quarantine/mute: no quarantine feature found on the Smarter Testing blog or Test Insights page (not stated on page). Auto Rerun Failed Tests retries failures; the getting-started guide says it "automatically retry flaky tests".
- Test impact / selection: yes, TIA-based Intelligent Test Selection; needs a first full analysis run (blog, verified 2026-10-27).
- Manual test cases: none found.
- Release readiness view: none found.
- Traceability to requirements/issues: none found.
- API: Insights API exposes flaky and slowest tests ("reported" via support article https://support.circleci.com/en/articles/15091114-how-to-get-information-about-flaky-and-slowest-tests-via-the-insights-api, from search listing only); test metadata endpoint mentioned in the fix-flaky-tests search summary.
- MCP / AI: MCP server tools include `find_flaky_tests` (added 2025-04-10), `get_job_test_results` (2025-04-30), `get_build_failure_logs`, `run_pipeline`, `rerun_workflow` etc. (blog, verified 2026-10-27). Chunk: AI agent that finds flaky tests, generates fixes, validates by repeated runs, opens GitHub PRs; beta, GitHub orgs only, "Beta has no extra costs. Chunk uses CircleCI credits and your AI model provider tokens", "Chunk tasks will be a paid feature when generally available" (verified 2026-10-27).

**Price and packaging** (https://circleci.com/pricing/ , verified 2026-10-27)
- Free $0: 30,000 credits/month, 5 active users; flaky test detection limited to 5 tests.
- Performance from $15/month: unlimited flaky detection; extra credits $15 per 25,000; extra users $15/month.
- Scale: custom, annual.
- Smarter Testing paid features billed in test atoms: 1,000 included on Free, 10,000 Performance, 100,000 Scale; then 3,000 credits per 100,000 test atoms (also in blog, verified 2026-10-27). Static splitting, rerun-failed-only and running tests are free on every plan.
- Basis: credits (compute + active users + add-ons). Not per committer.

**Notable 2025-2026 changes**
- 2025-04: MCP server and `find_flaky_tests` (blog above).
- 2025-12-01: "Smarter Testing" blog post (https://circleci.com/blog/smarter-testing/ , date from search listing only; the product was announced beta earlier per https://circleci.com/changelog/smarter-testing-now-in-beta-for-all-cloud-customers/ , not fetched).
- 2026-09-14: JUnit output enforcement for Smarter Testing (changelog, search listing).
- 2026-10: Smarter Testing blog (updated 2026-10-27) calls the features GA and lists pricing by test atom (verified 2026-10-27). The docs setup guide does not state GA, so maturity labelling is inconsistent across pages.
- Chunk: beta, to become paid (docs above).
- Reported only (secondary site, unchecked against CircleCI): a July 2026 aggregator says CircleCI now recommends the MCP server built into its CLI and the standalone one is deprecated. The CircleCI MCP docs page returned 404 at the URL I tried; not confirmed.

**Other-CI lock-in**: strong. Test Insights requires OAuth GitHub/Bitbucket Cloud orgs and CircleCI jobs (insights-tests page, verified). Smarter Testing and Chunk use `circleci testsuite`/`store_test_results`; neither page mentions other CI systems (not stated on page). Treat as CircleCI-only.

---
## 2. Buildkite

**Product names today**
- Test Engine (formerly "Test Analytics"; the old changelog slug "189-test-analytics-now-automatically-detects-flaky-tests" shows the older name, https://buildkite.com/changelog/189-test-analytics-now-automatically-detects-flaky-tests , from search listing). Docs: https://buildkite.com/docs/test-engine (verified 2026-10-27). Pricing: https://buildkite.com/pricing/ (verified 2026-10-27). Shown as "Tests" on the pricing page.
- bktec CLI (splitting and quarantine application), Tests Buildkite plugin / collectors, Buildkite MCP server (https://buildkite.com/docs/apis/mcp-server , verified 2026-10-27).

**What it does**
- Ingest: Tests plugin, framework collectors (RSpec, Jest, pytest, Go, .NET etc.), JUnit XML import, JSON import. JUnit via direct API upload "works from any CI" with docs examples for Buildkite, CircleCI, GitHub Actions; max 5,000 results per file; JUnit lacks span detail (https://buildkite.com/docs/test-engine/test-collection/importing-junit-xml , verified 2026-10-27). Overview: "also accepts results from non-Buildkite CI systems" (docs overview, verified).
- History per test: reliability, duration, ownership over time; history window is plan-limited (pricing page: Free 24 hours, Pro 7 days, Enterprise 28 days, verified 2026-10-27; as read from the tool summary, numbers look odd but are as returned). Uploaded execution data stored in S3, deleted after 120 days (docs overview, verified).
- Flaky detection: Workflows with monitors. Three models: passed on retry, transition count, probabilistic flakiness score (changelog 308, dated 2025-09-30: https://buildkite.com/resources/changelog/308-test-engine-workflows/ , verified 2026-10-27). Transition count works without job retries (flaky-tests docs https://buildkite.com/docs/pipelines/configure/tests/flaky-tests , verified). Alarm actions: flaky label, webhook, Slack, Linear issue, change state to muted or skipped. "New Test" monitor added later (changelog 317, search listing).
- Quarantine/mute: yes. States enabled/muted/skipped. Muted tests still run, failures do not fail the build; applied in builds via bktec or the REST API (https://buildkite.com/docs/test-engine/test-suites/test-state-and-quarantine , verified 2026-10-27). Pro: test state management, manual or API quarantine. Enterprise only: automatic quarantine via "Change state" workflow actions.
- Test impact / selection: no impact analysis found; bktec splits tests across agents (docs overview, verified). Dynamic skip of unaffected tests not stated.
- Manual test cases: none found on Test Engine docs or pricing.
- Release readiness view: none found.
- Traceability: Linear issue creation from flaky workflow; no requirement links found.
- API: REST API for suites, tests, state changes; webhooks (docs overview, verified). Build tests API (changelog 398 via search listing).
- MCP / AI: MCP server (open source local plus hosted remote at https://mcp.buildkite.com/mcp) has a Test Engine toolset. `list_tests` (reliability and duration sorting, filters) added 2026-08-12 in MCP v1.18.0, scope `read_suites` (https://buildkite.com/resources/changelog/391-buildkite-mcp-server-can-now-find-your-slowest-and-flakiest-tests/ , verified 2026-10-27). Pricing page mentions "Agentic workflows" as building blocks for AI-powered CI; no AI test authoring.

**Price and packaging** (pricing page, verified 2026-10-27)
- Free: 250k test executions/month, 24-hour history, test splitting, no workflows.
- Pro: $30 per active user/month; 1M executions included then $15 per extra million; "1 workflow" listed on the pricing page (but the 2025-09-30 changelog says Pro and Enterprise get up to 3 workflows per suite: discrepancy between vendor pages); flaky identification and labelling.
- Enterprise: custom; custom quarantine rules.
- Basis: per active user plus executions. Ingesting is optional ("Ingesting this data is optional").
- Pipelines (their CI) priced separately: Free up to 5 users, Pro $30 per active user.

**Notable 2025-2026 changes**
- 2025-09-30: Test Engine Workflows launched (changelog 308).
- 2026-08-12: `list_tests` MCP tool (changelog 391).
- Later 2025-2026: New Test monitor, Build tests API and MCP tool (changelog 317, 398; search listings, undated here).
- Rename Test Analytics to Test Engine (date not verified; from search listing titles only).

**Other-CI lock-in**: low. Docs state Test Engine accepts results from non-Buildkite CI, via API upload (verified 2026-10-27). Quarantine application in a foreign CI needs bktec or custom scripts querying the REST API; bktec support varies by framework.

---
## 3. Azure DevOps (Microsoft)

**Product names today**
- Azure Test Plans (manual and exploratory testing; part of Azure DevOps Services and Server): https://learn.microsoft.com/en-us/azure/devops/test/overview (verified 2026-10-27; page ms.date 2026-08-14)
- Test Analytics in Azure Pipelines: https://learn.microsoft.com/en-us/azure/devops/pipelines/test/test-analytics (verified 2026-10-27)
- Flaky test management in Azure Pipelines (Services only): https://learn.microsoft.com/en-us/azure/devops/pipelines/test/flaky-test-management (verified 2026-10-27)
- Azure DevOps MCP Server (local and hosted remote): https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server (verified 2026-10-27; page dated 2026-09-21)

**What it does**
- Ingest automated results: `PublishTestResults@2` task accepts JUnit (incl. PHPUnit), NUnit 2/3, xUnit 2, VSTest/TRX, CTest (https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/publish-test-results-v2 , verified 2026-10-27). It is an Azure Pipelines task. A REST API exists for test results (flaky page links Result Meta Data and Get Test Result APIs); I did not verify whether results can be pushed from another CI without an Azure Pipelines run.
- History per test: top failing tests report, default 14-day range, per-test drill-down with daily pass/fail, group-by test file (test-analytics page, verified). Docs state "Test analytics is currently available only with Azure Pipelines."
- Flaky detection: system detection = rerun failed tests in the same pipeline run (VSTest task rerun) or rerun failed jobs; fail then pass = flaky. Custom detection via API (Result Meta Data - Update). Manual mark/unmark flaky. Option to exclude flaky failures from the test summary so they do not fail the pipeline (flaky page, verified 2026-10-27). Not a same-commit-history method; rerun-based. Services only, not Server.
- Quarantine/mute: the "suppress flaky failures from the summary / pass percentage" option is the closest thing; applies to the VSTest and Publish Test Results tasks, other cases need a custom script (flaky page, verified). No named quarantine state.
- Test impact / selection: not on the pages I read. (From memory, unchecked: Azure DevOps has a "Test Impact Analysis" option on the VSTest task for .NET.)
- Manual test cases: yes, the deepest of the vendors here. Test plans, static / requirement-based / query-based suites, test cases with steps and expected results, shared steps, shared parameters, configurations, Test Runner with screenshots / screen recording / action logs, bugs auto-filed with diagnostics, user acceptance testing, Test & Feedback browser extension for exploratory, stakeholder feedback (overview page, verified 2026-10-27).
- Release readiness view: Progress report hub across plans and suites; Deployment status widget (pass rate per environment); Test Results Trend (Advanced) widget (overview page, verified).
- Traceability: strong. Test cases link to user stories, features, bugs; Requirements quality widget shows pass rate per requirement and untested requirements; bugs auto-link to requirement and build (overview page, verified).
- API: REST APIs for test plans, runs, results (overview page, verified).
- MCP / AI: remote MCP at `https://mcp.dev.azure.com/{organization}` (Entra ID OAuth) with a `testplan` toolset: list plans/suites/cases; create plan, suite, case; update steps; create run and update results; complete run. Local server uses PAT or Entra. Claude Desktop and Codex cannot use the remote one (no dynamic client registration); Claude Code and Cursor need a custom Entra app registration. Not Entra-backed orgs (standalone MSA) unsupported for remote (MCP page, verified 2026-10-27). First announced as public preview in sprint 258 (2025) per https://learn.microsoft.com/en-us/azure/devops/release-notes/2025/sprint-258-update (search listing, not fetched; "reported" for the date).

**Price and packaging** (https://azure.microsoft.com/en-us/pricing/details/devops/azure-devops-services/ , verified 2026-10-27; second fetch confirmed)
- Basic: first 5 users free, then $6 per user per month.
- Basic + Test Plans: $52 per user per month. Creating and managing test plans needs this level; Basic can run tests in Test Runner and add/run tests from the board; Stakeholder (free) has exploratory testing only.
- Test Analytics, flaky management and the Tests tab ship with Azure Pipelines. Pipelines free allowance: 1 Microsoft-hosted job with 1,800 minutes/month, 1 self-hosted job with unlimited minutes; extra parallel jobs $40 (hosted) / $15 (self-hosted).
- Basis: per user per month (named seat) plus parallel jobs. Not per committer.

**Notable 2025-2026 changes**
- 2025: Azure DevOps MCP Server public preview (sprint 258; reported via search listing).
- 2026-01: New Test Run hub generally available for Services (https://devblogs.microsoft.com/devops/the-new-test-run-hub-is-going-generally-available/ , search listing; blog headed "December 22nd, 2025").
- 2026-04-22: "Actual Result" per step in manual runs, public preview (devblogs listing); Sprint 273 release note confirms (https://learn.microsoft.com/en-us/azure/devops/release-notes/2026/testplans/sprint-273-update , verified 2026-10-27, dated 2026-05-05). Configured per test plan: disabled / optional / required.
- Timeline lists future Test Plans items (exploratory session entry point, import wizard, test point history), no dates ("reported", search summary).
- No sunset of Test Plans found. Cloud load testing is deprecated in favour of Azure Load Testing (overview page note, verified).

**Other-CI lock-in**: Test Analytics and flaky management are Azure Pipelines only per the docs (test-analytics page: "currently available only with Azure Pipelines"). Manual Test Plans do not need Azure Pipelines. Repos can be elsewhere (not verified here).

---
## 4. Sentry (and Codecov test analytics)

**Headline finding: the Sentry side of this is in flux or gone, and the product is now Codecov's.** The "Sentry Prevent" name appears only in search-result snippets for a Sentry docs page I could not load. Codecov was sold by Sentry to Harness on 2026-06-02.

**Product names today**
- Codecov Test Analytics (failed test reporting, flaky test detection): https://about.codecov.io/ (verified 2026-10-27; logo reads "Codecov by Harness", footer "(c) 2026 Harness Inc."). Docs: https://docs.codecov.com/docs/test-analytics (verified 2026-10-27).
- "Sentry Test Analytics" / "Sentry Prevent CLI" / `getsentry/prevent-action`: seen in search listings for https://docs.sentry.io/product/test-analytics and https://docs.sentry.io/product/test-analytics/sentry-prevent-cli/ (search snippet said "beta", undated). **Both URLs returned "Page Not Found" when fetched on 2026-10-27**, as did /product/prevent/, and docs.sentry.io/llms.txt lists no Prevent or Test Analytics page. So I cannot verify that Sentry still offers it under that name. Treat as "reported, possibly removed or moved after the Codecov sale".
- Sentry pricing page (https://sentry.io/pricing/ , verified 2026-10-27) does not mention Prevent, test analytics or Codecov.

**What it does (Codecov Test Analytics, docs verified 2026-10-27)**
- Ingest: JUnit XML only ("Only JUnit XML test result files are supported at the moment"). Upload with `codecov/test-results-action@v5` (GitHub Actions) or `codecovcli do-upload --report-type test_results`; binaries for other OSes, so other CIs work through the CLI.
- History per test: summary with average duration, failure rate, commits failed, last run (changelog 2024-09-03 https://sentry.io/changelog/codecov-test-analytics-now-in-open-beta , verified 2026-10-27).
- Flaky detection: a PR comment separates failures caused by the PR from "failed tests that are known to be flaky on main". The docs I fetched do not define the detection method.
- Quarantine/mute: not found.
- Test impact / selection: not found.
- Manual test cases, release readiness, requirements traceability: none.
- API / MCP / AI: Codecov lists AI unit-test generation and PR feedback (about.codecov.io, verified). Sentry's MCP server (https://mcp.sentry.dev/ , verified 2026-10-27) lists errors, performance, issue triage, docs, projects; no test, flaky or coverage tools mentioned. Sentry's AI debugger is Seer, "subscription required" (pricing page, verified); it covers errors, not test results.

**Price and packaging** (https://about.codecov.io/pricing/ , verified 2026-10-27)
- Developer free: unlimited uploads for open source; private repos limited to one user and 250 private-repo uploads per month. Failed Test Reporting on all plans.
- Team $5 per user/month (max 10 users; page also shows $4 in a duplicate section, so unclear). Flaky Test Detection is not in Team.
- Pro $12 per user/month, unlimited users; Flaky Test Detection listed for Pro and Enterprise. Enterprise custom.
- Basis: per user (committer-like) per month. The Developer-plan flaky entry conflicts on the page.

**Notable 2025-2026 changes**
- 2022: Sentry acquired Codecov (reported, business wire listings).
- 2024-09-03: Codecov Test Analytics open beta (Sentry changelog, verified).
- 2026-06-02: "Codecov is joining Harness". Codecov blog (https://about.codecov.io/blog/a-new-chapter-for-codecov/ , verified 2026-10-27): brand stays, free for open source, continued investment in "code coverage and test analytics". Harness release (https://www.harness.io/press-and-news/harness-acquires-codecov , verified 2026-10-27): Sentry is the seller, partnership continues, no price disclosed. Neither page mentions Sentry Prevent.
- Harness's own CI has Test Intelligence and flaky test detection and quarantine (reported via search summary of https://developer.harness.io/docs/continuous-integration/use-ci/run-tests/test-management/ci-test-management-overview ; pages not fetched). Possible convergence: Codecov test analytics inside Harness. Not verified.

**Other-CI lock-in**: low. CLI upload works from any CI per Codecov docs (verified); GitHub is the primary integration.

---
## 5. Datadog

**Product names today**
- Test Optimization (formerly Test Visibility / Intelligent Test Runner, per vendor URL slugs `/product/test-visibility-intelligent-test-runner` in search listings; rename date not verified). Docs: https://docs.datadoghq.com/tests/ (verified 2026-10-27).
- CI Visibility / "Pipeline Visibility" (pipelines, separate SKU). Flaky Tests Management: https://docs.datadoghq.com/tests/flaky_management/ (verified 2026-10-27). Test Impact Analysis: https://docs.datadoghq.com/tests/test_impact_analysis/ (verified 2026-10-27). Early Flake Detection. Bits AI Dev Agent / "Bits Code" for flaky fixes.

**What it does**
- Ingest: native SDKs (.NET, Java/JVM, JavaScript, Python, Ruby, Swift, Go) plus JUnit XML upload with `datadog-ci junit upload`, which works from any CI provider, with examples for GitHub Actions, GitLab, Jenkins, CircleCI, bash (https://docs.datadoghq.com/tests/setup/junit_xml , verified 2026-10-27; docs say native instrumentation has "other features that are not available with JUnit XML uploads"). Feature gaps for JUnit upload were not itemised on the page I read (the Supported Features table was not in the fetched content). Flaky management docs state a native Datadog SDK at minimum versions is required (flaky page, verified), so JUnit-only upload very likely does not get quarantine/TIA; that is my inference, not stated.
- History per test: session/module/suite/test views, durations, results, CODEOWNERS owners, distributed traces (tests overview page, verified).
- Flaky detection: Early Flake Detection retries new tests; auto test retries rerun failed tests up to N times; flakes detected on default branch; Flaky Test Management tracks status Active / Quarantined / Disabled / Fixed. Fixed automatically after 30 days without flaking. AI root-cause category per test (Concurrency, Timeout, Network...) (flaky page, verified 2026-10-27).
- Quarantine/mute: yes, policy based per repository. Quarantined = keeps running, failures do not fail CI; Disabled = skipped. Rules by time active, branch, or 7-day failure rate threshold (flaky page, verified).
- Test impact / selection: yes, Test Impact Analysis skips tests via per-test coverage and git metadata; opt-in; native SDK for .NET, Java, JavaScript, Swift, Python, Ruby, Go; tests covering over 16,000 files never skipped; not available on gov sites (TIA page, verified).
- Manual test cases: none found.
- Release readiness view: none found (the Test Health page exists, https://docs.datadoghq.com/tests/test_health/ , search listing only).
- Traceability: Jira / Work Management work item creation for flaky tests; no requirements traceability (flaky page, verified).
- API: not itemised here; MCP covers it.
- MCP / AI: Datadog MCP server toolset `software-delivery` with `get_datadog_flaky_tests`, `update_datadog_flaky_test_states`, `search_datadog_test_events`, `aggregate_datadog_test_events`, `get_datadog_test_optimization_settings`, `get_datadog_flaky_tests_management_policies`, plus CI pipeline event search (https://docs.datadoghq.com/mcp_server/tools.md , verified 2026-10-27; the MCP overview page says the server "is under significant development", https://docs.datadoghq.com/bits_ai/mcp_server/ , verified). Bits Code flaky fixes: opens "Attempt to Fix" draft PRs when a flaky test has at least 5% failure rate, 2 hours wasted time, failures in 2+ pipelines, flaked on default branch; announced 2026-01-12, Preview (https://www.datadoghq.com/blog/bits-ai-test-optimization.md , verified 2026-10-27).

**Price and packaging** (https://www.datadoghq.com/pricing/?product=test-optimization#products , verified 2026-10-27)
- Test Optimization: from $20 per committer per month billed annually, $29 on-demand; includes 1,000,000 spans per committer per month (pooled), extra $3 per million spans. Third party ("reported", testdino.com via search) adds $24 month-to-month.
- Pipeline Visibility (CI Visibility): from $8 per committer per month annually, $12 on-demand; 400,000 spans per committer; $3 per extra million.
- A committer counts if they commit at least 3 times in a month. Customers can mix plans. Test Optimization customers get one Code Coverage committer per billed committer at no extra cost (pricing page, verified).
- Free tier: none found on the pricing page for this product. (Datadog 14-day trial mention in the Bits blog was commented out; not confirmed.)
- Basis: per active committer plus span volume. Does not require a particular CI.

**Notable 2025-2026 changes**
- 2026-01-12: Bits AI Dev Agent / Bits Code for flaky test fixes, Preview (blog above, verified).
- DASH 2026 keynote roundup exists (https://datadoghq.com/blog/dash-2026-new-feature-roundup-keynote , search listing); Test Optimization content in it not checked.
- Flaky management policies, AI categorisation and MCP tools are all in current docs; their launch dates were not verified.

**Other-CI lock-in**: none on CI (docs: "compatible with any CI provider" per search summary of the Getting Started page; JUnit upload verified from any CI). Lock-in is to Datadog itself and to its native SDKs for the advanced features.

---
## 6. GitHub (Actions, Copilot)

**Plain answer: no native test analytics found.** GitHub Actions has no built-in test result parsing, per-test history, flaky detection, quarantine, test selection, or manual test management that I could find in vendor pages. Absence is shown by: (a) no mention in the Actions changelog titles for Sep-Oct 2026; (b) no mention on the pricing page; (c) the Actions metrics page lists only usage (minutes) and performance (run time, queue time, job failures) down to the job level, "per-test data: not mentioned"; (d) an unanswered community feature request. Bodies of changelog entries were not read, so a buried mention cannot be ruled out.

**Evidence**
- Actions changelog (https://github.blog/changelog/label/actions/ , verified 2026-10-27): 16 entries from 2026-09-03 to 2026-10-22 (runner images, workflow lockfiles in public preview 2026-10-14, cache-mode, artifacts, retention); none about test results or flaky tests.
- Actions metrics (https://docs.github.com/en/actions/concepts/metrics , verified 2026-10-27): usage metrics (minutes by workflow, job, repo, OS, runner type) and performance metrics (average run time, queue time, job failures); finest granularity is the job.
- Community feature request "Native Test Results Dashboard for GitHub Actions (like Azure DevOps)", opened 2025-06-17, still "Unanswered", no staff reply, no roadmap link, latest comment 2026-07-01 saying flaky-test spotting and comparison over time need third-party reporters like CTRF and Allure (https://github.com/orgs/community/discussions/163123 , verified 2026-10-27).
- Third-party Marketplace actions parse JUnit into job summaries or checks (dorny/test-reporter, Publish Test Results, junit-report-action, etc.; https://github.com/marketplace/actions/test-reporter , search listing). Job summaries (markdown a step writes) are native; test parsing is not (search summary, "reported"; the docs.github.com job-summaries URL I tried returned 404).

**What GitHub does have that touches the problem**
- AI: "Fix with Copilot" button on failed Actions jobs; Copilot cloud agent investigates the failure, pushes a fix to the branch, tags the user. Announced 2026-06-04, Copilot Pro, Pro+ and Max; example given "fixing tests or correcting linter failures"; flaky tests not mentioned (https://github.blog/changelog/2026-06-04-fix-with-copilot-for-failing-actions-now-in-pro-pro-and-max/ , verified 2026-10-27). Also `@copilot` in PR comments, 2026-03-24 (https://github.blog/changelog/2026-03-24-ask-copilot-to-make-changes-to-any-pull-request/ , search listing only).
- MCP: official GitHub MCP server, hosted at `https://api.githubcopilot.com/mcp/`; `actions` toolset has `actions_get`, `actions_list`, `actions_run_trigger`, `get_job_logs`; `copilot` toolset can assign Copilot to issues (https://github.com/github/github-mcp-server , verified 2026-10-27). Reads run logs, not per-test results.
- Issues, Projects and Pull Requests give issue/PR traceability, but there is no test case object (not checked against a specific GitHub page; general knowledge, unchecked).

**Price**: Free plan 2,000 Actions minutes/month, Team $4/user/month for the first 12 months (3,000 minutes), Enterprise from $21/user/month for the first 12 months (50,000 minutes); public repos free minutes (https://github.com/pricing , verified 2026-10-27). Copilot paid plan prices not on that page.

**Other-CI**: n/a. Everything above is GitHub Actions or GitHub repos only. Third-party analytics (Buildkite Test Engine, Datadog, Codecov, CircleCI-less) fill the gap on GitHub Actions; that is where the competitive pressure on GitHub-hosted teams comes from.

---
## Summary table (as of 2026-10-27)

| Vendor | Product | Manual cases? | Flaky detection | Quarantine | MCP/AI | Free tier | Paid basis | CI lock-in |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CircleCI | Test Insights; Smarter Testing; Chunk (beta) | No | Same commit pass+fail in 14 days; auto-rerun | None found | MCP `find_flaky_tests`; Chunk AI fixes (beta, GitHub only) | Yes: 30k credits, flaky detection capped at 5 tests, 1,000 test atoms | Credits + users + test atoms | High (CircleCI jobs, OAuth GitHub/Bitbucket) |
| Buildkite | Test Engine | No | Workflows: passed-on-retry, transition count, probabilistic score | Yes: muted/skipped; auto rule Enterprise only | MCP `list_tests` (2026-08-12) | Yes: 250k executions, 24h history, no workflows | $30/active user + executions | Low (accepts JUnit from any CI) |
| Azure DevOps | Test Plans; Pipelines test analytics | Yes, full (plans, suites, steps, runs, UAT) | Rerun-based (system) or custom API | Closest: suppress flaky failures from summary | Remote MCP `testplan` toolset (create cases/runs) | Yes: 5 Basic users, Stakeholders free, 1,800 hosted min | Basic + Test Plans $52/user/month combined (corrected 2026-10-27: the $52 includes Basic) | Analytics Azure Pipelines only; Test Plans CI-independent |
| Sentry / Codecov | Codecov Test Analytics (now Harness); Sentry Prevent (docs not loadable) | No | Flagged known-flaky on main; method not documented | None found | Sentry MCP has no test tools | Yes: Codecov free, 1 private user, 250 uploads | Codecov Pro $12/user (flaky detection) | Low (JUnit via CLI) |
| Datadog | Test Optimization | No | Early Flake Detection, auto retries, default-branch flakes | Yes: policy-based quarantine/disable | MCP `software-delivery` flaky tools; Bits Code fix PRs (Preview) | None found | $20/committer/month annual (+ spans) | Low on CI; native SDKs needed for advanced features |
| GitHub | Actions (no test analytics) | No | None native | None | Copilot "Fix with Copilot"; MCP gets logs only | Yes: 2,000 Actions min | n/a | GitHub only |

## Could not check / open

- Sentry: docs.sentry.io/product/test-analytics, /sentry-prevent-cli/ and /product/prevent/ returned "Page Not Found" on 2026-10-27 although search listed them; I could not read any Sentry-hosted page about "Sentry Prevent". Whether Sentry still sells it, under what name, or whether it moved to Codecov/Harness after 2026-06-02 is unverified. The Codecov flaky-test detection method and the Codecov docs "flaky" page (docs.codecov.com/docs/test-analytics-flaky-tests, 404) were not read.
- CircleCI: whether Test Insights/Smarter Testing/Chunk accept results from non-CircleCI CI (pages silent); Smarter Testing quarantine (none found); circleci.com/docs/guides/test/test-insights 404; MCP docs page 404 so the "standalone MCP server deprecated in favour of CLI" claim is reported only (aggregator, July 2026). Smarter Testing GA vs beta wording differs across blog and docs.
- Buildkite: pricing page says Pro has "1 workflow" while the 2025-09-30 changelog says up to 3 per suite; history windows (24h/7d/28d) taken from a tool-read pricing page and look surprising; manual-case features not found, but the whole docs tree was not read.
- Azure DevOps: whether Test Impact Analysis (VSTest) is still current (not read); whether test results can be ingested via REST without running Azure Pipelines; MCP "public preview" date (sprint 258) is from a search listing only; Azure Test Plans $52 vs "5 free users" confusion resolved: $52 is Basic + Test Plans, 5 free users apply to Basic.
- Datadog: Supported Features table for JUnit-upload vs native SDK; Test Optimization free tier and trial (none found); the DASH 2026 roundup; launch dates of flaky policies and MCP tools; pricing of Bits Code. Pricing page read via tool in chunks 100,000-200,000 characters; the last 30,771 characters not read.
- GitHub: bodies of Actions changelog entries (only titles); docs.github.com job-summary and test pages (404); possible unannounced preview of test reports. Copilot paid plan prices.
- WebFetch summaries come from a small model; numbers copied from them (prices, limits) were quoted as returned but are not independently re-read from raw HTML.
