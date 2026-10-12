# 0012: What the MVP builds of the design, and where it departs

- Date: 2026-10-12
- Status: proposed (built in the MVP pull request; Daniel reviews)

`docs/product-design.md` and decision 0008 describe the product. The MVP is the thin slice "one red build, three
producers" (design section 9), built in one night on the stack of decision 0010. This record lists what the slice
contains, each place the code departs from the design and why, and what was left out. Everything left out has an
issue in the milestone `Backlog to 1.0`.

Bend rule check (decision 0007): nothing here bends P0, P1 on a hot path, P2 or P3. The cuts are missing things,
not the same things done worse.

## Built

| Area | What works | Proof |
| --- | --- | --- |
| Kernel | One SQLite file. Every write is one command: one transaction, one sequence number, idempotent on a client command id, attributed to an actor. | `test/suite.test.ts`, `test/http.test.ts` |
| Suite | `propose` creates, edits, moves, retags, archives, restores, links requirements and changes the policy. An edit names its base; different fields merge, the same field is a conflict that keeps both sides. Versions are immutable; a move is history, not a version. Search, canonical Markdown. | `test/suite.test.ts` |
| Evidence | `report` takes a parsed JUnit file, one manual result or an agent's batch in one shape. Explicit basis on every result. One signature per cause. Same-code flips recorded. | `test/evidence.test.ts` |
| Decisions | Kinds `adopt`, `map`, `failure`, `finding`, `signoff`. One question per cause; an answer carries forward under a hold and is asked again, with the old answer linked, when the hold ends. A rule's answer is a recorded decision. Undo supersedes. | `test/evidence.test.ts`, `test/policy.test.ts` |
| Policy | Presets `loose`, `standard` and the fixture `strict`, switched on live data. | `test/policy.test.ts` |
| Runs | A change run per commit with the four-verdict gate. Planned runs with pinned slots that a person, a pipeline or (when asked) an agent fills. Disputes. Sign-off by rule. | `test/runs.test.ts` |
| Surfaces | One registry behind HTTP and OpenAPI, the CLI, MCP (stdio and HTTP) and the web UI. | `test/http.test.ts`, `test/architecture.test.ts` |
| Operate | One container, one volume. Lossless export and import. Start-up recovery of interrupted reports. | the transfer and CLI tests |

## Departures from the design, and why

1. **Ids are integers; the public id is the ref.** The design sketched client-generated ids. Refs (`C-311`) are
   what every surface speaks: short for people, few tokens for agents. Cost: merging two instances needs an id
   map; import into an empty instance keeps ids as they are.
2. **A change run counts tests; a planned run counts slots.** The design gave every run slots. A commit's gate
   must include tests that have no case (decision 0008, item 10), and a slot needs a case. So a change run keeps
   the effective result per test (`run_tests`), and the same tally and verdict function read both.
3. **A test's eligibility for a case comes from the link, not from the case body.** The design had the case
   declare `auto` in `methods`. A link exists only through a `map` decision or the test's own annotation, so
   declaring it again is a second place to maintain (principle P6). Whether a test may fill a given slot is the
   obligation's choice. A person's and an agent's eligibility are still declared on the case, and read from the
   version a slot pinned, not from the newest. The method of a result is decided per result: a pipeline's are
   `auto`; an agent's are `agent` whether it names a case or a test key, so an agent cannot count as a pipeline
   by its choice of words; a person's is `human` when it names a case and `auto` when they pass on a results file.
4. **Two failure answers were added, one replaced.** `inherited` (already failing on the base: the answer the
   loose preset's rule gives, which the design left unnamed) and `mistaken` (a disputed slot: the failing result
   was wrong). `mistaken` replaces the design's `resolve { trust: [...] }`; any other failure answer on a disputed
   slot also resolves it, by saying what the failure was.
5. **Drafts live in the browser.** The design autosaves into a server-side open proposal that others see as
   "draft by Dana". With one user that buys nothing; the draft is kept on the device and survives reload and
   crash (commitment L2), and a sealed proposal goes through the same path as designed. Server-side drafts are
   deferred with presence (#35).
6. **A report is two transactions, applied in slices.** Acceptance commits first, so every reader sees the gate
   turn pending before anything is applied (commitment C5); then the batch is applied in slices of 500 results,
   and the server answers reads between slices from a second, read-only connection. Measured before this
   change: a 10,000-result report held the one thread for 0.3 to 0.65 s. Writes queue at a gate; they never
   block the thread. This is the design's horizon made real rather than a departure, but the mechanism
   (generator steps driven by one of two drivers) is new and is the part to review.
7. **A closed run refuses results.** The design re-raises the sign-off when a late upload arrives. Here the
   report is refused with a message saying how to reopen the run (withdraw the sign-off). A correction reaches
   only open runs; a closed run keeps what it was closed on. Deferred (#48).
8. **Holds:** `basis-changes`, `this-target`, a date, and "while a fact holds" are built. "N clean runs" and
   "until the linked defect closes" are not (#38, #32). A decision held for one target excuses that target only;
   the same cause on another commit of the pull request stays unexplained. When a hold runs out by the clock, the
   expiry is a row in the ledger that the next answer supersedes.
9. **The review basis is the case version plus the change key,** not the patch tree hash. A changed patch under
   the same pull request does not yet invalidate a review. Deferred (#49).
10. **The export is the whole instance,** as newline-delimited JSON, imported into an empty instance. Per-project
    export and merge are deferred (#50). Tokens are not exported.
11. **Operations:** fifteen, not eighteen. `announce`, `attach` and `trace` are deferred (#42, #51, #41).
    `timeline` was added so the case page's one timeline is reachable from every surface. `transfer` is two
    streaming HTTP routes and two CLI commands instead of an operation, because an archive does not fit in a
    JSON reply.
12. **The API description covers inputs only.** Replies are typed in TypeScript (`src/core/api.ts`) but not yet
    as schemas in the OpenAPI document (#52).
13. **Resolving a conflict adopts nothing.** The design let a conflict's author resolve it and the resolution
    land. Here the resolved body becomes a new proposal by that author, made on the version the conflict was
    shown against, and it meets the adopt policy like any other edit. So a conflict is never a way around a
    review, and work that landed while the author was resolving is merged in or shown as a new conflict. Only a
    proposal that is one edit of one case can be resolved this way; anything larger is rejected and proposed again.
14. **An automated result is never dropped.** The design says a result whose claims disagree is rejected. For a
    result recorded against a case that is what happens. For an automated test the outcome is still a fact about
    the commit, and dropping it could hide a failure from the gate, so it is kept with no case and the reason is
    returned (`declined` in the reply).
15. **A run with nothing proven is `pending`, not `passed`.** A report of skips only, or one whose every result
    was refused, leaves the gate where it was. A skip never replaces a pass or a failure of the same test.
16. **A change's head only moves forward.** A report for a commit first seen before the current head (a retried
    job, a slow job of the previous push) does not move the change back. A branch reset to an older commit
    therefore keeps its newer head in the change's gate; the gate of a commit is always exact.
17. **A change belongs to one repository.** The first repository to report `pr:12` in a project has that key;
    the same number from another repository is its own change, keyed `<repository>#pr:12`.

## What is not standing

Principle P0 says standing changes only through a decision. The code enforces it three ways: the type (a
`Witness` has a private field, so nothing else type-checks as one), the value (every standing writer reads the
decision through a check that refuses anything the mint did not make, and the mint can be claimed once), and the
database (every column that cites a decision is a foreign key into the ledger). Four writes look like standing
and are not, and take no witness:

- **The first policy of a new project.** There is no earlier policy under which to decide it. A second seed is
  refused by the database.
- **The manual test of a case.** It is that case by definition (`case:<id>`), so its link is identity, not a
  judgement; a `map` decision cannot move it.
- **A producer correcting its own result.** A correction is evidence about evidence: the same producer, the same
  test, the same target and run. It changes which of that producer's results counts in open runs, never whether
  a failure is excused.
- **Opening a run.** A run is a request for evidence; only closing it is a decision.

Withdrawing a decision undoes only what that decision made: a link, an excuse or a sign-off that a newer
decision has since made stays.

## Left out, on purpose

Flaky detector and quarantine (#38). Requirements coverage, the matrix, the gap list and the `gap` kind (#41).
Role sign-off, quorum of two, freeze, the regulated preset (#53). Fragments and custom fields (types reserved,
no UI) (#54). Attachments (#51). Posting the gate to the code host as a check (#55). Importers (#33). Accounts
and SSO (#30). Reports and dashboards (#56). PostgreSQL (#57, see decision 0010). Over-merge guard for one
signature across many files (#58).

## What would end each departure

Each issue states its own condition. The two that should come first once a second person uses an instance:
server-side drafts with presence (#35) and accounts (#30), because everything multi-user rests on them.
