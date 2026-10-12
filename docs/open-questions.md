# Open questions

**All 28 were answered by Daniel on 2026-10-11.** The answers, what each one
changes and the issue that tracks each deferral are in
[decisions/0009-open-question-answers.md](decisions/0009-open-question-answers.md).
Only question 3 (his pain points with the incumbents) is still to be written
(issue #46). The questions are kept below as they were asked.

New questions go at the end; answer in this file or tell the agent, and the
next agent records the decision in `docs/decisions/`.

1. Who uses it: you alone (personal tool), a small team, or a product others can adopt? Partly answered 2026-10-10: software QA teams across the process spectrum, loose to regulated (`decisions/0003-scope-software-qa-and-process-spectrum.md`). Answered 2026-10-10: teams in general, not any one team; Daniel's experience across enterprise, large, small and startup teams is practitioner evidence (`decisions/0005-generic-audience-and-practitioner-evidence.md`).
2. Hosting: ~~self-hosted on the home server or hosted publicly?~~ Answered 2026-10-10: self-hostable in layers, local machine through cloud (`decisions/0002-layered-self-hosting.md`). Still open: is a hosted instance run by Daniel for others ever in scope?
3. Biggest pain points in TestRail/Qase/Jira/ADO (fill `docs/competitors.md`, "Daniel's notes").
4. Must it integrate with Jira or ADO on day one (linking requirements and defects), or is standalone fine at first? Proposed 2026-10-11 (`docs/product-design.md` section 9): Preview 1 stores pasted references only; tracker ports come later.
5. Is importing from an existing TestRail/Qase/ADO instance a launch requirement?
6. Any language, framework or database preference or dislike? (Stack is intentionally undecided.)
7. Product name: `Casebook` is a placeholder.
8. ~~Real-time collaboration or last-save-wins?~~ Answered 2026-10-10: multi-user baseline, no live co-editing of text by default, conflicts detected by base version and resolved side by side, live updates only where they help a measured task (`decisions/0004-multi-user-and-offline-stance.md`). Still open: which live-awareness candidates survive the mock.
9. ~~Offline or online-only?~~ Answered 2026-10-10: online-first, with a small allowance (readable recent data, queued edits during a short drop, surviving drafts) only where it costs the user nothing; no git-style sync commitment (`decisions/0004-multi-user-and-offline-stance.md`). Still open: whether queued edits are built in phase 2.
10. Review of changes: ~~immediate or proposed first?~~ Direction 2026-10-10: a per-project policy switch with presets (`decisions/0003-scope-software-qa-and-process-spectrum.md`). Proposed default 2026-10-11 (preset table, `docs/product-design.md` 6.5): a new project is `loose`: human edits adopt by rule, agent edits adopt by rule too; `standard` makes agent edits a question for a member. Confirm.
11. Which CI systems and test frameworks do you use or need first (GitHub Actions? Playwright, pytest, Jest, JUnit)? This sets the order of ingest formats.
12. Flaky policy defaults: is a quarantined test allowed to fail the build, or never? How long clean before auto-release from quarantine? Proposed 2026-10-11: a quarantined test's failure is excused (never fails the build) while the quarantine holds; the loose and standard presets release after 20 clean trunk runs by rule, regulated by a lead (the preset table in `docs/product-design.md` 6.5); see questions 24 and 25.
13. Competitor trial accounts: which can be opened for the hands-on audit (Qase, Testiny, Testmo, TestRail trial; a Jira with Xray or an Azure DevOps org)? No interviews are planned (`docs/ux-research-plan.md`).
14. Local layer footprint: is a native single binary required, or is a container acceptable for the Local layer too?
15. Regulated profile depth: do we need electronic signatures with legal weight, retention rules or an audit export format in the first usable version, or is identity-and-time sign-off enough until a real regulated team asks?
16. Requirements source: are requirements linked from an external tracker only (Jira, ADO, GitHub issues), or can a project hold its own lightweight requirement list for the traceability views? Proposed answer 2026-10-11 (decision 0008): a local requirement row that may mirror a tracker item one way; confirm.
17. Deployment events: how does Casebook learn that a build was deployed (CI step, webhook, or manual) so traceability reaches deployments? Proposed 2026-10-11: `casebook announce --deploy <build> --env <env>` from the deploy step (the `announce` operation), which also binds a build label to its artifact digest; webhooks later through a port.
18. Compare the kinds of team you have worked in (enterprise, large, small, startup) as evidence for `docs/ux/flows.md`. For each: where cases lived, who wrote and ran them, what ran in CI, who decided go or no-go, what broke at that size, and what annoyed you most. Where did the flows differ most between them, and is organisation scale (many teams sharing standards) a different axis from process strictness? A few messy paragraphs per kind of team is enough; this is the only first-hand data we have.
19. Adversarial review and testing (decision 0006): is the reading right (agents challenging cases and changes; agents trying to break the software using the cases as a map)? Which agent clients should the token measurements use first (Claude Code, Codex, Cursor, others), and do you already know where agents waste the most tokens today?

From the product design synthesis (2026-10-11, `docs/product-design.md`,
decisions 0007 and 0008):

20. Home screen: the design makes Suite (capture) the default home with the queue count in the header, and lets a user whose day is triage set Queue as home. From your experience across team sizes, who opens the tool daily, and is that right?
21. Assumed basis: a drop-in CI report stamps results with the case's current version as a recorded assumption, and a loose project's gates accept it. Is that the right default for a new project, with `exact` required under the standard or only the regulated preset?
22. Agent evidence in gates: may an agent's result fill a run slot by default (loose), or only when a run or a gate opts in? May an agent's answer settle any question kind in the loose preset (the draft lets a rule settle most things and agents answer only `map` and `duplicate`)?
23. Sealed proposals: autosave goes to a private draft and becomes a version on leaving the case, an explicit key or 30 s idle, so colleagues see an edit seconds later. Acceptable in a loose team? Should opening the case by someone else force a seal?
24. Who may excuse a failure on their own PR? The standard preset draft lets the change author answer `defect`, `test` and `expected` but not `flaky` or `infra`. Too strict, too loose, or right? (Extends question 12.)
25. Hold windows: `flaky` holds 14 days or until 20 clean trunk runs; `infra` holds for one target only; `defect` holds until 5 clean runs or the tracker item closes. What would you have wanted in the teams you worked in?
26. Will manual testers name the build? Results filling a release run depends on manual results carrying a target. Do testers know which build is on the environment, or must Casebook learn it from a deploy announcement and offer it?
27. Slice order: the design trades the roadmap's authoring-first phase 2 for a thin slice across all three producers and the queue, with fragments and custom fields moving later. Agreed?
28. The principle order and the floor in decision 0007, in particular F3 ("not measurably better than the incumbents on the audit jobs" is a reason not to ship): confirm or adjust.
