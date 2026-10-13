# Mainworthy engine hunt, round 2

Revision `ee6401df39d2f6e08176ead93b4fa1e92bcd751a` (branch `t3/mvp-product-delivery`), exported with `git archive`
into `hunt-r2/tree` and installed with `bun install --frozen-lockfile`. Nothing in the repository was touched.
Everything below ran in-process through `invoke` (the harness in `test/helpers.ts`), on this machine. Each
reproduction is `bun scripts/<name>.mjs` from this directory; each asserts the defect and prints the deciding rows.
Each defect was confirmed on two separate runs (`logs/<name>-1.log`, `logs/<name>-2.log`, identical output).

Round 11's R11-B01 to R11-B05 are fixed in this revision and are not repeated here; nothing below says a fix is wrong.

## Confirmed defects

### H2-01: once a dispute is resolved or its run is closed, the producer of the failure withdraws or replaces the decision that went against it

Reproduction: `bun scripts/producer-undoes-mistaken.mjs`, under `standard`, whose `failure-disputed` clause asks
"one member who did not produce the evidence". Alice fails C-1 in a planned run over a commit (`cause a`), Bob passes
it: the slot is disputed, and Alice's own answer is refused (`forbidden`, the control in the script). Carol, not a
party, answers. Then Alice withdraws Carol's answer (`decide { undo }`) or replaces it with her own.

Deciding output (`logs/producer-undoes-mistaken-1.log`; eight variants, six wrong):

```
open-run mistaken undo     alice: reopened   run_after: open blocked 1 disputed   ledger: mistaken by carol under failure-disputed, withdrawn by alice under failure-change
open-run mistaken replace  alice: decided    run_after: open pending 0 disputed   ledger: mistaken by carol under failure-disputed, flaky by alice under failure-change
open-run flaky undo        alice: forbidden  (correct)
open-run flaky replace     alice: forbidden  (correct)
closed-run mistaken undo   alice: reopened   run_after: closed blocked 1 disputed
closed-run mistaken replace alice: decided
closed-run flaky undo      alice: reopened   run_after: closed blocked 1 disputed   ledger: flaky by carol under failure-disputed, withdrawn by alice under failure-change
closed-run flaky replace   alice: decided    ledger: flaky by carol under failure-disputed, infra by alice under failure-change
```

Two ways in, both through `factsNow` (`src/server/decisions/decisions.ts`), which reads `hint:disputed` from
`inDispute` (`src/server/runs/runs.ts`) when an answer is given, changed or withdrawn:

1. A `mistaken` answer discounts the failing result, so the slot is `satisfied` and `inDispute` is false. The
   withdrawal, and a replacement answer, are then held to `failure-change` (or `failure-any`), which has no
   `notProducer`. The producer of the failure withdraws the judgement that her result was a mistake, and the slot
   is disputed again; or she replaces it with `flaky`, after which the still-disputed slot counts as a pass in the
   run on her own excuse (`open-run mistaken replace`: `pending 0 disputed`, slot `disputed`).
2. `inDispute` reads only open planned runs (`Q.disputedSlots` has `r.state = 'open'`). Carol's `flaky` makes the
   disputed slot count as a pass, the run passes and the rule signs it off. From then on the dispute is invisible to
   the clause, and the producer withdraws or replaces the answer under `failure-change`. The closed run is
   recomputed to `blocked, 1 disputed` under its sign-off.

Contradicts decision 0012 departure 4 ("a new answer, a changed answer and a withdrawal are each held to the clause
for disputes") and P5 (who may answer "cannot be got around by the order of events"). It is wider than issue #70
(an answer given before the dispute stands): here the dispute exists, has been judged by the person the clause
names, and the producer undoes that judgement. Probably the clause for an answer on a question that *was* disputed
when the answer in force was given should be the dispute clause, whatever the slots show now; and `inDispute` should
not forget a dispute because the run it sits in was closed on the very answer being withdrawn.

### H2-02: an agent's report decides which scope a commit's failures are answered in, and a standing answer in that scope turns a pull request's gate from blocked to passed

Reproduction: `bun scripts/agent-names-scope.mjs`, under `loose`. Trunk commit `1111…` fails `test 0` with cause X;
Alice answers `flaky`, which stands on the trunk line (`line:trunk@acme/web`). The pull request `pr:7` has head
`2222…`, which fails `test 0` with the same cause. Without an agent, the pipeline's report of `2222…` with `pr: 7`
opens a new question in scope `change:1` and the change's gate is `blocked`. With an agent that first sends one
skipped result of its own key for `2222…` with `branch: "main"` (no `pr`), the same pipeline report is answered by
Alice's trunk answer.

Deciding output (`logs/agent-names-scope-1.log`):

```
withAgent=false: pipeline receipt {"gate":"blocked", "questions":["Q-3 new null"]}
withAgent=false: targets  … {"what":"code:acme/web@2222…","line":"change","change":1,"branch":"feature"}
withAgent=false: gate --change pr:7 {"verdict":"blocked","reason":"blocked: 1 failure unexplained, 1 question open","open":["Q-3"]}

agent's receipt gate {"run":null,"verdict":"pending","reason":"pending: nothing a gate counts has been reported for this commit"}
withAgent=true: pipeline receipt {"gate":"passed","reason":"passed: 1 result proven","questions":["Q-1 already decided flaky"]}
withAgent=true: targets  … {"what":"code:acme/web@2222…","line":"trunk","change":null,"branch":"main"}
withAgent=true: runs ["1111111 on main scope=line:trunk@acme/web passed","2222222 on main scope=line:trunk@acme/web passed"]
withAgent=true: gate --change pr:7 {"verdict":"passed","reason":"passed: 1 result proven","open":[]}
withAgent=true: failure questions [Q-1 line:trunk decided]   (no question about the change at all)
```

The agent's report was counted nowhere, its own gate read `pending: nothing a gate counts`, the change's head and
base were set by the pipeline. What the agent did set is the target row: `ensureTarget` (`src/server/evidence/
evidence.ts`) inserts the target with the line, branch and change of the first report of the commit, whoever sent
it, and every later target of the commit copies `first.line` and `first.change`. The run the pipeline's report then
creates takes `scopeOf(target)` from that row, so the failure is keyed `X|line:trunk@acme/web` and the trunk answer
carries to it. The other direction holds too (an agent naming a trunk commit as `pr:N` before the pipeline puts the
trunk commit's failures in a change scope, where `inherited` applies and the clause blocks `change` instead of
`release`).

Contradicts decision 0012 departure 3 ("What an agent reports never moves a commit's gate … Nor does it make a
commit current") and departure 17 ("One commit, one place where its failures are answered: the line or the change it
was first reported on"), read with the new rule that an agent's report does not count as a first report (`firstSeen`),
and the brief's fact that an agent's result never turns a failing gate green. Cause: `ensureTarget` decides `line`,
`branch` and `change` from the first target row of the commit regardless of who made it; R11-B03's fix taught
`upsertChange` to ignore an agent's placeholder but `ensureTarget` still copies the agent's placing. A target an agent
made should not fix the commit's line or change: the first report a gate counts should (or the agent's target should
be re-placed by it).

### H2-03 (lesser): a person's typed case result, sent with one skipped automated key under a CI job's name, meets the run's `jobs` obligation

Reproduction: `bun scripts/person-meets-job.mjs`, under `standard`. A run requires a person to exercise C-1 and the
job `e2e` to have reported. Alice sends one batch into the run with `job: "e2e"`: her pass of C-1 (method `human`)
and one skipped automated key (method `auto`).

Deciding output (`logs/person-meets-job-1.log`):

```
typed only              batch method human  gate pending (pending: 1 result missing)   run open pending
typed + one skipped key batch method auto   gate passed (passed: 1 result proven)      run closed passed
```

With the typed result alone the job stays missing, as departure 2 says. Adding a skipped key makes `batchMethod`
(`src/server/evidence/evidence.ts`) label the whole batch `auto` ("when a person sent both kinds together"), and
`Q.processedJobs` then counts the batch for the job because *some* result in it is decisive: the person's own pass,
whose method is `human`. The run passes and the rule closes it. The automated part of the batch proved nothing.
Contradicts departure 2 ("met by a pipeline's report that ran something … not by a report in which every result was
skipped") and departure 3 (the method is decided per result, not per batch). Cause: `processedJobs` tests the
batch's shown method and any decisive result; it should require a decisive result whose own method is `auto`.

The other direction, `bun scripts/agent-names-change.mjs` (`logs/agent-names-change-1.log`): an agent names trunk
commit `5555…` as `pr: 42` before the pipeline reports it on `main`. The pipeline's failure is then answered in
`change:1` with facts `scope:change`, `inherited` is offered for a trunk failure, the clause blocks `change` rather
than `release`, and the change `pr:42` exists with no head:

```
withAgent=false {"target":{"line":"trunk","change":null},"questionScope":"line:trunk@acme/web","facts":["scope:trunk"],"answers":[… "infra"]}
withAgent=true  {"target":{"line":"change","change":1,"branch":"feature"},"questionScope":"change:1","facts":["scope:change"],"answers":[… "infra","inherited"],"changes":[{"key":"pr:42","head_sha":null}]}
```

The hunt's extended sequence test finds this class by itself (audit 16, below): with the audit armed
(`MAINWORTHY_SEQUENCE_PLACEMENT=audit`) it stops at seeds 3, 7, 8 and 10 of the first ten under every preset.

## Observations, not counted as defects

- **The queue's stated need goes stale after a policy switch** (`scripts/stale-ask-after-policy-switch.mjs`,
  `logs/stale-ask-after-policy-switch-1.log`): a failure question raised under `loose` keeps `needs: "one member"`
  after the project switches to `strict`; an answer is correctly held to `strict` (`invalid: a reason`; an agent
  `forbidden`). `askNow` returns the stored `ask` unless the dispute fact changed. Display only; the engine decides
  right.
- **A withdrawal recomputes a closed run under its sign-off** (`scripts/reopen-around-mistaken.mjs`, "after undo:
  B: closed blocked"): withdrawing the `mistaken` answer a closed run was signed off on leaves it `closed` and
  `blocked`. Departure 8 says a run that has since closed is recomputed when an answer stops holding, so this is as
  designed; it is the state H2-01 lets the producer create.

## What was tried that held

- **Reopening around `mistaken`** (`scripts/reopen-around-mistaken.mjs`, two runs): two runs over one commit share
  Alice's disputed failure; `mistaken` given, withdrawn and given again while one run is closed by rule; that run
  reopened by withdrawing its sign-off; the second `mistaken` withdrawn. The reopened run discounts under the
  decision in force, the commit's gate agrees, and after the withdrawal both runs show the dispute again.
- **R11-B01 to R11-B05**: the shipped `test/integrity.test.ts` and the sequence runs below exercise the fixed paths;
  nothing found says a fix is wrong. R11-B05's fix is what H2-01 goes around: the dispute is now read when an
  answer is given, but read only from open runs and only as the slots stand after the answer being undone.

## The extended sequence test

`hunt-r2/sequences-extended.test.ts` is `test/sequences-extended.test.ts` with two audits and two actions added,
ready to copy into `test/` (type-checks with `bunx tsc --noEmit` in the export). New, written against the rows:

- **Audit 13'**: a required job is met only by a batch holding a decisive result whose own `method` is `auto`
  (not the batch's shown method). Catches H2-03. Armed with `MAINWORTHY_SEQUENCE_JOBS=audit`; without it the audit
  restates the engine's current rule, so the test passes on this revision.
- **Audit 16**: a commit's `line`, `branch` and `change` are those of the first report a gate counts, compared with
  what the generator sent (recorded per repository and commit, including reports sent through `acceptReport` and
  recovery; a commit first met by a result typed into a run is skipped, as it says nothing about where the commit
  is). Catches H2-02. Commits an agent reported before anyone else are skipped unless
  `MAINWORTHY_SEQUENCE_PLACEMENT=audit`.
- **Actions**: an agent sometimes names a trunk commit as the change or a change commit as trunk, before or after
  the pipeline; a person's result typed into a run sometimes carries a job name and a skipped automated key.

Runners: `bun scripts/seq-one.mjs <seed> <preset>` and `bun scripts/seq-many.mjs <first> <count> [preset|all]
[steps]` (both load the copy at `tree/test/sequences-hunt2.test.ts`).

Runs (`logs/`):

- `seq-150x120.log`: seeds 11 to 160 × 120 steps × 3 presets with audit 13' armed and audit 16 guarded, 450
  sequences in 270 s: 23 stops. 20 are audit 13' and each one checked is H2-03 (a person's typed pass plus a skipped
  key under the job's name; seeds 13, 40 and 134 under `loose` shown in the report's logs); 3 are seed 30 under each
  preset, an audit flaw since fixed (a placement sent through the recovery path was not recorded). Nothing else.
  Command outcomes over the run: 27,927 reports, 12,476 decisions, 2,953 plans accepted; the refusals are the
  expected ones (a `self` run with a `jobs` obligation, a commit reported by two repositories, a report into a
  closed run).
- With audit 16 armed, seeds 1 to 10 stop at seeds 3, 7, 8 and 10 under `loose` (3, 8, 10 under the others), each
  the agent-first placing of H2-02 (`seed-one` output for seeds 3 and 10 in the report above).
- `seq-guarded-150x120.log`: seeds 200 to 349 × 120 steps × 3 presets with both new audits guarded (the fourteen
  earlier audits and the new actions in force): 450 sequences in 285 s, **no problem**. 28,856 reports, 12,465
  decisions, 3,037 plans accepted.

So beyond H2-02 and H2-03, 900 sequences of 120 steps found nothing the sixteen audits can see. H2-01 is not an
audit: the engine's own rows say the producer's withdrawal was lawful under the clause it chose, so no row-level
check tells it from a lawful one without a model of "what the clause should have been"; it needs the fix first.

## Not reached

- Everything ran in-process through `invoke`; nothing was repeated over HTTP, with reader threads, or across a real
  restart (round 11 covered the command-id binding across a restart; nothing here depends on the transport).
- A report whose application fails after acceptance (no deterministic way to make one fail was found without
  editing the export), and a retry of a report while it is being applied (the write gate serialises them).
- Reports above 300 results in a sequence; the 50-test cut on a question's evidence was read but not driven past
  (by reading, a cause whose first fifty listed tests are an agent's and whose counted tests come later stays
  open after the gate passes, because `stoppedFailing` reads `counted` only from the fifty kept: it asks longer,
  never says more).
- Custom clause lists (only the three presets were used and switched between). H2-01 is specific to a policy
  whose dispute clause is stricter than its general one (`standard`); `loose` and `strict` have no such gap.
- The R11 fork note (a plan naming only `{commit}` admits a later fork's result) is recorded there and not repeated.

Every process this hunt started has exited; nothing listens on ports 8200 to 8249. The shared checkout was read
with `git archive` only.
