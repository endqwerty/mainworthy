# Competitor candidates (round 2), research date 2026-10-27
Legend: V = vendor page fetched 2026-10-27 ("verified 2026-10-27"); R = reported (third party / search snippet).
Jobs: J1 author manual cases; J2 automated results+history across CI; J3 flaky detect/quarantine; J4 release readiness; J5 AI agent authors/runs tests.

## Develocity (formerly Gradle Technologies / Gradle Enterprise)
- URL: https://develocity.ai/develocity/product/flaky-test-detection/ (gradle.com 301s to develocity.ai; verified 2026-10-27)
- Status: alive; company rebrand "Gradle Technologies is now Develocity" banner at https://develocity.ai/pricing/ (verified 2026-10-27; no date on page).
- Jobs: J2 (test results/Test Failure Analytics across builds), J3 (within-build retry and cross-build flaky detection; quarantine "non-blocking suite", automatable via Tests API) - verified 2026-10-27. Not J1/J4/J5. Build-tool coupled: Develocity Test Retry plugin (Gradle), Maven Surefire/Failsafe, Bazel, sbt; not generic JUnit-XML upload (from the page; JUnit-XML ingestion not stated).
- Price: per committer per year, packages (Flaky Tests Detection is its own package, requires Observability Platform); no free tier, 30-day trial; SaaS has consumption overage, self-hosted none; no dollar amounts published (https://develocity.ai/pricing/, verified 2026-10-27).
- MCP/AI: MCP server with "Analyze Test Patterns" tool (flaky tests, failure trends); needs Develocity 2025.3+; no Bazel (https://docs.develocity.ai/2026.2/integrations/agentic-ai/mcp-servers/, verified 2026-10-27). A search snippet said it was "Limited Availability" in one doc version (R, search result of docs.gradle.com/develocity/mcp-server; that page 404'd under the new domain).
- VERDICT: EXCLUDE (borderline). Covers J3 only for JVM/Bazel/sbt builds, enterprise-priced, no free tier. A JVM team could use it instead of Mainworthy for flaky detection, but it targets large build-performance buyers. If the rule is "plausibly use instead for at least one job": it technically meets J3 for Gradle/Maven teams. -> INCLUDE as narrow (JVM-only, J3) is defensible; I mark INCLUDE-NARROW.

## CloudBees Smart Tests (formerly Launchable)
- URL: https://www.cloudbees.com/capabilities/cloudbees-smart-tests (launchableinc.com 308-redirects here; verified 2026-10-27). Banner: "Launchable is now CloudBees Smart Tests."
- Status: alive. CloudBees acquired Launchable Aug 2024 (R: https://siliconangle.com/2024/08/07/cloudbees-acquires-ai-based-software-testing-startup-launchable/ - search result, not fetched). Smart Tests GA press release dated April 2, 2026 (V: https://www.cloudbees.com/newsroom/cloudbees-smart-tests-brings-control-to-ai-generated-code, verified 2026-10-27). Rename date not on the pages I could read.
- Jobs: J2 (analytics, history) and J3 (flaky identification, quarantine from critical paths while still running) verified 2026-10-27. Core product is predictive test selection (not a Mainworthy job). Not J1/J4/J5.
- Price: not published; "Try for free" button, "Book a demo"; AWS Marketplace listing says contract-based (R). A third-party claim of "$99/month" is unverified and possibly legacy Launchable (R, ignore).
- MCP/AI: no MCP mention on product page, press release or docs home (verified 2026-10-27). AI = ML test prioritisation and AI failure classification.
- VERDICT: INCLUDE-NARROW (J3 + J2). Enterprise/Jenkins/CloudBees-leaning, demo-gated pricing; weaker as a substitute for small teams. Keep as a one-line mention.

## Trunk Flaky Tests
- URL: https://trunk.io/flaky-tests (verified 2026-10-27)
- Status: alive; on-prem/BYOC in "Private Preview" (V). Part of Trunk (also merge queue, CI Autopilot).
- Jobs: J2 (status history, flake rates, failure reasons, per-repo/team views) and J3 (AI failure grouping/fingerprinting; auto-quarantine without code changes; Slack/PR comments; Jira/Linear tickets) verified 2026-10-27. Not J1/J4. J5 partial (see MCP).
- Price: per committer per month; Free $0 up to 5 committers with 1M test spans/committer; Team listed $0 shown with trial but "becomes paid after trial", rate not listed; Enterprise custom (SSO, SOC2, BYOC) (https://trunk.io/pricing, verified 2026-10-27).
- MCP/AI: hosted MCP server https://mcp.trunk.io/mcp, OAuth; tools search-test, fix-flaky-test, setup-trunk-uploads (labelled experimental); Claude Code plugin; "Autofix Flaky Tests" agent (R: search results of docs.trunk.io/flaky-tests/use-mcp-server and /agents/autofix-flaky-tests; snippet only, pages not fetched).
- VERDICT: INCLUDE. Direct J3 substitute, generic (framework-agnostic, per vendor), free for <=5 committers, has MCP. Closest overlap to Mainworthy's flaky job.

## Mergify (CI Insights + Test Engine/Test Insights)
- URLs: https://mergify.com/pricing , https://docs.mergify.com/test-insights , https://docs.mergify.com/changelog/2026-07-24-automatic-flaky-test-detection-and-prevention/ (all verified 2026-10-27)
- Status: alive. Naming is in flux: pricing page says "Test Engine"; docs URL path and heading say "Test Insights (now called Test Engine)". Changelog 2026-07-24 "Automatic flaky test detection and prevention".
- Jobs: J2 (tests classed healthy/flaky/broken from CI runs over time), J3 (PR reruns of new tests, default-branch reruns, flaky ranking by impact, quarantine: failures no longer block merges) - verified 2026-10-27. Ingest via framework plugins (pytest, rspec, vitest, playwright) or JUnit XML upload. Not J1/J4/J5. Also merge queue.
- Price: per seat ($21/seat/month Max, up to 100 users; Free $0 for private teams up to 5 active contributors; Open Source $0; Enterprise custom). All three products in every plan; CI Insights job metrics retention 24h Free / 30d Max (verified 2026-10-27).
- MCP/AI: no MCP mentioned on the page; offers a `tests` CLI "from a terminal or AI coding agents" to check whether a failure is regression or known flakiness (verified 2026-10-27).
- VERDICT: INCLUDE (J3 + J2). Free for <=5, JUnit XML path, directly overlaps flaky quarantine.

## BrowserStack Test Management
- URL: https://www.browserstack.com/test-management (verified 2026-10-27)
- Status: alive.
- Jobs: J1 (rich-text editor, templates, BDD), J2 partial (CLI, JUnit XML, CI/CD integrations; automated runs), J4 partial (test plans/runs/reports/dashboards, per MCP tool list), J5 (eight AI agents incl. Test Case Generator, Deduplication, Low-Code Authoring, Failure Analysis). Verified 2026-10-27.
- Price: product page lists none, "Get started free" + trial. Search-snippet only (R, unverified, sources disagree): free for 5 users; paid $19/user/month or $99/month team for 5-25 users (https://www.browserstack.com/guide/test-case-management-tools-pricing - search result, not fetched). Official pricing URL /test-management/pricing returned 404; /pricing page lists no Test Management price.
- MCP/AI: official BrowserStack MCP server (@browserstack/mcp-server) has a Test Management toolset: create/list/update/copy/move/archive test cases, folders, templates, versions; shared steps; datasets; requirements links; create/clone/close test runs and log results; test plans; exploratory sessions; reports; dashboards. Requires a Test Management licence; contact support to enable (https://www.browserstack.com/docs/browserstack-mcp-server/tools/test-management, verified 2026-10-27). Product page itself does not mention MCP.
- VERDICT: INCLUDE. Full TCM + agent access via MCP; closest classic-TCM-with-MCP competitor.

## BrowserStack Test Reporting & Analytics (formerly Test Observability)
- URL: https://www.browserstack.com/test-observability (verified 2026-10-27; doc URLs still say test-observability; page states no rename date)
- Jobs: J2 (dashboards, trends, stability, failure rates; any framework via JUnit XML upload to API endpoint), J3 ("Detect flaky, always-failing tests and new failures automatically"), J4 partial (quality gates with GitHub PR checks, alerts), J5 partial (Test Failure Analysis agent: RCA, categorises product/automation/environment). Verified 2026-10-27.
- Price: page lists none; "Get started free", trial, no-signup Sandbox. https://www.browserstack.com/pricing (verified 2026-10-27) lists it only as a feature inside Automate plans ($99/$175/$225 per month per parallel, annual) and "Reporting for external tests" add-on "Inquire for Pricing".
- MCP/AI: MCP not mentioned on that page; AI failure analysis agent yes.
- VERDICT: INCLUDE (J2+J3, accepts JUnit XML so usable without BrowserStack's device cloud).

## TestMu AI (formerly LambdaTest) - Test Manager, KaneAI
- URLs: https://www.testmuai.com/test-manager/ (lambdatest.com/test-manager 301s here), https://www.testmuai.com/pricing/ (verified 2026-10-27)
- Status: alive; LambdaTest rebranded to TestMu AI, announced January 2026 (R: SiliconANGLE 2026-01-12 via search result https://siliconangle.com/?p=727461, not fetched; site redirect verified).
- Jobs: J1 (manual+automated cases in one workspace; AI generation from text, Jira tickets, PDFs, images, audio, video), J2 partial ("automated results flow in from HyperExecute and CI/CD pipelines"; mechanics not described), J4 partial (coverage/pass-rate/trend reports), J5 (KaneAI authors tests from natural language) - verified 2026-10-27.
- Price: Test Manager Free Forever $0 (unlimited projects, folders, cases; test runs, custom fields, API NOT in free) ; Premium $49/user/month annual, 2,000 AI credits/user/month. KaneAI per agent: Starter $17, Pro $89, Max $179 /month annual (cards; comparison table shows $19/$99/$199 monthly). Test intelligence/analytics: Enterprise only, contact sales (verified 2026-10-27; page 168k chars, only first 100k read).
- MCP/AI: Test Manager page does not mention MCP. Search results (R) say the site lists a "TestMu AI MCP Server" and an IDE MCP server; Kane CLI exists for local authoring (verified in pricing text). No test-manager MCP confirmed.
- VERDICT: INCLUDE (J1 + J5). Free tier cannot create runs, so real use is $49/user.

## Currents.dev
- URLs: https://currents.dev , https://currents.dev/pricing (verified 2026-10-27)
- Status: alive.
- Jobs: J2 (Playwright reporter/dashboard, Cypress side-by-side, months of run history, traces/screenshots/video per attempt), J3 (flaky detection on every plan, flakiness rate across branches, Quarantine/Skip/Add Tags "Actions" on every plan). Also test orchestration (spec balancing, rerun failed only). Not J1/J4. J5: MCP, see below.
- Price: per test result (retries count once). 14-day trial, up to 10,000 results, no permanent free plan. Scale $49/mo at 10k results + $4.9 per extra 1,000; Business $99/mo + $9.9/1,000 (SSO, SCIM); Enterprise custom (self-host). (verified 2026-10-27)
- MCP/AI: MCP server on every plan; agents (Claude Code, Cursor, Codex) read failure error/steps/trace/history, quarantine flaky tests, file Jira/Linear issues, attach before/after evidence to PRs. "Fix tests with AI" via VS Code/Cursor extensions on Scale+ (verified 2026-10-27).
- VERDICT: INCLUDE. Strong J2+J3 substitute for Playwright/Cypress teams, with agent access that is richer than most. No free tier is a gap vs Mainworthy self-host.

## Cypress Cloud
- URLs: https://www.cypress.io/cloud , https://www.cypress.io/pricing (verified 2026-10-27)
- Status: alive.
- Jobs: J2 (per-test history: failure/flake rates, duration trends; Project Analytics; Data Extract API; Test Replay), J3 (Flake Detection, Flaky Test Analytics; Jira issues from flaky/failed tests; no auto-quarantine stated on the pages I read). Cypress-only (tests must be Cypress). Not J1/J4.
- Price: per recorded test result. Starter Free 500 results/month, 10 users, NO flake detection; Team $67/mo ($799/yr) 120k results/yr, 50 users, flake detection; Business $267/mo ($3,199/yr); Enterprise custom. Overage $6 per 1,000 (FAQ) vs $5 (Business table) (verified 2026-10-27).
- MCP/AI: Cloud MCP "gives AI coding assistants access to your test results", included on all plans incl. free; AI Summaries; Starter has 100 prompt executions/month (cy.prompt not mentioned on the cloud page) (verified 2026-10-27).
- VERDICT: INCLUDE-NARROW (Cypress shops only; J2+J3 on paid plans; free tier lacks flake detection).

## Microsoft Playwright Testing / Azure App Testing / Playwright Workspaces
- Status: Microsoft Playwright Testing (Preview) retired March 8, 2026; replaced by Playwright Workspaces in Azure App Testing, now GA (R: https://mc.merill.net/message/AZ499860 and Microsoft Learn snippets via search; Learn overview URL I tried 404'd; not fetched).
- Jobs: cloud browser execution/scale-out; reporting is thin per third-party commentary (R, sources disagree). Does NOT do J1/J3/J4. 
- VERDICT: EXCLUDE. Execution infrastructure, not a results/TCM/flaky tool; no reporting substitute for Mainworthy.

## Playwright MCP and Playwright Test Agents (planner / generator / healer)
- URLs: https://playwright.dev/docs/test-agents ; https://github.com/microsoft/playwright-mcp (both verified 2026-10-27)
- Status: alive, open source. playwright-mcp Apache-2.0, 38.7k stars; page itself says Playwright CLI + Skills may be more token-efficient for coding agents and MCP "remains relevant for specialized agentic loops".
- Jobs: J5 (planner writes Markdown test plans to specs/ from an app exploration, generator emits Playwright tests, healer repairs failing tests via locator/wait/data patches or skips test). Setup: `npx playwright init-agents --loop=<tool>`; supports VS Code, Claude Code, Codex, OpenCode. Plans are Markdown files in git, not a managed case store; no results history, no flaky tracking, no readiness view.
- Price: free, open source.
- VERDICT: INCLUDE (J5, and as a substitute for "AI authors tests" and light manual-plan authoring in repo). Not a TCM; a team could use it instead of Mainworthy's agent authoring path.

## QA Wolf
- URL: https://www.qawolf.com/pricing (verified 2026-10-27)
- Status: alive.
- Jobs: J5 (agents plan coverage, write Playwright/Appium tests, maintain, pick tests per PR, diagnose every failure) plus optional human-run "Coverage-as-a-Service" (80%+ coverage guarantee, failures investigated within 24h), J2/J3 partial (up to 3 attempts per run, flaky auto-retried and repaired; run-history UI not described on page). Not J1/J4.
- Price: pay per run: web $1, mobile/desktop $2 per run (5 min blocks); AI, parallelism, seats included; monthly spend cap; free runs for new teams; managed service quoted by sales.
- MCP/AI: MCP server at https://app.qawolf.com/api/mcp for Claude Code, Codex, Cursor; requests from Slack/GitHub/GitLab etc. (verified 2026-10-27).
- VERDICT: INCLUDE (J5; a team can outsource test authoring and running instead of managing cases in Mainworthy).

## Momentic
- URL: https://momentic.ai/pricing (verified 2026-10-27)
- Status: alive.
- Jobs: J5 (natural-language browser/mobile tests, auto-healing, failure recovery, triage agent, AI test selection), J2 (results and artifacts 30 days free/PAYG; aggregate analytics indefinite), J3 (failure classification into app bug / test flakiness / environment; quarantine rules). Not J1/J4.
- Price: credits, no per-seat; Free $0 forever 2,000 credits/month, 5 concurrent browsers, hard stop without overage; (verified 2026-10-27).
- MCP/AI: MCP access on all plans; memory/knowledge base; triage agent with warn/fail/quarantine handling.
- VERDICT: INCLUDE (J5+J3+J2, with a real free tier).

## Octomind
- URL: https://octomind.dev - DNS failed from this environment (getaddrinfo ENOTFOUND), 2026-10-27 (consistent with the reported shutdown).
- Status: SUNSET (R, all secondary): farewell letter reported 2026-04-23, product switched off end of May 2026, company wound down end of June 2026; tooling left MIT-licensed on GitHub (R: https://www.rfp.wiki/vendors/octomind , https://huntscreens.com/products/octomind-mcp , https://www.distillintelligence.com/news/octomind via search; farewell letter itself not found).
- VERDICT: EXCLUDE: shut down 2026.

## Checksum.ai
- URL: https://www.checksum.ai (verified 2026-10-27)
- Status: page loaded; no status info.
- Jobs: J5 (E2E agent generates, runs, heals Playwright tests as code in your repo; API agent; fixes proposed as PRs; production bugs turned into tests). No J1/J2/J3/J4 described.
- Price: "Results as a Service", per workflow maintained, no per-seat/per-run; no figures. MCP: not mentioned.
- VERDICT: INCLUDE-NARROW (J5 only, managed, sales-led). One line mention.

## Meticulous
- URL: https://www.meticulous.ai (verified 2026-10-27)
- Jobs: J5-ish (auto-generates and maintains frontend visual E2E suite from recorded sessions; replays recorded backend responses; PR checks). No manual cases, no cross-run analytics claim.
- Price: not stated (Get Started / Book a Demo). MCP: not mentioned.
- VERDICT: EXCLUDE (frontend regression tool, not a TCM/results/flaky/readiness substitute; no manual authoring). Borderline for "AI runs tests" - no, it is automatic regression, no agent access.

## TestDino
- URL: https://testdino.com (verified 2026-10-27)
- Status: alive (Playwright reporting vendor; also publishes many comparison pages that are marketing, treat claims as such).
- Jobs: J2 (per-run report: summary, spec breakdown, error groups, run history), J3 (stability % + root-cause category: timing/environment/network/assertion/other), test management mentioned with few specifics; J5 via MCP ("query results, debug failures, manage test cases from your IDE via MCP"). Playwright-only reporter (@testdino/playwright).
- Price: not listed; 14-day trial, no permanent free tier stated. 
- VERDICT: INCLUDE (J2+J3+MCP for Playwright teams; direct Currents-like rival).

## ReportPortal
- URL: https://reportportal.io (verified 2026-10-27)
- Status: alive; Apache-2.0, self-hostable free version; SaaS and support packages.
- Jobs: J2 (aggregates results across frameworks/languages, trend dashboards, history), AI failure analysis (Auto-Analyzer, ML failure pattern/root cause). Flaky detection not mentioned on the page. No J1/J4.
- Price: free self-host; SaaS/service packages quoted by contact; 30-day trial.
- MCP: not on the site page; a ReportPortal MCP server is listed as maintained by the project in third-party directories (R: https://agentpedia.codes/mcp/reportportal , https://antigravity.codes/mcp/reportportal); TestDino (competitor) says there is none. Unresolved - not checked on the vendor's GitHub.
- VERDICT: INCLUDE (J2; open-source self-hosted competitor to Mainworthy's self-host story). Closest in spirit on licensing.

## Testsigma
- URL: https://testsigma.com/pricing (verified 2026-10-27)
- Jobs: J1 (Test Management product), J5 (agentic test automation; "Autonomous Testing (Upcoming)" on Enterprise; AI test case generation), J2 partial. Search snippets say Atto AI coworker + new Test Management product launched 2026 (R: https://startuphub.ai/news/testsigma-announces-agentic-ai-testing-and-test-management, not fetched).
- Price: Pro and Enterprise only, "Get Custom Pricing"; no free tier on page; usage-based quote. MCP not on pricing page.
- VERDICT: INCLUDE-NARROW (J1+J5, sales-led pricing).

## ---- Smaller TCMs (one line each) ----
- TestMonitor (https://www.testmonitor.com/pricing, verified 2026-10-27): J1+J2 partial+J4. $13/user/month monthly, $11 annual (Starter, 3 users incl.); no free tier, 14-day trial; automation result import (Playwright, Selenium, JUnit) with daily caps 500/2,500/5,000; REST API all plans; no MCP/AI mentioned. INCLUDE-NARROW (classic TCM, no agent features).
- Tuskr (https://tuskr.app/pricing): WebFetch failed ("unable to verify the first certificate"). Not checked. See below for search attempt.
- TestCollab (https://testcollab.com/pricing, verified 2026-10-27): J1+J4 (coverage reporting, traceability, test plans); Premium $29 / Elite $39 per user/month annual ($35/$45 monthly); no free tier, 14-day trial; QA Copilot + AI case generation on Elite; footer links an MCP Server page (/integrations/mcp-server, content not read); automation import not described; page internally inconsistent (200 case cap in table vs "unlimited" in cards). INCLUDE (J1+J5/MCP).

### Addenda to rows above
- TestCollab MCP (https://testcollab.com/integrations/mcp-server, verified 2026-10-27): 17 tools; create/query/update test cases with steps/tags/custom fields; nested suites; create test plans, assign testers, track progress. MIT-licensed, npx @testcollab/mcp-server, works with self-hosted TestCollab. Which plan includes it is not stated.
- TestMu AI Test Manager MCP (https://www.testmuai.com/support/docs/test-manager-mcp-server/, verified 2026-10-27): part of the TestMu AI MCP Server, 22 `tm_` tools: create/update projects, folders, test cases, `tm_generate_test_cases` (AI), create/update test runs, `tm_record_test_results` (up to 500 per request), milestones, Jira/ADO links, coverage summary. No delete tools. This supersedes the "no MCP confirmed" note under TestMu AI: MCP exists. Plan requirements not stated.
- Trunk MCP: docs.trunk.io/flaky-tests/use-mcp-server redirected to a login page (302), so MCP details stay "reported" from search snippets, not verified.

## Tuskr
- https://tuskr.app/pricing failed (certificate error) and https://www.tuskr.app also failed. Not verified.
- Reported (search aggregators G2/Capterra/TrustRadius, figures disagree): free plan (5 projects, 1k cases, 1 GB, or "up to 5 users"); paid $7.50-$9/user/month Team, up to $29 Enterprise; AI assistant mentioned by a reviewer only. 
- VERDICT: INCLUDE-NARROW (J1; classic small-team TCM, unverified details). Low value.

## aqua cloud
- https://aqua-cloud.io/pricing/ (verified 2026-10-27): Test Management + Requirement Management EUR 89/month billed annually (EUR 119 monthly); Test Runner/DEV EUR 19/month annually; aqua Suite EUR 99/month private cloud or on-prem; unlimited free read-only Guest licences. "aqua Intelligence": requirements, test case and test data generation. Test results via API; Jenkins, Azure DevOps, REST integrations. MCP not mentioned.
- Jobs: J1, J2 partial (API), J4 partial, J5 partial (AI generation, no agent access seen).
- VERDICT: INCLUDE-NARROW (J1 + AI generation, no MCP).

## Squash TM (Henix)
- Vendor pages: https://www.squashtm.com/en/community-editions returned 404 (from the squashtest.com 301). Not verified from vendor marketing pages. Docs exist at https://tm-en.doc.squashtest.com/ (appeared in search, not fetched).
- Reported (R, third-party zencoder.ai comparison and docs search results): open-core, free Community edition (self-host), Ultimate edition adds plugins incl. some Orchestrator plugins and (per one third-party site, unverified) AI features; Squash Orchestrator is built on OpenTestFactory; Orchestrator 6.2.2 released 2026-04-03 per v15 release notes (search snippet).
- VERDICT: INCLUDE-NARROW (J1, J2 via Orchestrator; free self-host overlaps Mainworthy's self-host path; strongest in France/EU). Details unverified.

## Mabl
- https://www.mabl.com/pricing (verified 2026-10-27): quote-based, credits (500/month starting point), 14-day trial, no free plan stated. Agentic: builds/runs/maintains tests, auto-healing, root-cause summaries; mentions diagnostics data "available to external agents" and a CLI; no MCP mention; no flaky detection or run-history described on page.
- VERDICT: EXCLUDE (not shown to cover J1-J4; AI-test-automation SaaS; J5 partial but no agent access/MCP stated). Hold for a re-check if MCP is added.

## Allure Report 3 (open source report generator; TestOps already covered)
- https://allurereport.org/docs/test-stability/ (verified 2026-10-27): flaky mark compares latest result to up to 5 earlier results in the same environment; "Retried" mark; `allure run --rerun N`; history file (JSONL). Licence not stated on page; no AI/MCP on that page (sidebar lists an "Agent Mode" page, not read).
- Jobs: J2 (static per-launch report + history) and J3 (flaky flag, no quarantine mentioned). No J1/J4.
- VERDICT: INCLUDE-NARROW (free local substitute for J2/J3; no server-side store unless TestOps).

## Flakiness.io
- https://flakiness.io (verified 2026-10-27); docs.flakiness.io mentions no MCP (verified 2026-10-27).
- Jobs: J2 (per-test history across commits, ingest as it lands, shards merged, artifacts), J3 (separates regression from flake per commit/environment; no quarantine mentioned). AI: failed runs condensed into compact records for coding agents ("AI agents" bullet), but no MCP.
- Price: by stored data. Free $0 (1 GB, 90 days, unlimited runs and users, public projects; private-project status unclear), Startup $49, Growth $199, Enterprise custom (self-host).
- Reporters: Playwright, Pytest, Vitest, Jest, CucumberJS, Bun, Rust; JUnit XML bridge. GitHub/GitLab only.
- VERDICT: INCLUDE (J2+J3 with JUnit bridge, free tier, closest to a lightweight CI-history rival).

## Shiplight AI
- https://www.shiplight.ai (verified 2026-10-27): agent-native E2E; coding agents walk the app and write YAML tests in the repo (transpile to Playwright); installed as MCP server + Skills for Claude Code, Cursor, Codex, VS Code; tests from recording, ticket, spec or spreadsheet plan. Free plan (no price detail), BYO LLM key, hosted CI runners, result history and dashboards need an account. Flaky detection not described (self-healing instead).
- VERDICT: INCLUDE (J5 + J2 light). Directly "AI agent authors/runs tests".

## Others seen in search, NOT researched (R only, from https://... search listing): Katalon True Platform (2026-04-07), Tricentis agentic platform, MuukTest Amikoo (2026-04-14), AgenQA (2026-02-13), Ai2QA (2026-01-26), Autosana, Testkube flakiness analysis agent (https://docs.testkube.io/articles/flakiness-analysis-agent). Not verified.
