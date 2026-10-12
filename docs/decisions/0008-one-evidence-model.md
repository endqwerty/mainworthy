# 0008: One evidence model: explicit basis, runs as requests, decisions as the only writer of standing

- Date: 2026-10-11
- Status: proposed (synthesised from the design arena; mechanisms to be
  proven in the phase 1 prototype)

Full sketch: `docs/product-design.md` sections 6 and 7. This record states
the decisions that the sketch depends on.

## Decision

1. **Three kinds of write, three kinds of writer.** Producers (a person, a
   pipeline, an agent, under their own identity) append **evidence**:
   proposals, results, findings. Detectors derive **questions** from evidence,
   one per cause, by fingerprint; nobody writes a question. **Decisions**
   answer questions and are the only thing whose effect changes standing:
   the current version of a case, a test-to-case link, an excuse, a
   quarantine, a waiver, a sign-off, the policy. Standing writers take a
   witness that only the decision machinery can mint.

2. **Every result carries an explicit basis.** `exact` (a pinned run slot, a
   version manifest written before the tests ran, or a `@C-311@v7`
   annotation), `assumed` (the case's current version at ingest, recorded as
   an assumption), or `unresolved` (a test with no case; history only). No
   path stamps a version silently. A project policy says which bases qualify
   for its gates: loose accepts `exact-or-assumed`; regulated requires
   `exact`. This is the resolution between "prepare before every CI run" and
   "stamp the current head": both are allowed, both are honest, policy
   chooses.

3. **A run is a request for evidence, not an owner of results.** Results
   belong to a target (code, artifact, or a named session with no build
   identity). A run is a predicate over targets plus slots pinned to case
   versions, each slot serving one explicit obligation: exercise (which
   methods, which linked tests, which agent charters, how many independent
   actors, which basis, exact target or attested code-in-artifact), review
   (which lens, independent or not), required CI jobs, or sign-off. A result
   from any producer fills a slot only when the obligation admits its
   method, binding or charter, basis and target, and the case's declared
   methods include that kind; a review fills only a review obligation. A
   slot's state folds its complete effective result set, never a bounded
   sample. A PR check, a regression
   pass and a release are one object. A session target never satisfies a
   change run.

4. **The gate has four verdicts** and reading it computes nothing beyond two
   comparisons: `passed`, `failed` (needs a fix), `blocked` (needs a
   decision: an open or disputed question), `pending` (needs evidence:
   unfilled slots, missing required jobs, accepted but unapplied uploads, or
   an expired hold). A run carries a horizon (`accepted`, a contiguous
   `applied` watermark and an `outstanding` count): durable acceptance of an
   upload (staging its normalised results under the batch key, before any
   processing) counts it outstanding on every matching run, open or closed;
   processing, in any order, applies it and advances the watermark only past
   batches that are all applied. A frozen run never changes. The gate is
   `pending` while anything is outstanding, so a stale green is never
   served. A late upload never rewrites a closed run's standing: the closing
   sign-off decision holds until its basis changes, so the late batch
   re-raises the sign-off question and the new decision supersedes the old.

5. **A review is never a runtime pass.** Findings and reviewed-basis rows
   are evidence of review; only a run requirement of kind review accepts
   them, and policy may require an independent human. A review with zero
   findings is still recorded.

6. **Detectors suggest; decisions excuse.** A failure already failing on the
   base of a change, a quarantined test, a signature seen before: these are
   hints in the question's evidence digest. The excuse is a decision, which a
   rule clause may make instantly under a loose preset, and which is in the
   ledger with its clause either way.

7. **Answers are basis-checked and holds expire visibly.** An answer names
   the evidence hash it was given on; every form of `decide` carries it (the
   form that opens a new question supplies the evidence itself and is
   refused if the question already exists); the answer history is
   append-only; a quorum counts only answers on the current
   evidence. A decision carries forward under a hold (terms: until the basis
   changes, this target only, a date, N clean runs of a test, or a linked
   defect closes; the hold ends when any term ends and each term stores what
   it needs). Each run records the decisions it depends on and its earliest
   expiry; the gate read returns `pending` once that passes, and a persisted
   sweep or the next event re-raises the question and re-folds the run.
   Every run closes by a `signoff` decision, which a rule may make.

8. **Two hashes per case version, and fragments are pinned.** A step that
   uses a shared fragment names the fragment's version, so a case version's
   expansion never changes; adopting a new fragment version publishes new
   versions for its users as one attributable batch through the same adopt
   path (J12). The version hash identifies the document (history, diff,
   restore). The claim hash covers the claim class only (preconditions,
   steps, expected results, the pinned fragments' content) and is stable
   under retitling, retagging, moving and linking. It is a reuse signal for
   people and agents ("proven on this claim", "reviewed at this basis") and
   an explicit requirement option (`basis: 'same-claim'`) a project may
   choose for its gates; it never transfers proof by itself.

9. **Autosave into a private open proposal; a version exists when a sealed
   proposal is adopted.** Others see the draft as a draft. Sealing happens on
   leaving the case, an explicit key, or idle. A bulk edit is one proposal,
   one question, one decision, with a computable inverse.

10. **Tests exist without cases.** A `Test` is a first-class evidence subject
    with history, flakiness and a place in the gate whether or not it is ever
    mapped to a case; mapping is a `map` question raised when policy asks.

11. **One operation registry, eighteen operations, ten agent tools.** Wire
    formats (test reports, vendor exports, CSV) are parsed in adapters before
    an operation is invoked; `report` takes normalised results and
    `transfer.import` takes the canonical archive. REST,
    MCP, CLI, OpenAPI, the palette, the skill's reference pages and the
    budget tests are generated from the registry.

## Stack criteria added (for decision 0001)

- A per-project sequence assigned in commit order, so changed-since, export
  and audit are one ordered range read.
- Batched point reads and writes of 10,000 keys inside one transaction.
- An index-only count on the open-queue key.
- Full-text document replacement inside the writing transaction.
- A canonical text round trip (`print ∘ parse = id`) as a check.

## Consequences

- Decision 0003's five switches become rows of the clause table; the record
  stands, its mechanism is generalised.
- Decision 0006's findings ledger becomes the ledger of all decisions; review
  reuse is keyed by a basis that includes the relevant patch.
- The roadmap's phase 2 becomes the thin cross-producer slice in
  `docs/product-design.md` section 9.
- Open question 16 gets a proposed answer: a local requirement row that may
  mirror a tracker item one way.

## Alternatives rejected

- **Exact-or-unresolved only** (candidates A and B): honest, but makes a
  drop-in `casebook report` useless for gates until a team adds a manifest
  step. The assumed basis keeps drop-in useful and visible.
- **Stamp the current head and call it the version** (candidates C and D as
  written): guesses silently. Rejected by the judge and here.
- **Claim hash as automatic proof transfer** (candidate C): a hash proves the
  text is the same, not that a runner executed it. Kept as a signal and a
  policy option.
- **Results as decisions** (the extreme of candidate D's lens): a 10M-row
  union of two shapes with an authority check on every machine result.
- **Separate manual, automation and agent modules with a reporting layer**:
  the incumbents' shape; three shapes to reconcile.
