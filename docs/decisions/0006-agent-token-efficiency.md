# 0006: Agent token cost is a measured product property

- Date: 2026-10-10
- Status: requirement accepted (the owner); mechanisms proposed, to be measured
  in the phase 1 prototype and the phase 0 competitor MCP audit. Refined
  2026-10-11: mechanism 5's findings ledger becomes the ledger of all
  decisions, and review reuse is keyed by a basis that includes the relevant
  patch ([0008](0008-one-evidence-model.md)).
- Amended 2026-10-19 by decision 0118: the size of the MCP tool list is a guideline, not a gate.

The owner's position: with agents doing review and testing, a test management
system should help reduce the tokens agents spend on adversarial review and
adversarial testing, not add to them. This extends priority 2 (first-class
agent access) in the product vision.

## Terms (to be confirmed by the owner, open question 19)

- **Adversarial review:** an agent challenges test artifacts or a change. It
  looks for missing or weak expected results, ambiguous steps, uncovered
  paths, tests that cannot fail, duplicates, and whether a change is
  adequately tested.
- **Adversarial testing:** an agent tries to break the software, using the
  cases as a map, and records results and new findings with reproduction
  steps. Mainworthy does not run the software or provide the agent's browser
  or API tooling (non-goal); it supplies context and records outcomes.

## Where tokens go (hypothesis, to be measured)

With a naive tool surface, an agent spends tokens on:

1. **Reading** more than it needs: listing everything, fetching full bodies,
   long CI logs, and tool definitions loaded into every session.
2. **Re-reading** what has not changed since its last pass.
3. **Rediscovering** findings an earlier review already made and a person
   already accepted or rejected.
4. **Exploring** because it does not know where to look: which cases a change
   touches, which are risky, what is uncovered.
5. **Echoing**: write calls that return the whole object, one call per item.

## Requirement

The tokens an agent needs to finish a job through Mainworthy are measured and
budgeted like latency. A scripted reference agent with a fixed model and
tokenizer runs the agent jobs (A1 to A6 in the research plan). We count every
token of tool definitions, requests and responses, and the number of calls.
Budgets are set from a baseline: the same jobs through incumbents' MCP
servers (phase 0 audit) and through a naive "list and get everything" use of
Mainworthy's own API. A change that breaks a budget does not merge, as with
latency.

Limit of the claim: Mainworthy controls what it serves, not the agent's own
reasoning or the client's context handling. Claims are stated as "tokens
served to complete the job under the reference agent", never as total agent
cost.

## Candidate mechanisms (each a hypothesis with a way to reject it)

1. **Results shaped for models.** Counts before items, summary first, field
   selection, bounded cursors, short stable IDs, no markup, no echo of
   unchanged data. Rejected if the extra round trips cost more tokens and
   time than the smaller responses save.
2. **Do not re-read what has not changed.** Versions are immutable (principle
   1), so every read carries a version and content hash for free. Conditional
   reads answer "unchanged"; "changed since" queries per case, folder,
   project or requirement return diffs, not bodies.
3. **Impact sets instead of scans.** Given a commit, PR, changed files or a
   requirement, return the affected cases, their last results and risk
   signals (changed, failed, flaky, uncovered, long unrun), ranked, using the
   traceability links. Rejected if links are too sparse in real projects to
   beat a search; then search quality becomes the lever.
4. **The server answers what the data can show.** Requirements without
   cases, steps without expected results, cases not run in N days, stale or
   unlinked automated tests, duplicate candidates. Deterministic and
   structural, not model-generated summaries, which cost tokens and can
   mislead.
5. **Findings as data (review ledger).** Each finding is stored against the
   case version it was made on, with its state (open, accepted, rejected with
   reason). The next review sees "version 7 reviewed, 3 findings, 2
   resolved" and skips unchanged reviewed versions. Risk: a ledger anchors
   the next reviewer on the last one's view, and shared findings can make a
   second look less independent. So the ledger is optional per request: an
   agent can ask for fresh eyes and pay the full cost on purpose.
6. **Failure digests.** CI failures grouped by error signature: one
   representative excerpt, count, first-seen commit, flaky state. Full logs
   only on request, by range.
7. **Batch, idempotent writes** that return IDs and errors, not bodies.
8. **A small tool surface.** Tool definitions are loaded into the agent's
   context, so a few composable tools with short descriptions should beat
   many. The shipped skill uses progressive disclosure (short main file,
   references read on demand). The token size of the tool list and the skill
   counts in the budget. Verify how clients load MCP tool definitions when
   the MCP work starts.
9. **Visible cost.** Report tokens served per agent and per job, so a team
   can see which agent behaviours are expensive.

## Consequences

- Designed in from the start, because these are cheap in the operation layer
  and expensive to retrofit: field selection, cursors, content hashes,
  conditional reads, change feeds ("since"), impact queries and the findings
  model. The stack criteria gain an efficient change feed and indexed
  traceability links.
- Findings and review state become part of the data model (phase 2 or 3),
  with agent identity, like case versions.
- Research plan: jobs A4 to A6 and a token measure on all agent jobs; the
  competitor MCP audit records tokens, not only capability.
- Priority order is unchanged. Where token savings cost latency or
  correctness, speed and correctness win and the trade is recorded.

## Alternatives rejected

- **Leave it to the shipped skill.** A skill can teach thrift but cannot stop
  a server returning 40,000 tokens to a list call.
- **Lossy model-written summaries of cases.** They cost tokens to produce,
  go stale, and can drop the detail an adversarial reviewer needs.
- **Only a compact response format.** Helps item 1 and nothing else; most of
  the waste is in re-reading, rediscovering and exploring.
