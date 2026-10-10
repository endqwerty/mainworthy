# Open questions

Answer in this file (or tell the agent); the next agent records the decision
in `docs/decisions/`.

1. Who uses it: you alone (personal tool), a small team, or a product others can adopt?
2. Hosting: ~~self-hosted on the home server or hosted publicly?~~ Answered 2026-10-10: self-hostable in layers, local machine through cloud (`decisions/0002-layered-self-hosting.md`). Still open: is a hosted instance run by Daniel for others ever in scope?
3. Biggest pain points in TestRail/Qase/Jira/ADO (fill `docs/competitors.md`, "Daniel's notes").
4. Must it integrate with Jira or ADO on day one (linking requirements and defects), or is standalone fine at first?
5. Is importing from an existing TestRail/Qase/ADO instance a launch requirement?
6. Any language, framework or database preference or dislike? (Stack is intentionally undecided.)
7. Product name: `Casebook` is a placeholder.
8. Real-time collaboration (two people editing a case at once) or last-save-wins with conflict warnings? It shapes the data layer and the UI cache.
9. Should the UI work offline or on a bad connection (local-first), or is online-only fine?
10. Review of changes: should edits (especially from agents) go live immediately with a revert option, or be proposed and approved first? Per project, or global?
11. Which CI systems and test frameworks do you use or need first (GitHub Actions? Playwright, pytest, Jest, JUnit)? This sets the order of ingest formats.
12. Flaky policy defaults: is a quarantined test allowed to fail the build, or never? How long clean before auto-release from quarantine?
13. UX research participants: who can take part in interviews and usability sessions (colleagues, friends in QA, online recruiting)? Which competitor trial accounts can be opened? (Needed for `docs/ux-research-plan.md`.)
14. Local layer footprint: is a native single binary required, or is a container acceptable for the Local layer too?
