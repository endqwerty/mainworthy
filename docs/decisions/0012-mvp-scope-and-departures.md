# 0012: What the MVP builds of the design, and where it departs

- Date: 2026-10-12
- Status: proposed (built in the MVP pull request; Daniel reviews)

`docs/product-design.md` and decision 0008 describe the product. The MVP is the thin slice "one red build, three
producers" (design section 9), built in one night on the stack of decision 0010. This record lists what the slice
contains, each place the code departs from the design and why, and what was left out. Everything left out has an
issue in the milestone `Backlog to 1.0`, and #64 lists them all on one page.

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
   the effective result per test (`run_tests`), and the same tally and verdict function read both. A test has one
   row per **lane** (the target, the job and the producer that reported it): a newer attempt in a lane replaces
   the one before it, and nothing from another lane can, so one job's pass never hides another job's failure of
   the same test, and somebody else's upload never clears a pipeline's. The same attempt reported twice keeps the
   worse outcome: only a higher attempt number or an explicit correction clears a failure. Slots follow the same
   rule, from the same function (`replacesInLane`), so a commit's gate and a slot cannot disagree about which
   result of a lane counts; they keep every cause failing in them, and are excused only when each cause is. Each cause is answered in the scope of the target it was seen
   on, so a run that counts the same commit in two repositories keeps their failures and their answers apart. A
   run planned over evidence that already fails joins the questions already asked about those failures, so an
   answer reaches it and it is never blocked by a failure nobody is asked about.
3. **A test's eligibility for a case comes from the link, not from the case body.** The design had the case
   declare `auto` in `methods`. A link exists only through a `map` decision or the test's own annotation, so
   declaring it again is a second place to maintain (principle P6). Whether a test may fill a given slot is the
   obligation's choice. A person's and an agent's eligibility are still declared on the case, and read from the
   version a slot pinned, not from the newest. The method of a result is decided per result: a pipeline's are
   `auto`; an agent's are `agent` whether it names a case or a test key, so an agent cannot count as a pipeline
   by its choice of words; a person's is `human` when it names a case and `auto` when they pass on a results file.
   **What an agent reports never moves a commit's gate.** It is recorded and shown, a failure it reports is put to
   a person as a question that holds nothing, and it counts only in a planned run that asked for agents on a case
   that admits them (decision 0009, "agent evidence in gates").
4. **Two failure answers were added, one replaced.** `inherited` (already failing on the base: the answer the
   loose preset's rule gives, which the design left unnamed) and `mistaken` (a disputed slot: the failing result
   was wrong). `mistaken` replaces the design's `resolve { trust: [...] }`; any other failure answer on a disputed
   slot also resolves it, by saying what the failure was. "Already failing on the base" reads what the base's
   own gate counts (its effective results, after attempts and corrections), never an agent's result and never
   another repository's, and it must be true of every test that fails with the cause on the commit, not only
   of those in the report that is arriving: how a pipeline splits its results over reports changes nothing.
   `mistaken` is a judgement on the results it named. They stop counting in the run and in their commit's gate;
   the same failure reported again later is a new result and is asked about again; and the decision is not
   withdrawn because the cause turns up again. Where a clause keeps a decision from the producers of the evidence, a producer is
   anyone who reported a failure with that cause in that scope, and anyone with a result in a slot that disputes
   it. That is read from the results when the answer is given, so it does not depend on how the question came
   to be asked (carried from an earlier answer, or asked again). Withdrawing an answer is held to the clause
   that answer was given under: who may, and whether a reason is owed.
5. **Drafts live in the browser.** The design autosaves into a server-side open proposal that others see as
   "draft by Dana". With one user that buys nothing; the draft is kept on the device and survives reload and
   crash (commitment L2), and a sealed proposal goes through the same path as designed. So do the notes typed
   for a run, one per slot, until the result is recorded. What the device keeps is kept per person: somebody
   else who signs in on the same browser is not shown it and cannot record it as theirs. Server-side drafts are
   deferred with presence (#35).
6. **A report is two transactions, applied in slices.** Acceptance commits first, so every reader sees the gate
   turn pending before anything is applied (commitment C5); then the batch is applied in slices of 200 results,
   and the server answers reads between slices from a second, read-only connection. Measured before this
   change: a 10,000-result report held the one thread for 0.3 to 0.65 s. Writes queue at a gate; they never
   block the thread. This is the design's horizon made real rather than a departure, but the mechanism
   (generator steps driven by one of two drivers) is new and is the part to review.
7. **A closed run refuses results.** The design re-raises the sign-off when a late upload arrives. Here the
   report is refused with a message saying how to reopen the run (withdraw the sign-off). A correction withdraws
   the result it names wherever that counted (the commit's gate, open runs, runs planned later) and stands where
   that result stood: it is never an older attempt than the one it corrects, whatever number its report carries,
   and the lane is folded again from its whole history, so if the correction decides nothing (a skip) the attempt
   before it stands again. A closed run keeps what it was closed on; reopened, it is asked about every failure
   it still shows. Deferred (#48).
8. **Holds:** `basis-changes`, `this-target`, a date, and "while a fact holds" are built. "N clean runs" and
   "until the linked defect closes" are not (#38, #32). A decision held for one target (an infrastructure failure)
   excuses the build it was given for and no other: not the next commit, and not another environment of the same
   commit. Where the question had already seen the cause in another environment of that commit, that one is asked
   about again at once, so the gate of the newest commit is never left blocked by a failure nobody is being asked
   about. (An older commit of the same change that showed the cause stays unexplained and is not asked about
   again: a newer commit has replaced it.) An answer names the evidence its author saw, and that includes the
   latest build: one prepared before a newer build failed is a conflict. So one cause can have several answers
   in force, one per environment. Each stands until it is withdrawn where it was given; a new failure is first
   checked against all of them, and only what none covers is asked about. A question
   about a failure is closed without an answer only when nothing that speaks for it still shows the failure (the
   newest commit's run, and every open planned run the question names) and something shows it gone: one of its
   tests passing on the newest commit, or a planned run that showed it and no longer does. Silence (a job that
   has not reported, a run over other cases, a pipeline's pass where the run asked for an agent) closes nothing.
   When a hold runs out by the clock, the expiry is a row in the ledger that the next answer supersedes. When an
   answer stops holding, every run that rested on it is recomputed at once and the question asked in its place
   names them, a run that has since closed included. Two rules keep this whole: there is one answer in force per
   cause and target (an answer that takes the place of another question's answer ends that one, with a row in the
   ledger); and each time a run is recomputed, every failure it shows unexplained is checked to have an open
   question, and is asked about if it has none (for an open planned run and for the newest commit of a scope).
   So no path that removes a question, an answer or a closed state can leave a live run blocked with nobody asked.
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
15. **A run with nothing proven is `pending`, not `passed`.** A report of skips only, one whose every result was
    refused, or one that holds only an agent's results leaves the gate where it was. A skip never replaces a pass
    or a failure of the same test, in a commit's gate or in a slot. The cost: a commit whose pipeline runs no test
    at all (a change to the docs only) stays `pending` until a project can say what that means (#63).
16. **A change's head only moves forward.** A report for a commit first seen before the current head (a retried
    job, a slow job of the previous push) does not move the change back. A branch reset to an older commit
    therefore keeps its newer head in the change's gate; the gate of a commit is always exact.
17. **A change belongs to one repository.** The first repository to report `pr:12` in a project has that key;
    the same number from another repository is its own change, keyed `<repository>#pr:12`. The same commit can
    exist in two repositories (a fork): each has its own gate, a change's gate is always its own repository's,
    and a commit reported for more than one repository must be named with `repo` (it is refused, never guessed).
    A line belongs to a repository too: what was decided about one repository's trunk does not cover another's.
    The "already failing on the base" hint reads only the change's own repository, and only results a gate would
    count (never an agent's).
18. **Test keys of the form `case:<n>` are reserved** for the manual test of a case. A report that uses one for an
    automated test is refused.

## What is not standing

Principle P0 says standing changes only through a decision. The code enforces it three ways: the type (a
`Witness` has a private field, so nothing else type-checks as one), the value (every standing writer reads the
decision through a check that refuses anything the mint did not make and any witness of another kind of decision;
the constructor needs a key that never leaves its module; the mint can be claimed once), and the database (every
column that cites a decision is a foreign key into the ledger). Four writes look like standing
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
