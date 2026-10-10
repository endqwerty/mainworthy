# Open questions

Answer in this file (or tell the agent); the next agent records the decision
in `docs/decisions/`.

1. Who uses it: you alone (personal tool), a small team, or a product others can adopt?
2. Hosting: self-hosted on the home server (tailnet only, like codex-reset-watch), or hosted publicly?
3. Biggest pain points in TestRail/Qase/Jira/ADO (fill `docs/competitors.md`, "Daniel's notes").
4. Must it integrate with Jira or ADO on day one (linking requirements and defects), or is standalone fine at first?
5. Is importing from an existing TestRail/Qase/ADO instance a launch requirement?
6. Any language, framework or database preference or dislike? (Stack is intentionally undecided.)
7. Product name: `Casebook` is a placeholder.
8. Real-time collaboration (two people editing a case at once) or last-save-wins with conflict warnings? It shapes the data layer and the UI cache.
9. Should the UI work offline or on a bad connection (local-first), or is online-only fine?
