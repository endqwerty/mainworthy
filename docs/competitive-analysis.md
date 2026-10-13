# Competitive analysis

Researched 2026-10-10 from vendors' own pricing and feature pages. Prices are
USD list prices on that date and change often; re-check before relying on one.

**Evidence labels**

- **Verified**: read on the vendor's own page on the date above (source linked).
- **Reported**: from reviews or third-party blogs, which often sell a rival
  product. A hypothesis until checked.
- **Open**: could not be established. See [What is not checked](#what-is-not-checked).

[competitors.md](competitors.md) holds the original hypotheses and Daniel's
notes, which override anything here.

## Landscape

| Tool | Type | Hosting | Entry price | Free tier |
| --- | --- | --- | --- | --- |
| [TestRail](#testrail) | standalone | cloud; on-prem from Professional | $22/user/mo (max 5 users) | no, 30-day trial |
| [Qase](#qase) | standalone | cloud | $35/user/mo annual | yes, 4 users |
| [Testmo](#testmo) | standalone | cloud | $59/mo for 5 users | not seen |
| [Testiny](#testiny) | standalone | cloud; on-prem | $18.50/user/mo | yes, 3 users |
| [Testomat.io](#testomatio) | standalone | cloud; on-prem (Enterprise) | $27/user/mo annual | yes, 2 users |
| [PractiTest](#practitest) | standalone | cloud | $47/user/mo annual | trial only |
| [Allure TestOps](#allure-testops) | standalone, automation-centred | cloud or on-prem | $39/user/mo | trial only |
| [Tricentis qTest](#tricentis-qtest) | standalone, enterprise | cloud | quote (reported ~$82/user/mo) | trial |
| [Xray](#xray-jira) | Jira app | Jira Cloud / Data Center | tiered by Jira user count | 30-day trial |
| [Zephyr](#zephyr-jira) | Jira app | Jira Cloud; Enterprise standalone | tiered by Jira user count | trial |
| [Azure DevOps Test Plans](#azure-devops-test-plans) | suite module | Azure DevOps | $52/user/mo (incl. Basic) | 30-day trial |
| [Kiwi TCMS](#kiwi-tcms) | open source | self-host or hosted | $35/mo self-support | self-host |
| [TestLink](#testlink) | open source | self-host | free | self-host |

## Competitors

### TestRail

The incumbent. Folder/section structure, plans, runs, reporting.
[Pricing](https://www.testrail.com/pricing/):

| Plan | Price (annual) | Users | API | Notes |
| --- | --- | --- | --- | --- |
| Essentials | $22/user/mo | max 5 | 100 req/min | cloud only; custom fields |
| Professional | $38/user/mo | unlimited | 180 req/min | cloud or on-prem; RBAC, scheduled reports |
| Enterprise | $78/user/mo | unlimited | 300 req/min | SSO, audit log, **test case versioning**, approval workflows, 500 GB |

- **Verified:** case versioning and audit logs exist only on Enterprise, at
  about 2x the Professional price. SSO and MFA are Enterprise-only. API is
  rate-limited by tier. No permanent free plan. Per-seat pricing, every user.
- **Reported:** slow with large suites and concurrent users, dated UI, slow
  or limited reporting, expensive for small teams, traceability and bug
  tracking need other tools ([Testsigma](https://testsigma.com/blog//testrail-alternatives/),
  [PeerSpot](https://www.peerspot.com/questions/what-needs-improvement-with-testrail-by-gurock),
  [G2](https://www.g2.com/products/testrail)).

### Qase

Modern UI, the closest to what Mainworthy wants to feel like.
[Pricing](https://qase.io/pricing):

| Plan | Price | Notes |
| --- | --- | --- |
| Free | $0 | 4 users, 2 projects, 2 active runs, 500 MB, 30-day history, no custom fields, no traceability, no reports |
| Teams | $35/user/mo annual, $42 monthly | 5+ seats, 2-year history, custom fields, requirements traceability, reports, review, SSO (one workspace), 600 req/min |
| Enterprise | quote | unlimited history, audit logs, SCIM, 1,000 req/min |

- **Verified:** history retention is a pricing lever (30 days, 2 years,
  unlimited). Custom fields, traceability and reports are paid-only. A
  **$10/user/mo collaborator seat** (view and comment) exists, so viewer
  pricing is a known pattern. Audit logs are Enterprise-only. AI credits are
  metered.

### Testmo

[Pricing](https://www.testmo.com/pricing): flat per-plan price with users
included, not per seat.

- **Verified:** Team $59/mo (5 users), Business $249/mo (15 users; reporting
  center, custom RBAC), Enterprise $599/mo (25 users; SSO, audit log). Extra
  users cost more; the exact figure was not readable on the page. 15% annual
  discount.
- Shows a team-sized flat price is workable. Mainworthy's "no per-seat tax for
  readers" principle is not unique.

### Testiny

[Pricing](https://testiny.io/pricing):

- **Verified:** Free (3 users, 1,000 items total, no history, no custom
  fields); Starter $18.50 (adds history, custom fields); Business $20.50
  (milestones, SSO); Enterprise $30 (audit log, custom roles). **Viewer seats
  are about 20% of a user seat.** On-prem from $300/user/year.
- History is gated off the free tier here too.

### Testomat.io

[Pricing](https://testomat.io/pricing/):

- **Verified:** Free (2 users, 2 projects), Professional $27 annual / $30
  monthly per user (AI features, CI and tracker integrations), Enterprise by
  quote (SSO, on-prem, **branches and versioning**).
- Leans on automation: Playwright/Cypress reporting, AI generation, MCP server.

### PractiTest

[Pricing](https://www.practitest.com/pricing/):

- **Verified:** Team $47/user/mo annual (5 comment users per license).
  Corporate by quote, minimum 10 licenses, annual only. Includes
  traceability and coverage reporting; audit log sits in a separate
  Control & Compliance pack.
- **Open:** which features belong to which plan was not clear on the page.

### Allure TestOps

[Pricing](https://qameta.io/pricing/): **Verified** $39/user/mo, same price
cloud or on-prem. Automation-centred (CI sync, results from Allure reports).
Seat minimums and annual terms were not visible.

### Tricentis qTest

- **Reported:** enterprise product (Manager, Insights, Copilot modules),
  quote-based. Figures conflict: about $82/user/mo
  ([FitGap](https://us.fitgap.com/products/tricentis-qtest)) versus a $1,000
  starting price ([Capterra](https://www.capterra.ca/software/173762/qtest)).
  Reviewers say cost escalates with users and modules.
- **Open:** the Tricentis page could not be fetched; nothing here is first-party.

### Xray (Jira)

Tests are Jira work items. Cloud has Standard and Advanced editions;
Enterprise is a separate app with its own licence.

- **Verified:** priced by **total Jira users on the site**, not by testers
  ([Xray vs Zephyr](https://www.getxray.app/xray-vs-zephyr/),
  [editions](https://docs.getxray.app/space/XRAYCLOUD/393183414)). Xray's own
  comparison lists $728/mo for 100 users on Standard and $874 on Advanced.
  **Test case versioning is an Enterprise feature**, and downgrading stops it
  working. Standard has 60 req/min and 100 GB, Advanced 100 req/min and 250 GB.
- Xray's page claims Zephyr "uses its own testing data model" and that Xray's
  Jira-native tests let non-testers act on them. That is marketing from a rival.
- **Reported (hypothesis, unchanged):** tests as issues clutter backlogs and
  boards.

### Zephyr (Jira)

SmartBear. Zephyr Essential (formerly Squad), Zephyr Standard and Advanced
(Scale lineage), Zephyr Enterprise (standalone, bi-directional Jira sync,
starts at 20 users, custom price), QMetry (standalone).

- **Verified:** [SmartBear's pricing page](https://smartbear.com/test-management/zephyr-scale/pricing/)
  lists no prices. Higher tiers add no-code automation, record and play, data
  residency. Jira-user-tiered like Xray; Xray's page shows near-equal totals.
- **Reported:** product naming has changed several times; SmartBear
  community threads show buyers confused about pricing.

### Azure DevOps Test Plans

- **Verified:** [Basic + Test Plans is $52/user/mo](https://azure.microsoft.com/en-us/pricing/details/devops/azure-devops-services/)
  (page also mentions $6 for additional users; unclear). Basic users can run
  tests and use exploratory testing but **cannot create or manage Test Plans**.
- **Reported (hypothesis, unchanged):** confusing plans/suites/configurations
  model, clunky authoring, hard outside ADO.

### Kiwi TCMS

- **Verified:** [open source](https://kiwitcms.org/); self-support $35/mo,
  private tenant SaaS $150/mo, on-prem enterprise $600/mo, managed $2,000/mo.
  Docker, JSON-RPC and XML-RPC API, GitHub app, bug-tracker integrations.
  Licence not named on the page. Import support not described.

### TestLink

- **Reported:** GPL, PHP, long-lived; a 1.9.20 build dated 2025-12-08 is
  listed on a release tracker. Reviewers call the UI dated. Confirm on
  [testlink.org](https://testlink.org) before citing.

## Cross-cutting findings

1. **History is gated almost everywhere.** TestRail (Enterprise), Xray
   (Enterprise), Qase (retention by plan), Testiny (paid), Testomat.io
   (Enterprise). Mainworthy principle 1 (case as a versioned document) is a
   real gap, verified on five tools.
2. **Per-seat pricing is universal, with a viewer discount in some.** Qase
   ($10 collaborator), Testiny (~20%), PractiTest (comment users). Testmo uses
   flat tier pricing. Jira apps price on all Jira users, which penalises
   readers by design.
3. **Free tiers are small and strip the valuable parts.** History, custom
   fields, traceability and reports are removed first.
4. **API rate limits are a tier feature** (TestRail 100 to 300, Qase 150 to
   1,000, Xray 60 to 100 req/min). Mainworthy principle 6 (everything has an
   API) can be a differentiator if limits are generous.
5. **MCP servers are appearing** (Qase, Testiny, Testomat.io, PractiTest
   list one; Qase includes it on the free plan). Only the existence was
   seen on pricing pages, not depth: whether they cover authoring and
   running or only reading, scoped tokens, or agent identity in history is
   **open**. Agent access is Mainworthy's priority 2
   ([product-vision.md](product-vision.md)), so test these servers hands-on
   before assuming parity or a gap.
6. **Self-hosting is rare and expensive** except Kiwi TCMS and TestLink, both
   of which are dated or basic. A modern self-hosted tool has a clear opening
   if Daniel wants to host on the home server (open question 2).

## What is not checked

- Xray and Zephyr per-tier list prices (Marketplace pages not fetched).
- qTest first-party pricing and features.
- Any claim about performance at tens of thousands of cases: only reviews,
  no measurement. A benchmark against TestRail or Qase needs trial accounts.
- Import and export formats of every tool (relevant to open question 5).
- Depth of competitors' MCP servers (finding 5).
- Daniel's own experience with each tool.
- Smaller vendors not covered: TestMonitor, Tuskr, TestCollab, Squash TM,
  Kualitee, aqua cloud.
