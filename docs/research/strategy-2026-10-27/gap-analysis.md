# Release-gated customer gap analysis

Research completed 2026-10-27 by GPT 6 Astra (high), reading the repository at `52c7b5d7` (`main` plus the strategy
review of #1024) and the open issues. It answers one question: for the customer the owner chose (teams moving to
CI/CD that still gate releases, `docs/decisions/2026-10-27-the-customer-is-release-gated-teams-moving-to-ci-cd.md`
in #1024), what exists today and what is missing. Statements come from reading source and guides, not from running
the product; no compliance validation is claimed. Its eight proposals are filed as #1026 to #1033.

## Confirmed early findings

- Automation rate and manual execution cost are already implemented. `src/server/ops/stats.ts:111` computes automation; `src/server/evidence/stats.ts:132` counts cases with any linked automated test, and `:135` counts human results and sums known durations. The backlog sorts by run frequency before time. This is current linkage, not evidence of recent successful automation or a historical rate.
- Planned runs default to human-or-auto evidence, one actor, policy basis. See `src/server/runs/runs.ts:1805`, `src/core/runs.ts:42`. Linked auto results are eligible independently of the case's declared methods, subject to run methods, target and basis checks, per `src/server/runs/runs.ts:1162`.
- Audit NDJSON exists, with checksum/reference verification and decision signers. The guide explicitly says it lacks signatures with reauthentication and meaning, retention, legal hold and recorded text redaction. See `docs/guide/data.md:266`. Merge-receipt manifests alone do not export all frozen evidence (`:183`).

Detailed evidence and issue recommendations follow below.

## Findings by design implication

References below are repository-relative `file:line` at the revision above. The requested decisions, product vision, roadmap and strategy review were read alongside the code. Current code takes precedence over older roadmap or issue claims. No files in a checkout were edited, no tests or servers were started, and no GitHub mutations were made.

### 1. Manual and automated tests in one place

**Exists.** `CaseBody.methods` admits human, automated and agent execution, with a separate automation intent (`src/core/model.ts:62`). All reported results use the same evidence writer and store method, actor, target, outcome, case basis and optional duration (`src/server/evidence/evidence.ts:297`). The CLI sends reports through the registry operation (`src/cli/commands/report.ts:1`; `src/server/ops/index.ts:29`); the web run recorder sends the same operation (`src/web/runs/cockpit.tsx:563`). JUnit and native runner imports are documented in `docs/guide/report-results.md`; manual execution is in `docs/guide/runs.md:117`.

Planned runs pin cases and count qualifying existing and later results. A release run can name an immutable build label and artifact digest, with an environment. `src/server/evidence/releases.ts:58` resolves that target; `:78` records deployment announcements and source attestations. `docs/guide/runs.md:301` gives an executable announce, plan, report and gate workflow. Source-commit results do not count as artifact execution (`:349`). That distinction is useful for a release lead and should remain.

**Partial.** A commit gate and a planned release gate are different selections. A green commit gate is not a declaration that all release requirements were exercised. `gate --run R-2` is the existing release check. `announce` records a deployment fact without requiring an approved release run (`src/server/evidence/releases.ts:78`); connecting deployment authorization to a chosen approval is the customer's pipeline's responsibility today. Do not imply Mainworthy automatically prevents production deployment.

Known adjacent bug: [#987](https://github.com/endqwerty/mainworthy/issues/987) reports that the cockpit's work selection includes cases that do not admit the current actor's method. Its issue explicitly describes source inspection, not a browser reproduction. This research did not reproduce it either.

### 2. Push toward automation

**Per-case signal: partial, not absent.** Every case's Proof block has person, pipeline and agent rows, showing the latest result's outcome, version, basis, producer and age (`src/web/case/pane.tsx:399`). Suite rows also render a Proof strip (`src/web/suite/index.tsx:2632`). The read API can return a case's currently linked automated tests with refs, names and files (`src/server/ops/reads.ts:310`). Tests has a linked-case/read-results view (`src/web/tests/index.tsx:77`, `:222`). Guide: `docs/guide/write-cases.md:181`, `docs/guide/report-results.md:242` and `:330`.

These answer different questions. Proof is historical evidence, not an explicit current-link inventory. A pipeline proof can survive a later unlink; a new link can exist without a qualifying proof. The case pane has no clear current "covered by N automated tests" list based on that inventory. Automation intent and permitted methods are editable (`src/web/case/pane.tsx:945`, `:969`), but declaring auto does not demonstrate coverage. No complete last-reported/stopped-reporting coverage workflow was established. A stale case-version proof is not the same as a linked test that stopped running.

**Automation rate: exists.** `src/server/ops/stats.ts:99` counts active cases with at least one currently linked auto test. It excludes unlinked cases marked not-applicable from the denominator, but counts such a case if an auto test covers it. `src/server/evidence/stats.ts:132` uses current test linkage, without a recency or successful-execution condition. `src/web/reports/index.tsx:447` renders the rate and counts. Guide: `docs/guide/reports.md:86`.

The day window changes manual-run counts, not the automation numerator. There is no historical automation-rate series or folder/tag/requirement scope in `src/core/stats.ts:44`. The original product vision asks for those, but the new decision's basic rate requirement is already met. An old linked test still contributes even if it has not reported recently; label that metric as linkage coverage rather than release proof.

**Manual-run cost: partial.** The automation backlog already includes human-result count and the sum of reported durations in the chosen window, excluding corrected results (`src/server/evidence/stats.ts:135`). It sorts by number of runs, then known total duration, then wanted intent (`src/server/ops/stats.ts:131`). The UI accurately calls it "Backlog: run by hand most often" and shows Runs by hand and Time (`src/web/reports/index.tsx:467`). Guide: `docs/guide/reports.md:92`.

Limitations matter in daily use:

- The web manual recorder sends no `durationMs` (`src/web/runs/cockpit.tsx:563`), although the result contract accepts it (`src/core/ops.ts:74`). Ordinary web testing therefore adds frequency but no effort measurement.
- Sum of known durations is not total effort when some results are untimed. The SQL only returns NULL when every duration is absent. The reply has no timed/untimed execution count or average (`src/core/stats-replies.ts:66`).
- A case with any linked auto test is removed from the backlog, even if people still spend hours running it (`src/server/ops/stats.ts:113`). That hides duplicated manual work during migration.
- Highest frequency is not highest cost. There is no cost-first sort, time per execution, or labour-cost model. Monetary cost is not necessary for the first useful improvement.
- Counts are human result records in a time window, not necessarily distinct planned runs. The guide's wording should preserve that distinction.

**Automated substitution: exists.** The default exercise obligation admits `human` and `auto`, needs one actor and uses the policy basis (`src/server/runs/runs.ts:1805`). A linked or annotated auto result is admitted independently of whether the case declares auto (`:1162`); the run must still permit that method. `src/core/runs.ts:339` checks the same case and pinned version, permitting assumed basis only when configured, or matching claim hash under same-claim. Target matching is performed by the caller. Guide: `docs/guide/runs.md:198`, with an exact-basis example at `:230`.

A CI pass can therefore replace the need to perform an unfilled manual exercise. It does not erase an existing contradictory manual failure. Aggregation retains independent producers' evidence (`src/core/runs.ts:276`); a dispute needs resolution. Strict basis requires a named version, not merely a link. No new substitution engine is needed.

### 3. Traceability and audit trail

**Requirement records and links exist, but there is no controlled requirement baseline.** Requirements currently have a key and title; adoption inserts them and current covers links, while unlink removes the current covers row (`src/server/suite/suite.ts:376`). The insert uses ON CONFLICT DO NOTHING. Cases link requirements through Markdown `covers` or capture `@KEY`, and changes pass through proposals/decisions. `CaseBody` itself contains no covers list; covers is separate document metadata (`src/core/model.ts:62`, `:110`). Do not assume a case version alone freezes its requirement links.

The requirement report lists current active cases and their latest outcomes in the window (`src/server/ops/stats.ts:149`, `src/server/evidence/stats.ts:149`). It does not select a release target, pinned case version or approval. Its SQL joins current `tests.case_id`; this is not reconstruction from each historical result's immutable `basis_case`. An unrelated target's latest result can therefore affect this report. Guide: `docs/guide/reports.md:97`. Open [#41](https://github.com/endqwerty/mainworthy/issues/41) correctly calls out the prescribed requirements workflow, matrix, release gaps, deployment chain and gap questions. [#32](https://github.com/endqwerty/mainworthy/issues/32) separately owns external requirement mirroring. No need to add another issue merely saying "build coverage reports".

**Case versions on results: explicit but not always exact.** Evidence stores `basis_case`, `basis_version`, `basis_claim`, and exact/assumed/unresolved (`src/server/evidence/evidence.ts:122`, `:297`). The writer resolves explicit/pinned versions as exact, uses the current head as assumed without a version claim, and preserves rejected report claims as unresolved where applicable (`:1633`). The UI exposes basis. Guide: `docs/guide/report-results.md:351`. Linking later does not retroactively supply a missing original basis. A requirement for exact evidence must select exact admission and arrange version claims in CI; a label saying every result has an exact version would be false.

**Sign-off and history exist; frozen release approval is missing.** A passing planned run raises sign-off; strict asks a person with a reason (`src/core/presets.ts:106`, `:114`; `docs/guide/runs.md:263`). Named-role requirements and producer exclusion are expressible (`src/core/kinds.ts:340`, `:515`), but there is no approval quorum in Ask. `minActors:2` is two execution producers, not two approvers. Strict sign-off itself does not set notProducer, so it should not be described as independent approval by default.

Closing writes state and signoff decision id (`src/server/runs/runs.ts:1953`). A qualifying late upload to a closed commit run can invalidate the prior approval and require sign-off again; the historical decision remains (`docs/guide/runs.md:270`). This is coherent mutable-run behaviour, but not a frozen approved release dossier. Open [#53](https://github.com/endqwerty/mainworthy/issues/53) owns quorum, freeze, gaps and the regulated preset. `Kind` has adopt, map, failure, finding and signoff, but no gap (`src/core/kinds.ts:15`).

**Do not overlook existing frozen merge receipts.** `src/core/changes.ts:25` defines an immutable gate snapshot with policy version, counts and hash. Its frozen result rows include result/test/target, outcome, method, standing, and supporting decision (`:40`). They omit case basis/version and requirement membership. A merge receipt is evidence of the gate when the merge was reported, not a planned-release approval snapshot. This is reusable machinery, not the missing feature already solved.

**Exports: substantial machine-readable foundation, incomplete auditor package.**

- Instance/project archives are plain or gzip NDJSON with tables, IDs and hashes, including results, requirements, covers and deployment records. Guide: `docs/guide/data.md:81`, `:105`, `:373`. They are backup/data portability exports, not an auditor-oriented release narrative.
- `mainworthy audit export` writes canonical UTF-8 NDJSON format 1 for a project and time interval; `audit verify` runs offline. The CLI verifies the returned file before writing it (`src/cli/commands/audit.ts:41`, `:67`). Guide: `docs/guide/data.md:120`.
- Audit records include decisions, answer history, policy versions, case-version bodies/hashes, limited result context and merge-receipt manifests. `src/server/transfer/audit.ts:99` exports result contexts for inherited evidence; the result schema lacks case basis/version (`src/core/audit.ts:92`). Neither the audit record types nor receipt result schema provide a complete requirement-to-result join.
- Full receipt payloads require separate paged exports and the supporting decision history. The manifest alone is insufficient (`docs/guide/data.md:183`). The checksum and references prove internal consistency, not source authenticity or that every database record was included (`:254`). No electronic or external provenance signature is established by these hashes. The result field named `signature` is a failure-signature id, not a person's signature.
- A decision records actor, clause, policy version and reason; this is attribution, not a signing ceremony. The guide explicitly lacks re-authenticated signatures with meaning, product retention, legal hold and recorded text redaction (`:266`). [#40](https://github.com/endqwerty/mainworthy/issues/40) owns those gaps. Historical personal grants are incomplete, and names reflect export time, limiting proof of historical signatory eligibility (`:155`, `:258`).

There is no single export that presents a chosen release's requirement baseline, pinned cases, all admitted results with basis, exceptions, approval and artifact/deployment chain as a readable complete package. There is also no web audit export button (`docs/guide/data.md:138`). Existing charts are rolling project reports, not signed release-specific charts. These are the largest gaps for management sign-off and an auditor.

### 4. Agent access stays

**Exists.** The registry selects MCP operations from the same operations used by CLI/HTTP (`src/server/ops/index.ts:1`, `:72`). Agents have their own identity and grants. Ten tools read, author, review, report, answer and take run work; `docs/guide/agents.md:9`, `:68` lists them and the shipped skill. Case proof and results retain agent attribution. Agent results only fill runs explicitly admitting agents; they never count toward commit gates (`src/server/runs/runs.ts:859`; `src/core/runs.ts:329`). This is a deliberate boundary, not a broken automation path.

**Partial.** Not every operation is an MCP tool: stats explicitly uses CLI/HTTP (`src/server/ops/stats.ts:198`; `docs/guide/reports.md:19`). Build targets are omitted from MCP report schema with planned runs as the documented path (`src/core/ops.ts:113`). These are workable paths, not grounds to enlarge MCP by default. [#957](https://github.com/endqwerty/mainworthy/issues/957) covers personal ownership and adjustable access for an agent; [#43](https://github.com/endqwerty/mainworthy/issues/43) covers complete jobs in two clients. The latter is not yet demonstrated by protocol/token tests. Any release traceability additions should remain usable through registry operations so an agent can assemble and inspect the same evidence.

### 5. A feature needs this customer

The accepted freeze decision and `docs/roadmap.md:30` narrow work to gated/regulated teams. M8 and iPhone issues sampled from the live list now carry deferred. Existing teams and policy remain; the decision freezes new loose-policy work, not removal of the engine. At the inspected checkout, native-app files and several non-OIDC sign-in modules still exist, so the accepted deletion decisions are not proof that deletion is already implemented.

The open issue list was read with `gh issue list --state open --limit 200`, including full bodies for the inventory and targeted rereads of #41, #53, #40, #64, #987, #957 and #43. The core customer gaps already have umbrellas in [#41](https://github.com/endqwerty/mainworthy/issues/41), [#53](https://github.com/endqwerty/mainworthy/issues/53) and [#40](https://github.com/endqwerty/mainworthy/issues/40), all still deferred in the queried list. No dedicated open issue title was found for manual duration capture, cost-first automation reporting or explicit per-case current automation coverage. This is an inventory observation, not proof those details appear nowhere in issue comments.

There is planning drift to reconcile: [#64](https://github.com/endqwerty/mainworthy/issues/64) still says M8 can start, while the later accepted freeze says it cannot. `docs/roadmap.md:40` retains the older "starts after hosting" sentence, although `:53` and `:73` freeze M8. Follow the accepted decision; do not restart frozen work because the older queue says so. Neither repository checks nor code can mechanically establish whether a proposed feature serves this customer; this remains a prioritization judgment.

## What a QA lead at a DO-200B shop would encounter on day one

This is a practical assessment against the customer's stated traceability/sign-off job, not a claim that DO-200B mandates a particular feature. The standard, the shop's approved process, data quality requirements and tool-use assurance obligations were not evaluated. DO-178C, DO-200B, ISO and Part 11 are not interchangeable checklists.

The lead can import case snapshots, link requirement keys, ingest CI evidence, plan a run on a specific artifact, require exact case versions, get human sign-off and retrieve the decision ledger. They can already show rolling pass-rate charts (`src/web/reports/index.tsx:240`). The likely first blockers are:

1. "Which approved set of requirements does release 1.4 claim to meet?" Current keys/titles and mutable covers links do not supply a versioned requirement baseline or a controlled release scope. Importing cases does not reconstruct prior execution or approval history (`docs/guide/data.md:353`).
2. "Show me every requirement's evidence on this exact artifact and environment." The project coverage report combines current links and latest results in a period; the lead would have to assemble a release matrix externally and distinguish exact, assumed, missing and unresolved evidence themselves.
3. "Keep what management approved unchanged." Late qualifying uploads can legitimately change a closed run's evidence and reopen approval. Frozen merge receipts are useful but do not capture the planned release's complete requirement/case chain.
4. "Give the auditor one readable package." NDJSON and paged receipt records require technical assembly, do not include the whole release traceability chain, and do not provide signed release charts. An offline checksum is not an authenticated signatory or verified provenance.
5. "Require the people our procedure names to approve." One role-based approval is possible. Two independent approvals, a ceremony with signature meaning, and complete historical eligibility evidence are absent. Which of those the shop actually requires remains open.
6. "Which manual work should we automate next?" A rate and run-frequency backlog exist, but ordinary web testers record no effort, partially timed totals look complete, and cases with automation disappear from the backlog even if manual repetition continues.

Retention/legal hold, customer validation documents, evidence authenticity and external requirement synchronization remain explicit follow-up questions. They should use [#40](https://github.com/endqwerty/mainworthy/issues/40), [#41](https://github.com/endqwerty/mainworthy/issues/41) and [#32](https://github.com/endqwerty/mainworthy/issues/32) once the pilot's procedure establishes the need. Do not present a Part 11 signing ceremony as a proven DO-200B requirement.

## Ordered issue proposals

These are proposals only. They were filed afterwards as #1026 to #1033, in this order. S means a narrow change using existing contracts; M means several coordinated code/UI/guide changes; L means a new historical contract plus migration/export work. These sizes are judgment, not measured schedules. Each slice should use the registry, add a representative demo case, and update the relevant guide. The order prioritizes trustworthy release evidence; items 6–8 can proceed independently of the release work.

1. **Requirements: pin a requirement baseline to a release run** — M. Part of [#41](https://github.com/endqwerty/mainworthy/issues/41).
   - Why: a lead must state the release's intended requirements, including requirements with no cases. Selecting existing cases alone cannot reveal an omitted requirement.
   - Build on: requirement keys/titles, covers decisions, planned-run version pins and artifact targets. Keep the first slice to a named immutable snapshot of selected requirement content and links; defer a general external requirements editor and synchronization.
   - Acceptance: choose a baseline including one uncovered requirement; retain its key/title, explicit source revision when supplied, selected case links and pinned case versions. Later case edits and cover unlink/relink operations do not alter that baseline. Unknown external revisions remain unknown, never invented. CLI/API and web show the same baseline identity.

2. **Runs: keep the evidence approved at release sign-off** — L. Part of [#53](https://github.com/endqwerty/mainworthy/issues/53).
   - Why: management must be able to recover exactly what it approved after later reports or policy changes.
   - Build on: signoff decisions, run pins, merge-receipt snapshot hashing and paged evidence. Retain the existing mutable run for continuing work; add a complete immutable approval snapshot tied to item 1's baseline and artifact/environment.
   - Acceptance: approve a run containing manual and exact automated evidence, then send a late failure/correction, change policy and edit a case. The approved snapshot's bytes, requirement links, versions, counted result IDs, basis, dispositions and approving decision remain unchanged and readable. The current run can require a new approval, which references a distinct snapshot. A checksum or row count alone is insufficient.

3. **Requirements: show coverage and missing evidence for one release** — M. Part of [#41](https://github.com/endqwerty/mainworthy/issues/41).
   - Why: a release lead needs a matrix and gap list for the candidate being approved, rather than a recent project-wide trend.
   - Build on: item 1's baseline, qualifying planned-run slots, existing coverage view and basis admission. Start with visibility of gaps; do not bundle a general waiver policy into this slice.
   - Acceptance: every baseline requirement appears with its pinned cases, admitted results, case versions, artifact/environment and gap reason. A passing result from another commit/environment or an inadmissible version cannot turn the row green. Distinguish no case, no admissible result, failure, excused result and assumed basis. A linked automated pass fills the same required exercise without a duplicate manual run. A report on an approved snapshot remains unchanged after late evidence. Show release-specific totals beside the table, with rows that explain every count.

4. **Audit: export one complete, readable release evidence bundle** — L. Part of [#41](https://github.com/endqwerty/mainworthy/issues/41) and [#40](https://github.com/endqwerty/mainworthy/issues/40).
   - Why: a lead must hand an auditor a package that can be understood and checked without a live database or manual page assembly.
   - Build on: items 1–3, audit NDJSON verifier, archive streaming, receipt pagination, decision ledger and artifact/deployment records. Use a canonical machine-readable bundle plus a static readable report with the release totals/chart and traceability table. Do not invent a new cryptographic identity system in this issue.
   - Acceptance: one command or web action exports the baseline, requirement/case links, exact case bodies/versions, admitted result basis, outcomes, attachments or explicit missing-byte declarations, supporting decisions, approving actors/reasons/policy, artifact and relevant deployment references. It follows every evidence page automatically. Offline verification detects missing pages/records and changed bytes; the readable totals reconcile with the records. Export and rendering remain identical in substance after later writes. Document source-authentication and signing limits plainly.

5. **Sign-off: require two independent approvers on the same release evidence** — M. Part of [#53](https://github.com/endqwerty/mainworthy/issues/53).
   - Why: serves teams whose release procedure needs independent QA/management approval, without confusing execution count with approval count.
   - Build on: named-role Ask rules, reason requirements, producer exclusion, answer ledger and the frozen evidence identity from item 2.
   - Acceptance: two eligible distinct people approve the same snapshot before it becomes approved; one person's duplicate answer, an excluded producer and an agent do not meet the quorum. Evidence changing between approvals requires a fresh matching approval set. Record both identities, reasons, role/policy basis and evidence identity consistently through web, CLI and API/MCP. Keep the one-person path available. This slice does not claim an electronic signature ceremony; that remains a separate, concrete scope under #40 if the pilot needs it.

6. **Runs: record the time spent on a manual result** — S.
   - Why: cost reporting cannot guide automation if the ordinary manual execution UI never captures effort.
   - Build on: existing `durationMs`, result corrections and the cockpit report payload. Start with an optional explicitly entered duration; a pause/resume timer is unnecessary for this first slice.
   - Acceptance: a web tester records a duration and sees it in the saved result and automation statistics. No duration remains unknown; zero remains zero. Retry cannot double count, correction has a defined duration replacement rule, and reopening a screen does not manufacture elapsed effort. API/CLI durations use the same units and limits. Demo includes timed and untimed human results.

7. **Reports: rank manual work by reported effort and show missing timings** — M.
   - Why: prioritize the manual work that costs most, including work still repeated after an automated counterpart exists.
   - Build on: `runsByHand`, automation backlog, item 6 and current paginated report UI. Keep the existing automation-rate metric and frequency view; this is a focused manual-effort report/sort, not a rewrite of all reports.
   - Acceptance: show manual execution count, timed/untimed counts, known total time and average over timed executions. Cost sort ranks a few long runs above many short runs where their known total is greater. A case with linked automation remains visible when it has human work. Mixed unknown durations are clearly partial and unknown is never zero. Corrections replace earlier timings once. The selected period is explicit; no monetary savings or historical automation trend is invented.

8. **Cases: show the automated tests currently covering each manual case** — S.
   - Why: a tester needs to tell whether an automated counterpart exists before repeating manual work or choosing an automation candidate.
   - Build on: `get`'s linked-auto-test list and existing Proof block. Use the inventory as the coverage signal and keep evidence status separate.
   - Acceptance: the case shows no linked automation or links to the current automated tests, with available last-result/version information. Linking a test before new evidence distinguishes "linked, no result" from "not linked"; unlinking updates coverage without erasing historical proof. A failing or old-version automated result is not described as current passing proof. No arbitrary recency threshold is required for this slice.

## Research limits and closeout

No runtime probes, browser sessions, compliance review, independent verification or production checks were performed. Behaviour statements are source findings, supported by guides, not test-run verdicts. No assurance claim is made about a particular standard or a real customer's approval procedure. The next useful validation is a representative pilot release with real requirement revisions, an artifact, mixed execution, a late correction and an auditor handoff.

The initial and final checkout revision matched, and `git status --short` was empty at both reads. This research made no commit, PR, issue, push or comment. As the read-only research sub-agent, I did not run the worktree release command, which would alter a checkout used by the parent.
