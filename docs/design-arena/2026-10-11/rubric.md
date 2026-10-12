# Rubric (judge only; candidates do not see this)

Score each criterion 1-5 with one sentence of evidence per candidate.

1. **One product, not three features.** Does one model genuinely carry manual, automated and agentic testing? Trace J5 (manual run), F5 (CI ingest + triage) and F13 (agent adversarial review) through the candidate's types and operations. Penalise any second path.
2. **Money argument is structural.** Are the reasons incumbents are a poor buy concrete and evidenced (verified vs hypothesis), and does the design answer each structurally rather than with a feature list?
3. **Principles that decide.** Do the principles actually resolve conflicts (tie-breaks), name what they rule out, and give a bounded rule for bending them for deliverability with a floor for "bad product"?
4. **Interface depth and ownership.** Small operation surface, deep behind it; one owner per state; no red flags (shallow modules, split ownership, two ways, hand-synced lists, wire types in the public API).
5. **DX/UX moves are commitments.** The Linear / CircleCI / bun moves are stated as checkable design commitments, consistent with the instant-UX, zero-config and agent-first requirements.
6. **Deliverable and honest.** The first slice is small, not a bad product, and consistent with (or explicitly, justifiably, challenging) decisions 0002-0006; access patterns are traced through the data structures without "index later".
