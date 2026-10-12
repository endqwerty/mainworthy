# Docs against code, round 1

Commit reviewed: `a51da9f9853f4a2754fc8363fb08aeddcdf21049` (branch `t3/mvp-product-delivery`), from a clean
`git archive` export. Read-only review; nothing in the repository was changed.

Counts: **9 wrong**, **12 out of date**, **11 unclear**. Each group is sorted by how badly it would mislead.
Paths are relative to the repository; line numbers are those of the commit.

The five that matter most:

1. W1: the policy's `blocks` value decides no gate, though the architecture doc says it is "what an open question holds back".
2. O1: the three diagram pages `docs/architecture.md` links to are older than their sources and still describe the removed `inherited` rule, the `fact-gone` hold and a slice of 500.
3. W2: `docs/deploy.md` restore steps leave a server-mode instance that refuses its only token until it is restarted with `CASEBOOK_OWNER_TOKEN`.
4. W3: README says an answer applies to later occurrences of the cause; `i` excuses one build only (checked on a live instance) and `f` ends after 14 days.
5. W5: decision 0012 says a failure question is closed without an answer "only when" it stopped failing; there is a second path.

## Wrong

### W1. The policy's `blocks` value does not decide what a question holds back

- `docs/architecture.md:127-129`: "A project's strictness is a table of clauses: for a kind of question under some
  conditions, who must answer [...], what an agent's answer is worth [...], and what an open question holds back."
- Same claim in `src/core/kinds.ts:241` ("What an open question holds back: nothing, the gate of its change, a
  release (planned run), or both") and in the `blocks` column of `casebook policy show`.
- What the code does: a failure question blocks a run exactly when the run shows its cause unexplained,
  "whatever the policy says a question may hold" (`src/server/runs/runs.ts:1051-1060`), and an unexplained failure
  makes the verdict `blocked` by the tally alone (`src/core/runs.ts:78`). Every other kind of question is raised with
  `runs: []` (`src/server/decisions/kinds.ts:129`, `src/server/ops/writes.ts:233` and `:317`,
  `src/server/decisions/decisions.ts:869`), so its `blocks` list is always empty. The clause's `blocks` is used for
  the queue's order (`PRIORITY`, `src/server/decisions/decisions.ts:121` and `:305`) and for the runs a failure
  question lists (`blockedRuns`, `:123-132`), nothing else.
- Seen on a live instance: policy `loose`, where the clause for a trunk failure reads
  `failure  always  member  advice  release` (release means planned runs only). A failing report on `main`, then:
  ```
  casebook gate    blocked: 1 failure unexplained, 1 question open
    Q-1 needs an answer
  exit=2
  ```
- Proposed, `docs/architecture.md`: "A project's strictness is a table of clauses: for a kind of question under some
  conditions, who must answer (a rule, a member, an admin, the author) and what an agent's answer is worth (counted,
  advice, refused). A clause also carries `blocks`, which orders the queue and says which runs a failure question
  lists. It does not decide a gate: a failure nobody has explained blocks every run that shows it under every
  policy, and no other kind of question blocks a run."
- Proposed, `src/core/kinds.ts:241`: "How urgent an open question is and which runs it lists: nothing, the gate of
  its change, a release (planned run), or both. It does not decide a verdict (see `retally`)."

### W2. The restore steps leave a server-mode instance nobody can sign in to

- `docs/deploy.md:59`: "**Restore:** start an empty instance and run `casebook import <file>`."
- What happens (built executable, `CASEBOOK_MODE=server`, token generated on first start, import with that token):
  ```
  imported 48 rows across 36 tables
  Import replaced the bootstrap rows. Your previous session may no longer exist. Set CASEBOOK_OWNER_TOKEN and restart the server to reconnect.
  $ casebook policy show
  unauthenticated: a token is required
  ```
  After a restart with `CASEBOOK_OWNER_TOKEN` set, `casebook gate --commit ...` answered from the imported data.
- Also: the instance must have no tokens beyond the owner's. After `casebook token new --ci ...` the import is
  refused: `conflict: import needs a fresh instance; existing projects or user data will not be replaced`.
- Proposed: "**Restore:** start an empty instance, run `casebook import <file>` before creating any token, then
  restart the server with `CASEBOOK_OWNER_TOKEN` set. The import replaces the instance's first rows, the owner's
  token among them, so the token you imported with stops working until the restart."
- Not tested: an instance that had `CASEBOOK_OWNER_TOKEN` set from its first start, and local mode.

### W3. Not every answer applies to later occurrences of the cause

- `README.md:48-50`: "`d` defect, `f` flaky, `i` infrastructure, `e` expected. Your answer is recorded with your
  name and applies to later occurrences of the same cause until the evidence changes."
- What the code does (`src/server/decisions/kinds.ts:376-399`): `infra` holds for the build it was given for and no
  other; `flaky` holds for `flakyDays` (14); `defect` and `expected` hold on the cause, which for a failure question
  is the signature and scope (`src/server/decisions/decisions.ts:775`) and so never changes: they stand until
  withdrawn or replaced. Decision 0012 item 8 says the same.
- Seen on a live instance: Q-1 answered `{"is":"infra"}`, gate of that commit `passed`, exit 0. Same failure on the
  next commit of `main`: `1 new   Q-6 "expected 90.00, got 100.00 | coupon.ts"`, gate `blocked`, exit 2.
- Proposed: "Your answer is recorded with your name. `d` and `e` apply to later occurrences of the same cause until
  they are withdrawn or replaced, `f` for 14 days, and `i` excuses that build only."

### W4. The CLI does not print the answer keys, labels or sentences

- `docs/architecture.md:136-137`: "The answer keys in the queue, their labels and the sentence beside each come
  from one map in `src/core/kinds.ts`, which the CLI prints too."
- `src/core/kinds.ts:131-133`: "Declared here once; the queue and the CLI both print it."
- What the code does: there are three maps (`ANSWER_KEYS`, `ANSWER_LABELS`, `ANSWER_HELP`), imported only by
  `src/web/queue/index.tsx`, `src/web/changes/index.tsx` and tests. `grep -rn "ANSWER" src/cli` finds nothing; the
  CLI imports only `Policy`, `ActorKind` and `Kind` from that file.
- Proposed, architecture: "The answer keys in the queue, their labels and the sentence beside each come from three
  maps in `src/core/kinds.ts` (`ANSWER_KEYS`, `ANSWER_LABELS`, `ANSWER_HELP`)."
- Proposed, comment: "Declared here once; the queue prints it."

### W5. A failure question is closed without an answer in two ways, not one

- `docs/decisions/0012-mvp-scope-and-departures.md:107-110`: "A question about a failure is closed without an answer
  only when nothing that speaks for it still shows the failure [...] and something shows it gone".
- Same "only when" in `docs/diagrams/src/question-lifecycle.json:376`.
- What the code does: that is `dissolveStale`/`stoppedFailing` (`src/server/decisions/decisions.ts:892-949`). A
  second path, `closeAnswered` (`:569-587`), closes an open failure question when every build it had seen the cause
  on has an answer in force from another question, on an answer, a withdrawal and an expiry (`:507`, `:694`, `:978`).
  The withdrawal reply says so: "another answer in force still covers this failure, so nobody is asked about it".
- Proposed: "A question about a failure is closed without an answer in two cases. One: another answer in force
  already covers every build it had seen the cause on. Two: nothing that speaks for it still shows the failure (the
  newest commit's run, and every open planned run the question names) and something shows it gone: one of its tests
  passing on the newest commit, or a planned run that showed it and no longer does."

### W6. The architecture diagram source says the slice is 500

- `docs/diagrams/src/architecture.json:902`: "processBatchSteps applies the batch in one second transaction. SLICE is
  500; a yield keeps that transaction open."
- The same file, line 452: "COMMIT; then slices of 200". Code: `export const SLICE = 200`
  (`src/server/evidence/evidence.ts:641`).
- Proposed: "processBatchSteps applies the batch in one second transaction. SLICE is 200; a yield keeps that
  transaction open."

### W7. "One transaction, one sequence number" is not true of a report

- `docs/decisions/0012-mvp-scope-and-departures.md:18`: "Every write is one command: one transaction, one sequence
  number, idempotent on a client command id, attributed to an actor."
- It contradicts departure 6 in the same file (line 84: "A report is two transactions"). In the code a report
  commits, publishes, begins again and takes the next number (`src/server/ops/registry.ts`, the `COMMIT` branch:
  `stampSeq(ctx); app.db.commit(); publish(); app.db.begin(); ctx.seq += 1;`).
- `docs/architecture.md:63-65` and `:81` ("Every command gets the next sequence number") have the same gap.
- Proposed, 0012: "Every write is one command, idempotent on a client command id and attributed to an actor: one
  transaction and one sequence number, except a report, which is two of each (departure 6)."

### W8. Two diagram sources name symbols that are not in the files they cite

- `docs/diagrams/src/question-lifecycle.json:201` and `:226`: source `src/server/runs/runs.ts`, label
  `isLatestInScope`. No such name exists; the function is `newestInScope` (`src/server/runs/runs.ts:867`).
- `docs/diagrams/src/architecture.json:474`: source `src/server/kernel/witness.ts`, label "Witness; mintWitness".
  `mintWitness` is in `src/server/decisions/decisions.ts:119`; `witness.ts` exports `claimMint`.
- Proposed: `newestInScope`; "Witness; claimMint".

### W9. The start banner in the README is not what the server prints

- `README.md:16`: `project "scratch" · you are daniel · policy: loose`
- Printed (`USER=daniel bun run start`): `project "scratch" · you are daniel@this-machine · policy: loose`
  (`src/cli/commands/serve.ts:21`).
- Proposed: `project "scratch" · you are daniel@this-machine · policy: loose`

## Out of date wording

### O1. The diagram pages linked from the architecture doc are older than their sources

`docs/architecture.md:9-11` links `diagrams/architecture.html`, `red-build.html` and `question-lifecycle.html`.
Last change of each page against its source (`git log -1`):

| Page | Page last changed | Source last changed |
| --- | --- | --- |
| `red-build.html` | bc50794, 10-11 23:59 (fourth snapshot) | 1771493, 10-12 05:08 (fortieth) |
| `question-lifecycle.html` | 72724c6, 10-11 23:51 (third) | 1771493, 10-12 05:08 (fortieth) |
| `architecture.html` | 884fe9b, 10-12 01:28 (twelfth) | 884fe9b, same commit |

The three `.png` files are from 72724c6 (third snapshot). What the pages still say:

- `red-build.html:5632`: "A loose project uses failure-on-base to decide inherited when the same cause fails on the
  base. That rule still records a decision." No preset has such a rule (`src/core/presets.ts:37-55`).
- `question-lifecycle.html:5492`: "fact-gone: the occurrence must still contain fact. inherited combines
  basis-changes with hint:fails-on-base." There is no `fact-gone` term (`src/server/decisions/questions.ts:67-73`);
  `inherited` holds for one build (`src/server/decisions/kinds.ts:388-391`).
- `question-lifecycle.html:4985`: label `isLatestInScope` (see W8).
- `architecture.html:5801`: "SLICE is 500" (see W6).

Proposed: regenerate the three pages and screenshots from the sources after W6 and W8 are fixed, as
`docs/diagrams/src/README.md` describes.

### O2. `qualifies` still says a manual-only case is never filled by a test

- `src/core/runs.ts:217-218`: "Method: named by the obligation and declared by the case. A manual-only case is never
  filled by a test, and an agent's result counts only where a run asked for it."
- What the code does: the caller adds `auto` to the case's methods for every automated result
  (`methodsOf`, `src/server/runs/runs.ts:808`), so a case that declares only `human` is filled by its linked test
  whenever the obligation lists `auto`, which the default does (`:1086`). Decision 0012 item 3 says this.
- Proposed: "Method: named by the obligation, and admitted by the case. A person and an agent are admitted when the
  case declares them; an automated test is admitted by its link or annotation (the caller adds `auto`), so whether a
  test fills the slot is the obligation's choice. An agent's result counts only where a run asked for it."

### O3. `scopeIn` and `runsShowing` describe one commit answered in two scopes

- `src/server/runs/runs.ts:873-877`: "A commit has one run but can be reported on two lines (a pull request's head
  that reaches trunk): each result is then answered where it was reported, never by the other line's answer."
- `src/server/runs/runs.ts:669`: "(Not narrowed to a scope: a commit's run can hold results of two.)"
- What the code does: every later target of a commit takes the first one's line and change
  (`src/server/evidence/evidence.ts:393-406`), so a commit's run has one scope. Decision 0012 item 17 says this.
- Proposed, `scopeIn`: "The scope in which a failure seen on this target is answered, for this run: the target's own
  (its pull request, its line, or the run it was typed into). Every target of a commit shares the scope the commit
  was first reported in; a planned run that counts one commit in two repositories has one scope for each."
- Proposed, `runsShowing`: "(Not narrowed to a scope: a planned run can hold results of two.)"

### O4. A "here only" answer covers the latest build, not every build the question has seen

- `src/server/decisions/decisions.ts:768`: "Every target this question has seen the cause on: an answer that holds
  'here only' covers these."
- `src/server/decisions/questions.ts:69`: "Holds on the targets the question had seen when it was answered, and on
  no other."
- What the code does: the hold names the target of the latest evidence only
  (`src/server/decisions/kinds.ts:378-380`); the other targets of that commit are asked about again (`:354-361`).
  The list of seen targets is what `mistaken` and `closeAnswered` read.
- Proposed, `decisions.ts:768`: "Every target this question has seen the cause on. An answer that holds 'here only'
  covers the latest of them; the others of that commit are asked about again."
- Proposed, `questions.ts:69`: "Holds on the target the person answering was looking at (the latest the question
  had seen), and on no other."

### O5. `raise` still lists "a fact is gone" as a way an answer stops holding

- `src/server/decisions/decisions.ts:169-171`: "Any other way of no longer holding (the evidence changed, the time
  ran out, a fact is gone) withdraws its standing."
- `stillHolds` (`:337-360`) has four terms and none about facts; it never reads `occurrence.facts`.
- Proposed: "Any other way of no longer holding (the evidence changed, the time ran out) withdraws its standing."
- Related, `:245-250` (`lapse`): the comment gives two reasons (time ran out, evidence changed). `endReplaced`
  (`:532-552`) also calls it when a newer answer takes an older one's place, which is then recorded as `outdated`.
  Proposed addition: "or another answer took its place".

### O6. A comment in `processBatchSteps` describes a step that is gone

- `src/server/ops/writes.ts:168-170`: "This commit may be where a change started: an answer that a failure was
  already there is checked again for the tests it touched. And a report on a change may have moved the change onto
  another base: then every such answer for the change is checked."
- Nothing follows it but the lines that pick the run for the receipt. No answer stands on the base (0012 item 4).
- Proposed: delete the three lines.

### O7. Reads between slices are answered by reader threads

- `docs/decisions/0012-mvp-scope-and-departures.md:85-86`: "the server answers reads between slices from a second,
  read-only connection."
- `docs/diagrams/src/architecture.json:903`: "app.reader sees committed snapshots while app.gate queues other writes."
- What the code does: a read goes to a pool of reader threads, each with its own connection
  (`invokeAsync`, `src/server/ops/registry.ts`; `src/server/readers.ts`). The single second connection is used only
  with `CASEBOOK_READERS=0` or as the fallback. `docs/architecture.md:65-67` already says this.
- Proposed, 0012: "and reads are answered meanwhile by reader threads, each with its own read-only connection."
- Proposed, diagram: "invokeAsync yields to the event loop. Reader threads see committed snapshots while app.gate
  queues other writes."

### O8. "Any other miss withdraws the effect" is not true of a `mistaken` answer

- `docs/diagrams/src/question-lifecycle.json:359`: "An occurrence on another target is asked about and leaves the
  answer standing. Any other miss withdraws the effect, records expired or outdated [...]".
- `results-named` behaves like the target term: a later occurrence is asked about and the decision stands
  (`src/server/decisions/decisions.ts:350-353`).
- Proposed: "An occurrence on another target, or a new result after a mistaken answer, is asked about and leaves the
  answer standing. Any other miss withdraws the effect, [...]".

### O9. The two checked-in benchmark logs are from old code and contradict `bench/README.md`

- `bench/results-full.log` (last changed 2b252bb, fifth snapshot): five in-process "HTTP window" rounds with four
  reader threads, and it ends "4 primary misses and 5 repeat misses" (`case read ... p95<20 MISS`,
  `mixed HTTP reads ... p95<50 MISS`). `bench/README.md` (3bbc540) describes three windows against a server in its
  own process and says the read budget is met with eight threads.
- `bench/results-quick.log` is not a result: "SyntaxError: Export named 'mintWitness' not found in module
  '.../src/server/kernel/witness.ts'".
- No document cites either file. Proposed: replace both with logs of the current benchmark, or delete them.

### O10. The lane rule is written twice, not once

- `docs/decisions/0012-mvp-scope-and-departures.md:38-40`: "Slots follow the same rule, from the same function
  (`replacesInLane`), so a commit's gate and a slot cannot disagree".
- `src/core/runs.ts:146`: "A commit's gate and a slot both use it, so they cannot disagree."
- What the code does: on a report, the commit's gate applies the rule as the SQL condition of `upsertRunTest`
  (`src/server/runs/runs.ts:152-160`); the function is used for slots and when a lane is refolded. The two are held
  together by `test/sequences.test.ts:143`, which models the gate with the function.
- Proposed, 0012: "Slots follow the same rule (`replacesInLane`; the commit's gate applies it as the condition of one
  SQL statement, and `test/sequences.test.ts` checks the two agree), so a commit's gate and a slot do not disagree".

### O11. A test comment still says a rule excuses as `inherited`

- `test/evidence.test.ts:116`: "in a loose project the rule has already excused it as inherited, so the stale answer
  cannot land" (and `:112`, "gains a hint: fails on base").
- The answer is a conflict because a newer build arrived, which changes the evidence hash
  (`src/server/decisions/decisions.ts:154-159`). No rule answers.
- Proposed: "a newer build has arrived since the answer was prepared, so it is a conflict".

### O12. The diagram sources name a revision 34 commits back

- `docs/diagrams/src/*.json:11`: `"revision": "25d5571300b6853774a320cc7a03ccd34367feca"` (eleventh snapshot).
  `docs/diagrams/src/README.md` says each candidate names the revision its source links point at; two of the three
  were edited at the fortieth snapshot.
- Proposed: set it to the commit the pages are regenerated from (O1).

## Unclear

### U1. "A closed run refuses results" is true only of a report that names the run

- `docs/decisions/0012-mvp-scope-and-departures.md:90-91`: "A closed run refuses results. [...] Here the report is
  refused with a message saying how to reopen the run".
- `acceptReport` refuses only when `input.run` is the closed run (`src/server/ops/writes.ts:109-110`). A pipeline's
  late upload for the commit the run counts is accepted, counts in the commit's gate, and does not reach the closed
  run, because only open planned runs are folded (`src/server/runs/runs.ts:444`).
- Proposed: "A closed run takes no more results. A report that names it is refused with a message saying how to
  reopen it (withdraw the sign-off); a late upload for its commit is recorded for the commit and does not reach it."

### U2. "What is not standing" leaves out the four writers that undo a decision

- `docs/decisions/0012-mvp-scope-and-departures.md:168-169`: "Four writes look like standing and are not, and take
  no witness". `AGENTS.md`: "written by a function that takes a `Witness`. Do not add a writer without one."
- `restoreLink`, `dropExcuse`, `reopenRun` and `restoreFailures` change standing and take no witness, on purpose
  (`test/architecture.test.ts:187-197`). `docs/architecture.md:144-145` mentions them; 0012 and AGENTS.md do not.
- Proposed addition after the list: "Four more functions put back what a withdrawn or ended decision did
  (`restoreLink`, `dropExcuse`, `reopenRun`, `restoreFailures`). They take no witness either: the withdrawal is the
  recorded event, and a test allows only the kind handlers to call them."

### U3. "One answer in force per cause and target" has two exceptions

- `docs/decisions/0012-mvp-scope-and-departures.md:114-116`.
- `src/server/decisions/decisions.ts:538-545`: a `mistaken` answer takes nobody's place and nobody takes its place;
  an answer for certain targets leaves an older answer for the whole cause standing underneath, and that older
  answer covers the target again when the newer one is withdrawn (`:692-693`).
- Proposed: add "(a `mistaken` answer, which is about named results, is outside this rule; an answer for one target
  sits over an older answer for the whole cause, which covers that target again if the newer one is withdrawn)".

### U4. Not every column that names a decision is a foreign key

- `docs/decisions/0012-mvp-scope-and-departures.md:167-168`: "every column that cites a decision is a foreign key
  into the ledger".
- `questions.decision` and `slots.waiver` are plain integers
  (`src/server/kernel/migrations/0001_init.sql:434`, `:577`). Neither is standing a writer cites (the first is the
  ledger's own pointer, the second is never written).
- Proposed: "every column in which standing cites a decision is a foreign key into the ledger".

### U5. Issue #30 does not mention sign-in rate limiting

- `docs/deploy.md:42-43`: "prefer the tailnet until accounts and sign-in rate limiting exist (#30)."
- #30 ("Accounts, invitations, teams and SSO") lists sign-in, invitations, roles, teams and token use. Rate limiting
  is in no issue I found.
- Proposed: add rate limiting to #30, or write "until accounts exist (#30) and sign-in is rate limited (no issue yet)".

### U6. "See the pull request" points at a pull request that does not exist yet

- `docs/deploy.md:7` ("see the pull request for the commands and output") and
  `docs/decisions/0012-mvp-scope-and-departures.md:4`. `gh pr list --state all` shows no pull request for this
  branch. The description of the one that is opened has to carry those commands, or the sentence points at nothing.

### U7. The browser tests are skipped where no Chromium is found

- `README.md:94` and `AGENTS.md` ("every test including the budgets and the browser tests").
- `test/e2e/support.ts:9-17`: they run only with `CASEBOOK_CHROMIUM` set or a browser at `/usr/bin/chromium`,
  `/usr/bin/google-chrome` or `/usr/bin/chromium-browser`; otherwise each is skipped with one line of output.
- Proposed: "... and the browser tests (skipped, with a message, on a machine with no Chromium)".

### U8. The `decide` tool description lists five of the seven failure answers

- `skill/casebook/references/tools.md:163` (generated from `src/server/ops/writes.ts:418`): "Failure answers:
  {"is":"defect"|"test"|"expected"|"flaky"|"infra"}." `inherited` and `mistaken` exist and are offered per question
  in `answers` (`src/core/kinds.ts:172-197`).
- Proposed, in the registry: "Failure answers: defect, test, expected, flaky, infra, and where the question's
  `answers` lists them, inherited and mistaken."
- Same file, `:196`: "Read things by ref (C-, Q-, R-, T-)" while `refs` also takes proposals (P-).

### U9. The skill does not mention `declined`

- `skill/casebook/references/reporting.md:9`: "A refused result has a reason in `rejected`".
- An automated result whose claim about a case is refused is kept with no case and listed under `declined`
  (`src/server/evidence/evidence.ts:752-763`); an agent reading only `rejected` misses it.
- Proposed: "A refused result has a reason in `rejected`. An automated result kept without the case it claimed has
  its reason in `declined`."

### U10. `casebook report` and `casebook gate` need a commit from CI or a Git checkout

- `README.md:36-37` shows the two commands bare. Outside CI and outside a Git checkout:
  ```
  $ casebook report results/*.xml
  invalid: missing commit; provide --commit <sha> or --session <name> (a session has no build identity)
  exit=4
  ```
  Exit code 4 (an error) is not among the four the README lists.
- Proposed, after line 41: "Outside CI the commit comes from the Git checkout; with neither, pass `--commit`. An
  error exits 4."

### U11. The proof cited for start-up recovery is not the test that proves it

- `docs/decisions/0012-mvp-scope-and-departures.md:25`: "Start-up recovery of interrupted reports. | the transfer
  and CLI tests". The test is `test/restart.test.ts`.
- Proposed: "`src/server/transfer/transfer.test.ts`, `test/restart.test.ts`, the CLI tests".

## Commands in the README, run against a real instance

Instance: `bun run start` with `HOME` pointed at a scratch directory and `CASEBOOK_PORT=8250`. `casebook` was
`bun src/cli/main.ts`.

| README | Result |
| --- | --- |
| `bun install`, `bun run start` | Works. Banner differs in one word (W9). `/api/session` on loopback: owner, `via: local`. |
| Outline under "Write a case" (piped to `casebook new`) | Works: C-1, three steps, two expected results, tag `checkout`. |
| `casebook report results/*.xml` | Works with a CI environment (GitHub variables set by hand). Fails without CI or Git (U10). |
| `casebook gate` | Works: `blocked ...`, exit 2; after an answer `passed`, exit 0; unknown commit `pending`, exit 3. |
| `casebook token new --agent reviewer --can read,produce` | Works. |
| `casebook mcp`, and `/mcp` over HTTP | Both list ten tools. |
| `casebook policy use standard`, `casebook policy show` | Work. `strict` is accepted too. |
| `casebook export --out casebook.ndjson.gz` | Works: 36 tables, no tokens. |
| `bun run build` | Works: `dist/casebook`; started in server mode, `casebook health` exit 0. |
| `docker compose up -d` | Not run. |
| `bun run check`, `bun run dev`, `bun bench/run.ts`, `bun bench/external.ts` | Not run (see below). |

Keys named in the README (`c`, `g q`, `d` `f` `i` `e`, `u`, `g r`, `n`, `p` `f` `b` `s`) all exist in the web
bindings (`src/core/kinds.ts:101`, `src/web/**`); I did not press them in a browser.

## Links and issue numbers

- 73 relative links and repository paths in the listed documents: all exist (the only miss is the placeholder
  `docs/decisions/NNNN-title.md` in AGENTS.md).
- 24 issue numbers (#30, #32, #33, #35, #38, #41, #42, #48 to #60, #63, #64, #68, #69): all exist, all open, all in
  the milestone `Backlog to 1.0` (40 open). #64 lists every other issue of the milestone. Each is about what its
  sentence says, except #30 (U5).
- Not a document, but the owner will follow the link: the body of #60 still says "slices of 500" and its comment
  says "default up to 4" reader threads; the code and `bench/README.md` say 200 and up to 8.

## Checked and found accurate

- Decision 0012: departures 1, 3, 4, 5, 9 to 18 and the rest of 2, 6, 7 and 8 match the code as read (1 and 10
  were checked only through one export and one import). Nothing in it still
  says a rule excuses a failure the base has, and it has no `fact-gone` hold, no fallback to the newest trunk commit
  and no `decision_rests`. The seven test files it cites pass (158 tests, 0 fail, run in the export).
- `docs/architecture.md`: fifteen operations, ten agent tools, 38 tables with one owner each, the rules in
  `test/architecture.test.ts`, the two transactions and the slice of 200.
- `docs/deploy.md`: the variable table, the reader default, uid 10001, the health check, the backup file name
  (`casebook.db.v<N>.bak`), the workflow variables, the `--ci` token command.
- `skill/casebook`: `tools.md` is identical to what `bun scripts/gen-skill.ts` writes now; the 4 MiB limit on `/mcp`
  is real (HTTP 413 at 5 MiB); the sample Markdown in `writing-cases.md` is canonical (`casebook fmt` prints it back
  unchanged).
- `src/web/SHELL.md`: every export, route, token and class it names exists.
- `CHANGELOG.md`, `AGENTS.md` ("State", "Stack rules"), `src/core/presets.ts`, the head comments of
  `src/server/decisions/kinds.ts` and `src/server/evidence/evidence.ts`: no inaccuracy found.

## Not checked

- `bun run check` as a whole, `bun run dev`, and both benchmarks: the browser tests and the benchmark start servers
  on fixed ports 7400 to 7449, outside the range I was given. The numbers in `bench/README.md` are unverified; its
  parameters (scales, windows, slice, budgets named in the table) were read against `bench/*.ts` only.
- The Docker image and `docker compose` (not built), and anything about Coolify.
- The web UI in a browser: keys, drafts, the queue's sentences. Read from the source only.
- The start-up backup before a migration (there is one migration, so the path never runs).
- `docs/product-design.md`, `docs/design-arena/`, other decision records and `src/**/CHECKS.md`: out of scope.
  `docs/product-design.md` still describes the loose rule that excuses base failures (for example lines 243, 267
  and 776); decision 0012 item 4 is the record that it was cut back.
- The generated HTML pages beyond the stale sentences quoted in O1.
- Function comments in the seven source files were read in full for `decisions.ts`, `kinds.ts` (both), `runs.ts`
  (both) and `presets.ts`; in `evidence.ts` the SQL declarations (lines 120 to 317) were only searched, not read.
