# Part 1: ThePrimeagen / Omarchy "AI test platform" (researched 2026-10-27)

## Verdict: FOUND, with a caveat (the canonical repo is not publicly reachable now)

Name: **Oligarchy** ("Playing around with automation via custom agent harness to run and test Omarchy releases").

- Canonical URL named by Omarchy's news post: https://github.com/ThePrimeagen/Oligarchy
  - Today (2026-10-28 UTC) `gh api repos/ThePrimeagen/Oligarchy` and a plain HTTP request both return 404. It is not in
    `gh api users/ThePrimeagen/repos` (100 public repos listed). So it is private, deleted or renamed. I cannot tell which.
- A public copy exists: https://github.com/rustybladerunner/Oligarchy (1 star, not marked as a fork, created 2026-09-15, last
  pushed 2026-09-20, TypeScript, 289 commits). Its history is authored by ThePrimeagen and "Cursor Agent"; last commit
  2026-09-19 "Merge pull request #166 from ThePrimeagen/cursor/viz-running-spinners-209e"; first commit 2026-08-28
  "Add oligarchy so start can boot a guest without a prebuilt disk." So it is a mirror/copy of his repo as of about
  2026-09-19. Not verified to be authorised by him.
- Licence: none detected on the copy (no LICENSE file in the tree, `license` null). The Omarchy post does not state one. So
  "open source" is not established: source visible, no licence grant. Omarchy itself (https://github.com/omacom/omarchy,
  45.8k stars; basecamp/omarchy no longer resolves) has a LICENSE file.
- Stars on the original: unknown (not reachable). Copy: 1.
- Omarchy announcement: https://omarchy.org/news/2026/09/theprimeagen-joins-omarchy-core/ (DHH, 2026-09-26): ThePrimeagen
  joins Omarchy Core "to lead Agentic QA"; goal "every Omarchy release has had a swarm of agents check everything"; "Leading
  Agentic QA means turning Oligarchy from a fun experiment into a routine part of how we build, test, and ship Omarchy."
  Fleet runs on DigitalOcean droplets. Post links to the GitHub repo and does not state a licence.
- Newsletter summary: https://aiinqa.com/ai-in-qa-issue-29/ (2026-09-28): "a harness that boots Omarchy in QEMU virtual
  machines"; says nothing on open/closed.
- A web-search summariser claimed a ThePrimeagen tweet (https://x.com/ThePrimeagen/status/2112178301208858808; X returns 402 to
  me) says Omarchy QA "will start running against nightly every day" and that production QA work is private for now. I could
  NOT read the tweet, so treat "private for now" as unverified.

## What it does (read from the public copy's source tree, not videos)

- Boots the Omarchy ISO in QEMU (OVMF/UEFI). "Minted disks" (`minted-disks.md`): install Omarchy once per server, save a qcow2
  plus OVMF_VARS; every test boots a throwaway qcow2 overlay of it in seconds.
- Processes (one dir each under `src/`): `qemu-server` (boots guests), `qemu-reverse-proxy` (places/reserves sessions across
  servers), `client` (CLI an agent uses to drive a guest: start, get-image, get-serial, send-keys, mouse move/click/drag/scroll,
  intent start/end, save, stop), `ctrl` (control plane/record keeper), `automation-server` + `automation-client` (job queue and
  hosts that run agents), `dashboard` (Hono Worker on Cloudflare + Hyperdrive, htmx), `viz` (OpenTUI terminal UI), `session`
  (REPL), `dig` (a game, unrelated). Stack: Bun 1.4, Effect 4 rc, Postgres + drizzle, Sentry, Cloudflare Worker.
- Test model: `test_definitions` = name, description, instruction, proof; **versioned, never edited in place** (migration
  `0004_test_definition_versions.sql`; `./ctrl test define` makes v2...; every result pins the definition row id; dashboard charts
  each version separately). `test_runs` (one per ISO/version/server) -> `test_results` (one per definition: status
  pending/running/passed/failed/aborted/timed_out, model, linear_id, session_id) -> `sessions` -> `actions` (request/response
  JSON, state) -> `images` (screenshots as bytea) + `logs` + `debug_logs` (serial etc.). `post_run_error_types` is a controlled
  vocabulary of failure causes; `post_run_diagnosis` = verdict passed/failed + error_type + summary + model.
- Agents/LLMs: yes, core. Each test result becomes a **Linear ticket** ("Automation Needed" -> "In Progress" -> "Needs Review").
  A *driving agent* (prompt `prompts/driving-agent.html`; the model is recorded with `--model`) reads the ticket, drives the
  guest by screenshots and keystrokes, and records pass/fail with `./ctrl test-results`. A separate *diagnosing agent*
  (`prompts/diagnosing-agent.html`) is a post-run reviewer: it must look at the final screenshot, treats the driver's verdict as
  "a claim to check, not a fact", decides from evidence, and files one diagnosis with an existing error type (minting a new type
  "should be rare"). Agents run via Cursor (`@cursor/sdk`, `.cursor/skills/*`, opencode.ts in automation-client). Dashboard
  retention: rows older than 30 days deleted by cron.
- Maturity: 22 days from first to last commit at the copy's snapshot (corrected 2026-10-27 from "about 7 weeks"), 289 commits, 13 migrations, 1334 unit tests per its own `NEED_FIXING.md`,
  CI migrations workflow. Self-described by the news post as an experiment becoming routine. Heavily agent-written (Cursor
  Agent commits, large AGENTS.md/development.md). No licence, "private": true in package.json.

## Other candidates considered (not the one)

- https://github.com/ThePrimeagen/99 (4.7k stars, Neovim AI agent) and https://github.com/ThePrimeagen/prime-agent (49 stars,
  phased Cursor-SDK dev workflow with Linear) are ThePrimeagen's AI tools, but neither tests anything.
- https://github.com/mowgli42/omarchy-testar (0 stars): scriptless GUI explorer for Omarchy, CTRF/JUnit/SARIF outputs. Unrelated
  third party.
- https://github.com/uBruckhaus/omarchy-ai-playground (0 stars): benchmarks AI agents on Omarchy. Unrelated.
- Omarchy repo's own `test/` dir and issues (e.g. omacom/omarchy#7125, #7126) are an acceptance-test harness, not an AI platform.

## Relevance note
Oligarchy is an agent-driven GUI/OS acceptance tester with a versioned-definition, evidence-first (screenshots) result model and a
separate diagnosing agent that audits the driver's verdict. It is not a general test-case manager.

Searched: gh repo/user/org searches (ThePrimeagen, basecamp, omacom), Omarchy issues, web search x3, omarchy.org news, aiinqa.
Could not check: the original repo (404), the tweet (402), any licence beyond the copy, the live dashboard.

---
# Part 2: user voice (quotes are verbatim from fetched text; "snippet" means from search tool output, not the page itself)

Blocked: G2 and Capterra review pages (HTTP 403 to fetch); x.com (402); reddit.com search JSON (served an interstitial). Reddit
threads below come from mirrors/search snippets where noted. Vendor "alternatives" blogs are biased and are marked VENDOR.
HN note: several Feb 2026 HN items are promotional (EZTest, QualityFolio replies) and are marked PROMO.

## Source A: Hacker News (Algolia API, full text)
Q1 [price, UX] "We are struggling with TestRail. Barely usable expensive crap. Enterprise business love such things." -- HN comment, 2024-02-27, https://news.ycombinator.com/item?id=39523369
Q2 [price] "we recently looked at the $30/user/mo price tag for legacy test management tools. It's insane. Why am I paying a 'per user per month tax' for a glorified spreadsheet when I can pay $20 for an AI agent that can build me a custom version in a week?" -- HN, 2026-02-05, https://news.ycombinator.com/item?id=46897930 (PROMO-ish; the author then pitches a product)
Q3 [price, AI] "Test management tools today are just glorified, overpriced spreadsheets. They charge $20 to $40 per user, per month for basic CRUD operations." -- Show HN EZTest, 2026-02-05, https://news.ycombinator.com/item?id=46899365 (PROMO, by a vendor)
Q4 [don't need a TCM] "For teams heavy on automation and CI, keeping tests close to the code usually works better than maintaining another bulky test management tool that people eventually ignore. Tests live in the repo, CI shows results in PRs, and acceptance criteria sit in issues or PR checklists. That keeps things simple and avoids stale tests and unused dashboards." -- HN reply in "Test management tools for automation heavy teams", 2026-02-06, https://news.ycombinator.com/item?id=46910008 (thread https://news.ycombinator.com/item?id=46898005 has only two replies; this one reads generic/possibly synthetic, treat as weak)
Q5 [don't need a TCM, Jira/process] "Tests where not helping the delivery - only used as a 'defence', requirements got stale, overall cumbersome to keep two IT systems (Jama, HP QC) up to date" -- HN, 2022-04-19, https://news.ycombinator.com/item?id=31090847
Q6 [Jira coupling / plugins] "It's not worth it to try to stick all possible functionality into one tool. And the plugin architecture in general is horrible if the plugin is not maintained by the same group as the core since support will end quickly" -- HN, 2023-03-05, https://news.ycombinator.com/item?id=35027702
Q7 [UX] "Zephyr, Xray, TestRail are commonly used, but all of these feel clunky." -- HN, 2021-05-06, https://news.ycombinator.com/item?id=27063064
Q8 [AI, flaky] "Unfortunately from our experience tests don't scale as well as code. First of all, static tests are very brittle: you rely on selectors, need wait times, and can't really test a lot of dynamic content" -- HN (Launch HN TesterArmy, a vendor of AI testing agents), 2026-06-18, https://news.ycombinator.com/item?id=48588140
Q9 [AI, "don't need a TCM"] "E2E tests are now quick to write due to LLMs, and are then deterministic AND cheap to run. How would this compare to the token costs of running an agent the whole time for each test? ... Do customers still need to create test cases - any way to import from test case management system" -- HN, 2026-06-18, https://news.ycombinator.com/item?id=48588006

## Source B: Ministry of Testing thread "Is test case management dead?" (fetched, 2025-04-23/24)
https://club.ministryoftesting.com/t/is-test-case-management-dead/84370  (page 2 exists, not read)
Q10 [don't need a TCM] "Test code is the living documentation." -- Juan Alvarez, 2025-04-24
Q11 [don't need a TCM] "having to manage every single test step in some separate tool feels outdated." -- Christine Pinto, 2025-04-23
Q12 [don't need a TCM] "writing test cases has become a way to 'show proof of work.'" -- Komal chowdhary, 2025-04-23
Q13 [don't need a TCM] "Really not a fan of test cases or a system to manage them." -- Andrew, 2025-04-24
Q14 [don't need a TCM] Rosie Sherry (2025-04-23) asks whether micro-managing tests with such tools "feels like such an out-of-date practice."
Q15 [other: why people DO keep one -- regulated] "In heavy regulated spaces, it is required to have traceability to formal requirements." -- Jesper Ottosen, 2025-04-23. Also Peet Michielsen: "it is required to have a well documented and maintained test case set, which forms part of the full traceability" (medical device / FDA).
Q16 [other: managers' need] "Testcases give a sense of control over testing to the managers and stakeholders." -- Rahul Parwal, 2025-04-23 (he wants them gone but expects them to persist)
Q17 [other: measurement] "I am a firm believer in the old proverb, if you can't measure it, you can't manage it." -- Gary Hawkes, 2025-04-23 (pro-TCM, for reporting and making the case for investment)
Q18 [other: trust] "Trust is the bigger factor in most cases though." -- Martin Huckle, 2025-04-24

## Source C: review sites, via search-tool summaries only (could not open pages)
(snippet, not verbatim) G2 TestRail 4.4 / 611 reviews; Capterra ~4.3 / ~177 reviews, 92% positive 6% neutral 2% negative. Recurring
negatives: slow with large projects/datasets, expensive for small teams (from $35-38/user/month), dated UI, limited customisation,
weak out-of-box reporting, clumsy integrations (Jira in some browsers), support/renewal team "absent", paywalled customer service.
Pages: https://www.g2.com/products/testrail/reviews , https://www.capterra.com/p/128204/TestRail/reviews , https://www.softwareadvice.com/app-development/testrail-profile/reviews/ , https://www.saasworthy.com/product/testrail/reviews

## Source D: Trustpilot (Gurock/TestRail), fetched, all 5 reviews are 1-star -- https://ca.trustpilot.com/review/gurock.com
Q19 [UX/reliability, price] "TestRail software is awful. It constantly goes down during the day." -- Iain, 2023-10-11
Q20 [other: time cost] "Do NOT buy this application for your organisation. It will cost you dearly in lost time and productivity." -- Carl, 2022-03-17
Q21 [speed/quality] "TestRail used to be great but since I started using it again it's been atrocious." -- Luke Bruce, 2021-07-21
Q22 [other: release quality] "Each release, they introduce worse and worse bugs" -- Liudmila, 2021-06-28

## Source E: PeerSpot TestRail (fetched; verbatim) -- https://www.peerspot.com/products/testrail-reviews , https://www.peerspot.com/products/testrail-previous-solutions
Q23 [UX/reporting] "The analytics and reporting capabilities in TestRail are not very extensive and tailorable. There are no configurable dashboards." -- Release and Test Manager, 2025-11-20
Q24 [speed, UX] "Some parts of the interface can feel dated or less intuitive, especially for new users. The second area is faster performance on large projects." -- Business Development Associate, 2026-04-19
Q25 [AI, versioning/traceability] "TestRail lacks the functionality to map test cases to requirements and risks. I would appreciate AI features that help design test cases based on documented requirements." -- Test Architect, Zest Consulting, 2025-03-27
Q26 [Jira coupling] "I have faced some issues with the integration between TestRail and Jira." -- Managing Director, Corecom Quality Engineering, 2023-09-04
Q27 [price] "TestRail should improve its pricing." -- QA Engineer, 2023-12-11
Q28 [switching reason, UX] "The reason we changed was that it was rather complex to use and there was no way to indicate at what step the case failed." -- QA Team Lead, moved from TestLink to TestRail (undated)
Q29 [switching reason, price] "We switched to TestRail because it is more flexible and cost-effective." -- IT Testing Manager, moved from HP Quality Center (undated)
Q30 [other: lukewarm] "if I had to choose a solution, it wouldn't be TestRail" -- QA Manager, financial services (undated; gave no reason)

## Source F: DEV Community / dev.to (fetched)
Q31 [speed, UX, switching] "TestRail just isn't cutting it these days in my opinion." ... "I've found Report generation to be slow" ... "I've had issues maintaining auth sessions" ... "several portions of the UI are slow or difficult to navigate" ... "feature development feels slow, held back by an aging tech stack." -- Sam E. Lawrence, "Why we migrated from TestRail to Qase", 2024-03-11, https://dev.to/samelawrence/why-we-migrated-from-testrail-to-qase-and-how-we-did-it-4n54 (note: Qase-affiliated post? author's affiliation not checked)
Q32 [UX, versioning] "We come across limitations each day due to the format of the Test Management module" ... "and how it has not changed in over a decade while testing strategies and approaches have changed." ... "I do not see any investment in the ADO Test Management module." -- dev.to commenter on Azure DevOps Test Plans, 2021-05-05, https://dev.to/briandavid7324/comment/1e741

## Source G: Ministry of Testing page 2 (fetched, 2025-04/05) -- https://club.ministryoftesting.com/t/is-test-case-management-dead/84370?page=2
Q33 [don't need a TCM] "If your tests are automated, you already have the documentation, it's in the test code." -- kato, 2025-05-12 (argues tools add overhead with little value)
Q34 [don't need a TCM] "customers, testers and the regressions we find together are the only test cases worth tracking." -- conrad.braam, 2025-05-07
Q35 [don't need a TCM, trust] Warns these tools can become a people-management tool: "adopt with caution" if used to address trust issues. -- andrewkelly2555, 2025-05-14
Q36 [don't need a TCM, lightweight] Uses a Confluence page per user story instead of formal test cases: "different contexts need it to different degrees (including if at all)." -- sebastian_solidwork, 2025-05-12
Q37 [keep a TCM] "removing test case management would introduce more chaos than agility." -- gil, 2025-05-06;  "Now everybody 'does what they want' and there is no 'proof' of the app being tested." -- kristof, 2025-05-12
Q38 [AI] LLMs now speed up generating test cases ("Many clients ask for test cases, and in such scenarios, test cases are important.") -- ujjwal.singh, 2025-05-29

## Source H: Reddit via mirror (reddit.sentinel-team.org snapshot, captured 2026-06-12) -- https://reddit.sentinel-team.org/posts/1u2zjlc/snapshots/2026-06-12T10%3A06%3A25.148721Z
Thread: r/softwaretesting "Test Management Tools Comparison (2026) - Notes From Evaluating Options For Our QA Team" (posted ~2026-01-25; 10 tools evaluated; author concluded most tools share the same basics).
Q39 [don't need a TCM] "I've used a bunch of these, and continue to fold none of them into my workflow." -- u/cyber-decker (5 pts); relies on the dev team's issue tracker, markdown and Obsidian (as summarised by fetch tool; the quote is verbatim)
Q40 [don't need a TCM, AI] "Our favorite one lately: simple markdown file with Claude." -- u/cacahuatez (2 pts)
Q41 [Jira coupling, other] Zephyr "worked well" but "attaching files to executions is a pain" (paraphrase of u/Jonothen99, 1 pt)
Second mirror, r/software "Best test management software for 2026?" (snapshot 2025-12-22, https://reddit.sentinel-team.org/posts/1pswqni/snapshots/2025-12-22T23%3A30%3A48.987823Z), paraphrased by the fetch tool: "the best tool is the one your team actually keeps up to date" (maximusprohd; says TestRail "gets heavy as suites grow", Zephyr fits "only if Jira is the whole workflow"); "the biggest tell is how easy it is to keep test cases current six months later" (stacktrace_wanderer). One commenter accuses the OP of astroturfing Tuskr (unverified).

## Source I: Open-source trackers (GitHub; issue bodies fetched with gh)
Q42 [versioning/history] "When a test case is deleted from a test run, there is no corresponding entry in the Change History page... addition and deletion of test cases from a test run should also be recorded in the history for proper traceability." -- Kiwi TCMS #4060, 2025-08-15, https://github.com/kiwitcms/Kiwi/issues/4060 (open)
Q43 [versioning/history] "Need to support the edit history when user add or delete tags for each test case." -- Kiwi TCMS #4085, 2025-09-05, https://github.com/kiwitcms/Kiwi/issues/4085 (open)
Q44 [UX] "Since History is automatically expanded this adds unnecessary information to the screen and makes tests / test run page less readable and cluttered" -- Kiwi TCMS #2285, 2021-03-05, https://github.com/kiwitcms/Kiwi/issues/2285 (open)
Q45 [speed, flaky] "when number of iterations is ~70K Allure hangs upon generation of the report ... if we wait for about 5-7 hours it finishes the generation. But the amount of time is definitely unacceptable" -- Allure #970, 2019-07-18, https://github.com/allure-framework/allure2/issues/970 (closed)
Q46 [flaky] "Using @flaky or @muted or @known tags in Cucumber Scenarios or Feature doesn't reflect in Allure report. No markers were present in the report" -- Allure #1611, 2022-03-11, https://github.com/allure-framework/allure2/issues/1611 (open)
Q47 [flaky] "Flaky test 'bomb' icon is no longer displayed in 2.10.0 ... (test that fails on first attempt and passes on retry)" -- Allure #910, 2019-03-07, https://github.com/allure-framework/allure2/issues/910 (closed)
Note: Allure's flaky model = fail-then-pass-on-retry within one run; history is a folder you must carry between CI runs (issues #697, #997, #347 ask to configure/copy history paths) -- search-listing titles only.

## Source J: Ministry of Testing "I haven't used a test management tool in 10 years" (fetched; opened 2026-02-23 by Rosie Sherry) -- https://club.ministryoftesting.com/t/i-havent-used-a-test-management-tool-in-10-years/87151
OP: "What does your quality and testing work look without test management tools?"
Q48 [don't need a TCM] Works solo, no test management tool or spreadsheet in 15+ years; "Confidence much higher". -- andrewkelly2555, 2026-02-24
Q49 [don't need a TCM] ~10 years without a tool or Excel in a fast startup; keeping docs in either was unsustainable; relied on unit/API/component tests, a thin E2E layer and monitoring; wary a tool "divides devs and QA." -- Nataliia Burmei, 2026-02-25
Q50 [don't need a TCM, UX] A TCMS was "always hard work"; defects surface via customer reports in his small team. -- conrad.braam, 2026-02-25
Q51 [don't need a TCM] Heavy tools may signal manual/low-quality QA or strict regulation; testers write cursory cases to satisfy management, so "the automation then becomes the source of truth." -- Nitin Segal, 2026-07-09
Q52 [keep a TCM, CI integration] Leads 8 QAs, daily releases, Testomat synced with E2E tests: helps "make coverage visible when changes happen fast"; spreadsheets fail quietly at scale. -- Daria Tsion, 2026-02-24
Q53 [keep a TCM] Slowness "comes from process choices, not the tools"; open APIs let automated results be posted. -- Gary Hawkes, 2026-02-28 (paraphrase of the fetch summary)

## Source K: AI sentiment
Q54 [AI] "the test itself should run deterministically -- no AI deciding what to click or what to assert at runtime." and "A passing test that's wrong is dangerous." (a self-healing tool silently re-targeted a selector and a test clicked the wrong button for three weeks) -- Jason Merx, 2026-05-07, https://club.ministryoftesting.com/t/where-would-you-trust-an-ai-to-write-your-tests-and-where-absolutely-not/87298
Q55 [AI] "An AI-generated test without a human-authored 'why' behind it is, in my opinion, a liability." -- Ruslan Strazhnyk, same thread, 2026-04-20. Also conrad braam: "anywhere up to 50% of our tests are just tests that are trying to increase code-coverage" (2026-04-20).
Q56 [AI] Reddit r/ExperiencedDevs "My teammates are generating enormous test suites now" (2025-12-16, via mirror https://reddit.sentinel-team.org/posts/1po8uud/snapshots/2025-12-16T18%3A40%3A48.670375Z): top comment u/sidonay (41 pts) says the tests feel "soulless" and repetitive; u/rofolo_189 (12 pts): bloated test code is still code to maintain and AI tests check implementation details instead of behaviour (paraphrase by fetch tool).

## Source L: flaky tests and CI dashboards (HN)
Q57 [flaky] "I've seen attempts to 'fix' flaky test suites by retrying failing tests 5 times until they pass. What happens: You just set a new baseline of shit allowed. This allows even more noise to enter the system..." -- HN, 2024-07-29, https://news.ycombinator.com/item?id=41098517
Q58 [flaky, price] "If Cypress users want to view a dashboard or session replay of their failed or flaky tests, they'll need to pay for Cypress Cloud which can easily be 6 figures." -- HN, 2023-10-11, https://news.ycombinator.com/item?id=37846779
Q59 [flaky] "if a test is 'flaky', it gets looked at very quickly, and if it's not urgent ... it's skipped in code. Once the test is skipped, a domain expert can come back and take a look" -- HN, 2021-10-28, https://news.ycombinator.com/item?id=29030790 (a team handling flakes with code and skips, no dashboard)

## Source M: more review-site material
Q60 [Jira coupling] "It doesn't allow you to connect to multiple different bug tracking tools at the same time." -- Test Team Lead, PractiTest, PeerSpot, 2020-12-22, https://www.peerspot.com/products/practitest-reviews
Search-tool snippets, NOT verbatim-verified (search summary quoted them; pages unopened/blocked):
S1 [CI integration] Software Advice TestRail reviewer: "at this stage have stopped integrating our CI test runs into the tool" (undated), https://www.softwareadvice.com/user-testing/testrail-profile/reviews/
S2 [price/seats] Software Advice reviewer: only the testing team had TestRail accounts, "while the rest of R&D didn't."
S3 [UX, adoption] StackShare 2022 post: "the rest of the team did not want to go through the exercise of learning how to configure the application for our needs", https://stackshare.io/posts/107895990229145944 (page returned 429 to me)
S4 [speed, other] Gartner Peer Insights TestRail: "Performance issues and bugs have impacted our workflow, and some of our feature requests have remained open for a long time without resolution." https://www.gartner.com/reviews/market/application-development-integration-and-management-others/vendor/idera/product/testrail (403 to me)
S5 [speed] Atlassian Community, Xray: "pretty painfully slow sometimes and I have to refresh the ticket multiple times to get the x-ray fields to display"; another: "really slow on cloud and had barely any reporting" (threads https://community.atlassian.com/t5/Jira-questions/X-Ray-too-slow-while-using-via-jira-cloud/qaq-p/1640272 and .../XRAY-is-slow/qaq-p/2499917; pages are JS-gated, text not retrieved)
S6 [speed, Jira coupling] Atlassian Community "Zephyr integration very slow" (2024-01) and "Is there any usable Test management system on Jira cloud?" (https://community.atlassian.com/t5/Jira-questions/Is-there-any-usable-Test-management-system-on-Jira-cloud/qaq-p/2788151): titles only, bodies not retrievable.
S7 [other: vendor claim] Azure Test Plans: add-on licence per user; every test is an Azure Boards work item (TestCollab marketing, not independent).

## Theme tally (Q1-Q60 verbatim/near-verbatim items; an item can carry two tags; S-items excluded)
price/seats: Q1 Q2 Q3 Q27 Q29 Q58 = 6
speed: Q21 Q24 Q31 Q45 = 4 (S4 S5 S6 add 3 unverified)
UX: Q1 Q7 Q19 Q24 Q28 Q31 Q32 Q44 Q50 = 9
versioning/history/traceability: Q25 Q32 Q42 Q43 = 4 (Q15 Q17 regulated-traceability are "keep" arguments)
CI integration: Q47-ish none verbatim; Q52 = 1 (S1 unverified); the CI-coupling theme shows up mostly as "tests in code" below
flaky tests: Q8 Q45 Q46 Q47 Q57 Q58 Q59 = 7
Jira coupling: Q6 Q26 Q41 Q60 = 4 (S6 unverified)
AI: Q3 Q8 Q9 Q25 Q38 Q40 Q54 Q55 Q56 = 9
don't need a TCM (tests in code / lightweight / markdown): Q4 Q5 Q9 Q10 Q11 Q12 Q13 Q14 Q33 Q34 Q35 Q36 Q39 Q40 Q48 Q49 Q50 Q51 = 18
keep a TCM (regulated, scale, proof, visibility): Q15 Q16 Q17 Q18 Q37 Q52 Q53 = 7
other (reliability, release quality, time cost, support): Q19 Q20 Q22 Q23 Q30 = 5
