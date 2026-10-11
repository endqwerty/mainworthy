# Open questions

Answer in this file (or tell the agent); the next agent records the decision
in `docs/decisions/`.

1. Who uses it: you alone (personal tool), a small team, or a product others can adopt? Partly answered 2026-10-10: software QA teams across the process spectrum, loose to regulated (`decisions/0003-scope-software-qa-and-process-spectrum.md`). Answered 2026-10-10: teams in general, not any one team; Daniel's experience across enterprise, large, small and startup teams is practitioner evidence (`decisions/0005-generic-audience-and-practitioner-evidence.md`).
2. Hosting: ~~self-hosted on the home server or hosted publicly?~~ Answered 2026-10-10: self-hostable in layers, local machine through cloud (`decisions/0002-layered-self-hosting.md`). Still open: is a hosted instance run by Daniel for others ever in scope?
3. Biggest pain points in TestRail/Qase/Jira/ADO (fill `docs/competitors.md`, "Daniel's notes").
4. Must it integrate with Jira or ADO on day one (linking requirements and defects), or is standalone fine at first?
5. Is importing from an existing TestRail/Qase/ADO instance a launch requirement?
6. Any language, framework or database preference or dislike? (Stack is intentionally undecided.)
7. Product name: `Casebook` is a placeholder.
8. ~~Real-time collaboration or last-save-wins?~~ Answered 2026-10-10: multi-user baseline, no live co-editing of text by default, conflicts detected by base version and resolved side by side, live updates only where they help a measured task (`decisions/0004-multi-user-and-offline-stance.md`). Still open: which live-awareness candidates survive the mock.
9. ~~Offline or online-only?~~ Answered 2026-10-10: online-first, with a small allowance (readable recent data, queued edits during a short drop, surviving drafts) only where it costs the user nothing; no git-style sync commitment (`decisions/0004-multi-user-and-offline-stance.md`). Still open: whether queued edits are built in phase 2.
10. Review of changes: ~~immediate or proposed first?~~ Direction 2026-10-10: a per-project policy switch with presets (`decisions/0003-scope-software-qa-and-process-spectrum.md`). Still open: the default for a new project.
11. Which CI systems and test frameworks do you use or need first (GitHub Actions? Playwright, pytest, Jest, JUnit)? This sets the order of ingest formats.
12. Flaky policy defaults: is a quarantined test allowed to fail the build, or never? How long clean before auto-release from quarantine?
13. Competitor trial accounts: which can be opened for the hands-on audit (Qase, Testiny, Testmo, TestRail trial; a Jira with Xray or an Azure DevOps org)? No interviews are planned (`docs/ux-research-plan.md`).
14. Local layer footprint: is a native single binary required, or is a container acceptable for the Local layer too?
15. Regulated profile depth: do we need electronic signatures with legal weight, retention rules or an audit export format in the first usable version, or is identity-and-time sign-off enough until a real regulated team asks?
16. Requirements source: are requirements linked from an external tracker only (Jira, ADO, GitHub issues), or can a project hold its own lightweight requirement list for the traceability views?
17. Deployment events: how does Casebook learn that a build was deployed (CI step, webhook, or manual) so traceability reaches deployments?
18. Compare the kinds of team you have worked in (enterprise, large, small, startup) as evidence for `docs/ux/flows.md`. For each: where cases lived, who wrote and ran them, what ran in CI, who decided go or no-go, what broke at that size, and what annoyed you most. Where did the flows differ most between them, and is organisation scale (many teams sharing standards) a different axis from process strictness? A few messy paragraphs per kind of team is enough; this is the only first-hand data we have.
19. Adversarial review and testing (decision 0006): is the reading right (agents challenging cases and changes; agents trying to break the software using the cases as a map)? Which agent clients should the token measurements use first (Claude Code, Codex, Cursor, others), and do you already know where agents waste the most tokens today?
