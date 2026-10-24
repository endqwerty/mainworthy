# 0007: Guiding principles, their order, and when they may bend

- Date: 2026-10-11
- Status: accepted with one amendment (the owner, 2026-10-11: "probably"; F3
  applies to 1.0, see decision 0009, answer 28)

Mainworthy needs principles that decide architecture and product questions,
with tie-breaks, so that a contributor (person or agent) who sees one file
makes the choice the whole product would make. They replace the draft
principles 1 to 7 in `docs/product-vision.md`, which they absorb, and refine
the vision's ranking (fast backend > agents > UX) as described at the end.

The owner's guidance on the day: "the record is true above speed" is right, but
speed stays a must-have priority, measured where it matters: observable,
practical speed, where the user's brain is never forced to wait for the app
before continuing. A large part of QA is getting the contents of a tester's
head into artifacts; that must get faster. A working product is not enough;
it must be a better product.

## How firm this is (added 2026-10-23, issue #905)

The owner accepted this record with "probably" (decision 0009, answer 28). The principles are an agent's synthesis of
a four-candidate design arena, not rules the owner wrote.

- **The owner's words.** The arena's brief quotes the ask: "We'll likely need to create some guiding principals help
  make decisions on architecture and the like. We'll want to be willing to adjust those principals when necessary to
  ensure the product is deliverable, but we wouldn't want to deliver a bad product", and "the repo's existing docs are
  good guidelines, but not set in stone" (`docs/design-arena/2026-10-11/brief.md`). The guidance paragraph above is
  a paraphrase of that day's thread; only "the record is true above speed" is quoted, and the exact words are not
  kept.
- **An agent's choice.** P0 to P10, their wording and order; P1's "a merged change that breaks a hot-path budget" and
  P9's "every promise is a failing test"; the bend steps with their numbers (marked "proposed limit"); the floor F1
  to F9; the rejected alternatives' framing.
- **What it means now.** Before 1.0 these are strong defaults to weigh, not fixed rules (AGENTS.md). P9 turned first
  measurements into failing tests; a budget is now a measured baseline, and only a hard limit the owner accepts fails
  (#906).

## The principles, in tie-break order

When two conflict, the lower number wins. Each names what it rules out.

**P0. The record is true.** Facts are append-only; standing (what is current,
linked, excused, quarantined, waived, signed off) changes only through a
recorded decision with its basis; nothing is rewritten, silently dropped or
unattributed.
*Rules out:* in-place edits of history, last-write-wins, hard delete, an
"admin fix" back door, an excuse or a link that appears without a decision
row, a result stamped with a version nobody established.
*Not a fact:* an author's open draft is uncommitted state, amendable by its
author until sealed; it is shown as a draft and is not part of the record.
*Tie-break:* a floor, not a rank. Never bent. It does not compete with speed:
above the floor, speed decides.

**P1. Never make the brain wait.** Speed is measured at the point of thought.
The paths where a person is producing (capturing a case, recording a result,
answering a question, searching for a case) have hard input-to-paint budgets;
writes are optimistic against durable drafts; nothing mounts, loads or asks a
question before accepting input. Capture is the first hot path, because
moving knowledge from a tester's head into an artifact is the job.
*Rules out:* a spinner on a keypress, an editor that loads before it accepts
text, a required field before typing, a modal on the common path, a
save button, fetch-everything-then-filter, "optimise later", a merged change
that breaks a hot-path budget.
*Tie-break:* beats P2 to P10. Server latency, token cost and feature breadth
all serve this; a feature that cannot meet its hot-path budget is not shipped.

**P2. One stream, one operation layer.** Manual, CI and agent output are the
same types through the same operations; UI, REST, MCP, CLI and CI ingest are
projections of one operation registry.
*Rules out:* an "automation" module, agent-only tables, a manual run type
beside an automated one, UI-only capability, a bulk or import path that skips
policy, per-surface validation.
*Tie-break:* a whole surface (for example the CLI) may be absent from a
release; a capability that exists must be reachable through the operation
layer, and so through the API and MCP. A second path is never allowed.

**P3. Evidence says what it proves.** Every result carries an explicit basis
(exact, assumed or unresolved) and a target; a review finding is never a
runtime pass; missing evidence is pending, never green; contradictory evidence
is disputed, never averaged.
*Rules out:* stamping a result with the current version and calling it exact,
a green gate because no failures were uploaded, a review that satisfies an
execution slot, a later write that hides an earlier failure.
*Tie-break:* an honest pending or disputed state beats a faster green.

**P4. Decide once, record why.** Every prompt to a person is a typed question
with its evidence and a closed set of answers; an answer carries forward to
later occurrences of the same cause until the evidence it stood on changes;
reuse (a prior answer, a reviewed basis, an unchanged claim) reduces reading
and *suggests*; whether it has authority over a gate is a policy clause.
*Rules out:* notifications with no answer, dashboards as the place work is
found, re-triage of a known failure, free-form workflow states, a detector
that excuses a failure without a decision row.
*Tie-break:* loses to P3 when unsure whether an old answer still holds (ask
again, show the old answer). Beats feature breadth.

**P5. Policy is data over one model.** A team's strictness is a table of
clauses saying who must answer which kind of question and what an open
question blocks; presets are lists; agents meet the same clauses as people.
*Rules out:* editions, modes, `if (regulated)` in code, a feature that exists
under one preset only, model fields added for one profile, an agent back
door.
*Tie-break:* a default may be loose, but the strict path must already work on
the same data.

**P6. Derive, don't maintain.** Anything computable from facts and decisions
is never a field a person or a second module writes.
*Rules out:* an "is automated" checkbox, a hand-set run status, a stored
coverage number, a flaky tag, a cache with its own writer.
*Tie-break against P1:* derive at read first; if the read misses its budget,
materialise a projection written in the same transaction by one named
projection owner (the module whose rule derives it, reading other owners'
facts), with a rebuild check. Never a cache with its own writer.

**P7. Zero configuration to first value.** One artifact, one command, one
pipeline line; drop-in inputs; every default is a policy clause you can read
and change later.
*Rules out:* setup wizards, a required field schema, a plugin per CI vendor,
required case-ID annotations in test code, an account before the first case.

**P8. Free to read, accountable to write, portable by construction.** No seat
concept; every write names an actor (an agent names the person it acts for)
and a base; the export is the complete log plus canonical text documents;
nothing is gated by plan, layer or count.
*Rules out:* seat metering, anonymous writes, retention windows, rate tiers,
cloud-only features, an import that drops history.

**P9. Every promise is a failing test.** Latency, tokens served, keystrokes
per job, ingest, the five-minute start, rebuildability and lossless export
are checks that fail the build.
*Rules out:* "feels fast"; budgets in docs only.
*Meta-rule:* a principle with no check is not yet a principle.

**P10. One place to declare a thing.** Operations, question kinds, policy
predicates and parsers are each declared once in one registry; everything
else is generated or exhaustively checked from it, so a change that looks
right from one file is right for the whole product.
*Rules out:* hand-synced lists, importable internals, a second place to add a
tool or a kind.
*Tie-break:* lowest rank, but it keeps the others true once agents write
most of the code.

## How this refines the product vision's ranking

The vision ranks fast backend > agent access > UI/UX. Kept as the order of
engineering constraints, with three changes:

1. **A floor above speed (P0).** A fast tool with an untrustworthy record has
   no value to any profile.
2. **Speed is defined by what it is for (P1).** "Fast backend" said where to
   build speed, not where it matters. The budget is now at the point of
   thought, and includes keystrokes and tokens, not only server
   milliseconds. The backend budgets in the vision stay as the means.
3. **Agent access and UX stop being ranks.** Agents are a consequence of P2
   (one stream, one layer); UX is what P1 is measured in.

Cost: three kinds of budget to maintain instead of one.

## Bending a principle for deliverability

The owner's rule: be willing to adjust the principles to ship, but never ship a
bad product. So:

1. **Cut before you corrode.** First ship less: fewer question kinds,
   formats, presets, screens. A missing thing is honest; the same thing done
   worse is not.
2. **Then relax a number.** A non-hot-path budget may be relaxed by at most 2x
   (proposed limit) with the new number written down. Hot paths are never relaxed: capture,
   record a result, decide, open a case, search, read a gate, accept an
   ingest.
3. **Then defer a principle from P4 to P10**, by a decision record that names
   the principle, what ships instead, who is hurt, the check that now fails
   (kept in the check command as an expected failure so the bend stays
   visible in every run), and the condition that ends it.
4. **Never:** bend P0, P1 on a hot path, or P3; create a second path (P2);
   let a bend outlive its condition.
5. **At most three bends open at once** (proposed limit). A fourth needs one
   closed first.

### The floor: what "a bad product" means

If shipping would make any of these true, cut scope until none is; if no cut
works, do not ship.

- F1. It loses or rewrites a recorded fact or decision, or shows a pass for
  something not proven on that basis.
- F2. A hot path makes the user wait after a keypress (capture, record,
  decide, open, search).
- F3. It is not measurably better than the incumbents on the capture,
  execution and triage jobs of the phase 0 friction audit. Working is not
  enough. *Amended 2026-10-11 (decision 0009, answer 28): F3 gates 1.0. A
  preview may fall short of it when an issue records the gap and the plan.*
- F4. It asks a person a question it already holds a valid answer to.
- F5. A capability exists in the UI only, outside the operation layer, so it
  is not reachable by the API or an agent.
- F6. First value needs an account, a configuration step or more than five
  minutes (the vision's J15 budget; draft until measured).
- F7. A team cannot leave with all of its data and history.
- F8. A strict team needs a different build, edition or data model than a
  loose one.
- F9. Answering "is this change tested?" requires looking in more than one
  place.

## Consequences

- `docs/product-vision.md` principles 1 to 7 are superseded; the vision keeps
  the backend, agent and UI sections as the means and points here for the
  order.
- The check command, once a stack exists, carries one test per commitment in
  `docs/product-design.md` section 4 (P9).
- Every later decision record cites the principle it serves or bends.

## Alternatives rejected

- **Keep the vision's ranking as is.** "Fast backend first" permitted trading
  the record for milliseconds and did not say where speed matters.
- **Put speed first, integrity second.** The owner rejected it: the record is
  true above speed. But they also rejected integrity-only: speed stays a
  must-have. The floor-plus-rank shape expresses both.
- **No bend rule.** Principles without a release valve get broken silently;
  a rule with an expiry and a visible failing check keeps bends honest.
