# Recommendation

Combine a shared assessment read, a report for browsing, and extended review findings for decisions. Call the field **Suggested action**, to distinguish it from the gate's verdict. Every automated test and manual case gets an assessment, including "not enough evidence". Only actionable findings need a queue answer. This follows the existing separation of records, observations and decisions, and the one-queue workflow (`docs/guide/concepts.md:9-15,39-63`). Everything below is a proposed design, not current behaviour.

Show the assessment on Tests, the case page and a paginated Reports view. QA leads use the report during suite maintenance. Test authors see it beside the test's evidence. Reviewers and outside agents can open the same assessment through CLI and MCP. Never make maintenance findings block a release. Let a person request a review that creates selected findings, rather than opening a question for every passing test. Experience First shaped that choice: protect the user's existing decision queue.

## Data and ownership

Use subjects `automated-test T-n` and `manual-case C-n@version`, with related subjects for merges and replacements. An automated test needs no linked case. Extend findings to support validated automated-test subjects and structured evidence. Current findings have neither, and `cannot-fail` means an ineffective assertion, not an invariant guard (`out/product/inventory.md`, E19 and Table 2).

An assessment carries the suggested action, plain-language reason, supporting and contrary evidence, missing evidence, exact observation window, execution and distinct-commit counts, producer/environment/job scope, timing completeness, source references, evaluator version and reproducible basis. Separate observed facts, deterministic inferences and reviewer claims. Outside agents supply source analysis and probes as attributed claims. Mainworthy calls no AI API. Show several compatible actions, such as keep the behaviour and refactor the implementation. Avoid numerical confidence without calibration.

Recommendation states are `insufficient`, `suggested`, `accepted`, `rejected`, `deferred` and `superseded`. Track implementation separately as unconfirmed or confirmed, with a repository change or accepted case proposal as evidence. Reads calculate suggestions without creating decisions. Findings snapshot the assessment used for the person's answer.

Put schemas and pure evaluation rules in `src/core`. Each domain reads its own SQL: evidence supplies executions, suite supplies cases and links, decisions supplies interpreted failures and review findings. Compose these through domain functions in `src/server/ops`, respecting the dependency map (`docs/architecture.md:54-73`). Expose the assessment through `get` for MCP and a paginated `stats` report for CLI and web, using one evaluator. All capabilities remain registered in `src/server/ops/index.ts`; the browser imports only core (`AGENTS.md`, "One registry" and "The module map"). Reports currently lack MCP exposure (`docs/guide/reports.md:19-21`).

People accept, reject with a reason, or defer until a date or named missing evidence arrives. Agents may submit findings, but destructive recommendations require a person's acceptance. Carry answers across unchanged material evidence; ordinary new passes must not reopen rejected findings. Recheck changed case versions, source revisions and replacement dependencies before execution.

Acceptance approves the plan. Removing automated code happens in its repository. Archiving a manual case uses a proposal and decision, preserving prior executions. Every change to standing uses a `Witness`. Acceptance never silently unlinks, quarantines or archives anything (`out/product/inventory.md`, "How a recommendation could fit"; `AGENTS.md`, Witness rule).

## Evidence required for each suggestion

These are evidence gates, not scores. Each suggestion must show its supporting records and its limitations.

| Action | Minimum evidence before suggesting it |
| --- | --- |
| Keep | A demonstrated relevant regression catch or failure probe, or an explicit current obligation with an accountable person's rationale. Say what it protects. A green history alone proves neither value nor worthlessness. |
| Delete | Affirmative evidence that the obligation ended, or a named retained replacement with reviewed equivalent assertions, inputs and execution conditions. Show affected requirements and unresolved guard status. Cost, zero failures and missing reports alone never qualify. For manual cases, show the version and archive effect. |
| Refactor | A specific evidenced problem and the behaviour to preserve: repeated costly executions, ambiguous manual instructions, diagnosed test defects, or a reproducible source-level issue. Same-code flips alone support "investigate instability", not a claim that the test is broken. |
| Merge | Named subjects, compared assertions or manual expected results, preserved distinct inputs, a proposed survivor, and evidence that consolidation preserves the obligations. Text similarity and co-failure nominate pairs for inspection; neither establishes equivalence. |
| Move down a layer | A named cheaper implementation and a failing probe or replay demonstrating the relevant failure there. Identify browser wiring, rendering, timing or human judgement still requiring the original layer. For manual cases, an automation link alone does not prove equivalent coverage. |
| A person must judge: invariant guard | A named consequential obligation or supplied criticality claim whose importance cannot be established from outcomes. Ask who owns it and what failure would cost. An unclassified never-failing test says "not enough evidence", not "invariant guard". A person's confirmation records the obligation and protection rationale. |

These gates deliberately require more than the candidate generators in `out/research/methods.md`, M1-M6 and M9-M11. Coverage and mutation establish overlap only within their models; similarity can hide different permissions or inputs (`out/research/literature.md`, sections 1, 2 and 8). Where required evidence is missing, return `insufficient` and name the next useful observation. Do not fabricate a verdict for every row.

Reuse gate-compatible counting, but show retry failures and quarantine separately. Missing manual durations stay unknown. Human answers, agent opinions and policy answers remain distinct (`docs/decisions/0095-reports.md:19-24`; `docs/guide/reports.md:45-50,107-117`; `out/product/inventory.md`, E8 and E22).

## Alternatives and strongest objection

A verdict column alone hides uncertainty and who acted. Queue-only delivery creates maintenance noise. Findings without a shared read force agents to reconstruct evidence. A digest can later link to changed assessments, but cannot be the decision record. A single value score rewards deletion and obscures incomparable obligations. Competitor research documents health reports and quarantine more clearly than retirement decisions; it does not establish that every missing public feature is absent (`out/research/competitors.md`, sections 3-5).

The strongest objection is that this adds lifecycle and evidence machinery before enough data exists. Start with assessment reads and human-authored findings; add deterministic suggestions only where the evidence gates pass. Redesign From First Principles shaped the shared subject and evidence model, rather than an automated-only report.

## Risks

Do not reward test counts removed or label all execution time waste. Report preserved obligations and observed outcomes after changes. Re-evaluate each removal against the retained suite so mutually dependent deletion proposals cannot remove every guard (`out/research/methods.md`, M3 and M6).

A confirmed invariant guard blocks automatic retirement and needs an explicit human rationale to supersede. Refactoring remains possible. Flaky reports have exposed real product races here (`out/history/RESULT.md`, Findings).

This repository's roughly eighteen-day CI window, missing logs, stale timing inventory and policy-assigned "needs a fix" answers cannot calibrate defect yield. The issue-discovery distribution is not test effectiveness. Treat the scorecard as review leads, not a verdict engine (`out/ci/RESULT.md`; `out/history/RESULT.md`; `AGENTS.md`, CI failure rule; `out/synth/scorecard.csv`).
