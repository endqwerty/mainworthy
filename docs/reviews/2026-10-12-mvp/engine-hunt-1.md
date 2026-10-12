# Casebook engine hunt, round 1

Revision `a51da9f9853f4a2754fc8363fb08aeddcdf21049` (branch `t3/mvp-product-delivery`), exported with `git archive`
into `hunt-r1/tree` and installed with `bun install --frozen-lockfile`. Nothing in the repository was touched.
Everything below ran in-process through `invoke` (the harness in `test/helpers.ts`), on this machine. Each
reproduction is `bun scripts/<name>.mjs` from this directory; each asserts the defect and prints the deciding rows.
Logs of every run are in `logs/`. Each defect was confirmed on two separate runs (`logs/<name>-1.log`,
`logs/<name>-2.log`).

Baseline: the shipped `test/sequences.test.ts` with `CASEBOOK_SEQUENCE_SEEDS=150` passes for all three presets
(`logs/baseline-sequences-150.log`).

Summary: five confirmed defects (H1-01 to H1-05), one lesser confirmed finding that is a design call (H1-06), four
observations. Every process this hunt started has exited; nothing listens on ports 8200 to 8249.

## Confirmed defects

### H1-01: a run planned by a commit prefix counts every commit that starts with it, and records typed results on a commit that does not exist

Reproduction: `bun scripts/prefix-run.mjs`. Two trunk commits share their first seven characters
(`abcdef1aaaa…` fails test `t1` with cause `boom`, `abcdef1bbbb…` passes it). A run is planned with
`accepts: { commit: "abcdef1" }`, which the schema allows (`TargetMatch` needs seven characters) and `plan` does not
refuse: `targetByCommit` returns null for an ambiguous prefix instead of throwing, so the run is created.

Deciding output (`logs/prefix-run-1.log`):

```
run after a report on commit b  tally pass:1 missing:1  verdict pending
run after a report on commit a  tally unexplained:1     verdict blocked
admitted results and their commits [{"result":3,"commit_sha":"abcdef1bbbb…"},{"result":4,"commit_sha":"abcdef1aaaa…"}]
typed receipt {"target":"abcdef1", gate: {"run":"R-4", …}}
targets now  … {"id":3,"what":"code:@abcdef1","commit_sha":"abcdef1","line":"change","change":1}
changes now  [{"id":1,"key":"commit:abcdef1","head_sha":"abcdef1"}]
change runs  … {"no":4,"name":"abcdef1 on commit:abcdef1","accepts_what":"code:@abcdef1","scope":"change:1", verdict blocked}
gate of commit b  passed
```

Two things are wrong. (1) The run's slot admits results from both commits: `runs.matches` compares with
`commit_sha.startsWith(accepts.commit)`, so one slot folds two builds, and the earlier version of this script (the
run with one case) showed the run reaching `passed` and being closed by rule on commit b's pass while commit a was
failing the same test. (2) A result a person types into the run with no `target` is recorded on a new target whose
commit is the seven-character prefix itself: `acceptReport` calls `ensureTarget({ commit: accepts.commit })`
verbatim, which makes a new target `code:@abcdef1`, a new change `commit:abcdef1` and a new change run
`R-4 "abcdef1 on commit:abcdef1"`. The typed failure is answered in scope `change:1`, which no real commit has, and
neither real commit's gate counts it (`gate of commit b` stays `passed` with `unexplained: 0`).

The same cause has a second face, `bun scripts/fork-fills-slot.mjs` (`logs/fork-fills-slot-1.log`): a run planned
with `accepts: { commit }` while the hash was known in `acme/web` only (where it fails) is later filled by a fork
reporting the same hash as passing. `accepts` is stored as typed, with no repository, so `matches` admits both:

```
admitted [{"result":1,"repo":"acme/web","outcome":"fail"},{"result":2,"repo":"someone/fork","outcome":"pass"}]
slot state disputed
```

and a person is now offered `mistaken` on the main repository's failure on the strength of a fork's pass; with no
main-repository result at all, the fork's pass alone satisfies the slot. `plan` refuses an ambiguous hash only at
planning time and never pins what it resolved.

Contradicts decision 0012 departures 2 and 17 ("a run that accepts a commit counts that commit… and nothing else";
one commit, one place where its failures are answered) and the brief's identity rule. Cause: `src/server/runs/runs.ts`
`matches` (prefix match), `src/server/runs/runs.ts` `plan` (does not refuse an ambiguous or unknown prefix),
`src/server/ops/writes.ts` `acceptReport` (uses `accepts.commit` as a full hash). A run should resolve what it was given
when it is planned (one full hash, one repository), refuse an ambiguous one, and store what it resolved in `accepts`.

### H1-02: an agent's batch, or a pipeline's batch of skips, satisfies a planned run's `jobs` obligation

Reproduction: `bun scripts/agent-job.mjs`, under `standard`. A run requires a person to exercise C-1 and the CI job
`e2e` to have reported (`{ kind: "jobs", jobs: ["e2e"] }`). A person passes C-1; the gate is `pending: 1 result
missing`. An agent with `read, produce` (the run never asked for agents, the case does not admit them) sends one
passing result of an unrelated test key with `job: "e2e"`.

Deciding output (`logs/agent-job-1.log`):

```
agent: gate with the person's pass and no e2e report  verdict pending  missing:1
agent: gate after  verdict passed  missing:0
agent: run row [{"no":1,"state":"closed","signoff":2,"verdict":"passed"}]
```

The run passes and is closed by the rule sign-off, on the strength of an agent's report. The second half of the
script shows the same with the pipeline's own `e2e` job reporting two skipped results and nothing else: the run
passes too (`observation: a skip-only pipeline batch leaves the run passed`). The first is the defect: decision
0012 departure 3 says an agent's evidence counts only in a planned run that asked for agents on a case that admits
them, and here an agent completes a run's obligation that names a CI job. The second contradicts departure 15 in
spirit (a report of skips only proves nothing) and is at least worth a sentence in the design.

Cause: `src/server/runs/runs.ts` `count` reads `processedJobs(db, target.id)`, and `src/server/evidence/evidence.ts`
`processedJobs` selects every processed batch by job name, whatever its method or producer. The obligation should
count a batch only when a pipeline (or a person passing on a results file, `method = auto`) sent it, and arguably only
when it carried a decisive result.

### H1-03: a producer's answer given before a dispute settles the dispute that the clause reserves for someone else

Reproduction: `bun scripts/producer-settles-dispute.mjs`, under `standard`, whose `failure-disputed` clause asks
"one member who did not produce the evidence". Alice records a failure of C-1 in a planned run (`cause a`). Then
either Bob records a pass first and Alice answers, or Alice answers first and Bob records the pass.

Deciding output (`logs/producer-settles-dispute-1.log`):

```
order fail > pass > answer  facts ["scope:run","hint:disputed"]  reply forbidden "one member who did not produce the evidence who is not an agent"
                            slot disputed  tally disputed:1  verdict blocked
order fail > answer > pass  facts ["scope:run"]  reply decided (clause failure-any)
                            slot disputed  tally pass:1 disputed:0  verdict pending (the spare slot)
```

In the second order the slot is `disputed`, the only answer in force on its cause is the producer's own `flaky`, and
the run counts the slot as a pass (`count` in `runs.ts`: a disputed slot whose every cause is excused counts as
`pass`). The same person, the same evidence and the same policy give opposite outcomes depending on which report
arrived first. P5 says who may answer "cannot be got around by the order of events", and departure 4 says a
clause that keeps a decision from the producers of the evidence names anyone with a result in a slot that disputes it.

Cause: the facts a clause is matched against are fixed on the question when it is raised or attached
(`decisions.ts` `answer` reads `question.evidence.facts`), and a pass that creates a dispute later does not end an
answer in force (`raiseFailure` keeps `hint:disputed` out of `material`, by design since round 10). So nothing ever
re-checks the producer's standing once the slot is disputed. One fix that keeps round 10's rule: when a slot becomes
disputed and the cause's answer in force was signed by a party to that slot under a clause that forbids producers,
end that answer as `outdated` and ask again; or at least refuse to count a disputed slot as `pass` on an excuse
signed by one of its parties.

### H1-04: a run reopened by withdrawing its sign-off still counts a result its producer corrected while it was closed, and can be signed off again on it

Reproduction: `bun scripts/reopen-stale.mjs`, under `loose`. A run over commit `feedface…` is planned; the pipeline
passes the one test linked to C-1; the run passes and the rule closes it. The pipeline then corrects that pass
(`corrects: <id>`, outcome `fail`, cause `boom`): the commit's gate goes `blocked`, and the closed run keeps the pass,
as departure 7 says it should. A person withdraws the sign-off.

Deciding output (`logs/reopen-stale-1.log`):

```
commit gate after the correction  verdict blocked  unexplained:1
run after the sign-off is withdrawn {"state":"open","signoff":null,"verdict":"passed","tally":{"pass":1,…}}
slot results [{"result":1,"corrected":0,"discounted_by":null,"outcome":"pass","corrects":null}]
slot [{"state":"satisfied", …}]
a person approves the reopened run {"status":"decided", …}
run at the end [{"state":"closed","signoff":5,"verdict":"passed"}]
```

The reopened run is live again (it is in the queue, it answers `gate`, a person is asked to sign it off) and it
reads `passed` on a result that no longer exists as evidence anywhere else: the commit's gate counts the correction,
`laneHistory` and `resultsOfCaseOnTargets` exclude the corrected pass, and a run planned now would never admit it.
A person approves and the run is closed, for the second time, on a withdrawn pass. Departure 7 promises that a
correction "withdraws the result it names wherever that counted" and that a reopened run "is asked about every
failure it still shows"; P3 says a later write never hides an earlier failure. Here the withdrawn pass hides the
failure that replaced it.

The extended sequence test finds the same gap by itself (`CASEBOOK_SEQUENCE_REOPENED=audit bun scripts/seq-one.mjs
31 loose`, and seeds 37, 41 and 88 under the other presets, `logs/extended-600x120.log`): at step 91 a run over
`random02` reads `passed` on a slot last rebuilt at revision 53 while the run is at revision 133; a person's failure
of that case, typed into another run on the same commit while this one was closed, was never admitted after the
sign-off was withdrawn. So the gap is not only corrections: nothing reported while a run is closed reaches it when it
reopens. A second way in: seed 41 (`logs/extended-final-400x120.log`, step 62, every preset) closes a run by rule at
sequence 38, a pipeline's pass of the slot's case arrives at sequence 63, and at sequence 91 a person changes the
sign-off answer from `approve` to `reject`; `settle` reverts the approval and `reopenRun` opens the run, again on
the slots as they were at 38.

Cause: `runs.applyBatchSteps` marks `slot_results.corrected` only for runs the batch counts toward
(`plannedIds`, open runs), so a closed run's rows are never marked; `reopenRun` puts the run back to `open` without
recomputing its slots from the results as they are now (the corrections and the reports that arrived while it was
closed). The same gap holds for a result judged `mistaken` while the run was closed (`discountFailures` skips closed
runs): reopened, the run shows the failure and a person is asked about it again. A reopen should refold every slot
from its lane history, exactly as `restoreFailures` and `refoldLaneOf` do, or the correction should mark the row in
closed runs too and leave only the projection untouched until the run reopens.

### H1-05: an agent's report moves a change's head and turns the change's gate from blocked to passed

Reproduction: `bun scripts/agent-moves-head.mjs`. The pipeline reports the head of `pr:7` (`c2c2…`, base `b1b1…`)
with one failure: `gate --change pr:7` is `blocked`. Trunk moves on to `t3t3…`, which passes. An agent with
`read, produce` sends one skipped result of an unrelated key with `target: { commit: "t3t3…", repo: "acme/web",
pr: 7, branch: "feature" }`.

Deciding output (`logs/agent-moves-head-1.log`):

```
change gate with the failing head  R-1 blocked  unexplained:1  open ["Q-1"]
changes [{"key":"pr:7","head_sha":"t3t3…","base_sha":"b1b1…"}]
change gate after the agent's report  R-2 passed  "passed: 2 results proven"
open failure questions [{"no":1,"state":"open","subject":{"signature":1,"scope":"change:1"}}]
```

`gate --change pr:7` reads trunk's run for `t3t3…` and says `passed`, while the failure of the commit the pull
request actually carries is still an open question. Nothing the agent reported was counted anywhere; what moved
the gate was `upsertChange` taking the agent's `target` at its word and advancing `head_sha` ("a report of the
same commit from somewhere else is that commit", departure 17, and the head moves forward on any report, departure
16). Departure 3 says what an agent reports never moves a commit's gate; the change's gate, which is the one the
web UI and `gate --change` show, is moved here by an agent's choice of `pr`, and to a commit the agent never tested.
The same call by a pipeline is the documented behaviour; by an agent (or by a person with `produce` only) it is a
way to make a blocked pull request read green without evidence.

Cause: `src/server/evidence/evidence.ts` `ensureTarget` → `upsertChange` runs for every producer kind. A change's
head should move only on evidence a gate counts (a pipeline's or a person's results file, `method = auto`), or an
agent's batch should be refused when its `pr`/`branch` would create or move a change.

## Observations, not counted as defects

- **A skip-only pipeline batch meets a `jobs` obligation** (second half of `scripts/agent-job.mjs`, `logs/agent-job-1.log`):
  the job "reported", two skips and nothing else, and the run passed on the person's pass alone. Departure 15 says
  a report of skips only proves nothing; here it completes an obligation. Worth deciding in the design.
- **An agent's report of a brand-new commit as a pull request's head** (`scripts/agent-new-head.mjs`,
  `logs/agent-new-head-1.log`) turns `gate --change pr:7` from `blocked` to `pending: nothing has been proven yet`:
  the change's head moved to a commit no gate has counted. Same cause as H1-05; a weaker effect (exit code 2 to 3).
- **Reopening and `mistaken`** (by reading, not reproduced): `discountFailures` skips closed runs the way
  `correctInSlot` does, so a run closed with a failure that is later judged a mistake shows it again when reopened,
  and a person is asked about it again. Same cause as H1-04.
- **A run planned with `{ self: true }` and a `jobs` obligation can never pass**: `targetsOfRun` returns no targets
  for a `self` run, so every named job stays missing. Probably a planning-time refusal is wanted.

## Lesser: confirmed, but a design call

### H1-06: a rule closes a run a person has just refused to sign off, on the next report

Reproduction: `bun scripts/reject-overridden.mjs`, under `loose` (the same under `standard`, whose
`signoff-passed-preview` is also a rule). Both cases of a run pass; the rule signs it off. Alice withdraws the
sign-off ("not yet") and answers the reopened question `reject` with the reason "coverage is thin"; the run stays
open and `passed`. Alice records one more passing result of C-1.

Deciding output (`logs/reject-overridden-1.log`):

```
run after the reject     [{"state":"open","signoff":null,"verdict":"passed"}]
run after one more pass  [{"state":"closed","signoff":6,"verdict":"passed"}]
signoff ledger  … {"id":4,"answer":"reject","signers":[{"by":3,"clause":"signoff-passed","reason":"coverage is thin"}]}
                … {"id":5,"answer":"outdated","signers":[{"by":1,"clause":"hold-ended"}]}
                … {"no":3, "id":6,"answer":"approve","signers":[{"by":1,"clause":"signoff-passed"}]}
```

The rule's clause says "a person with the right may still overrule it; nobody else may" (`core/kinds.ts`
`standingOf`), and `decisions.ts` `heldOpen` keeps a rule from answering again after a person withdrew its answer.
But a person's `reject` is held `basis-changes` on `{ tally, applied }`, so any report applied to the run, one that
changes nothing the person objected to, ends the rejection as `outdated` and the fresh question is settled by the
rule at once. In effect a person cannot keep a passing run open under a rule sign-off clause for longer than the next
keypress into it. Whether that is wanted is a design question (P4 says an answer carries until the evidence it stood
on changes, and the author may say an extra result is such a change); if it is not, a person's `reject` should hold
until a person approves, or `heldOpen` should cover a person's rejection as it covers a withdrawal.

## What was tried that held

- **The shipped sequence test**, `CASEBOOK_SEQUENCE_SEEDS=150` (150 seeds × 80 steps × 3 presets): passes
  (`logs/baseline-sequences-150.log`).
- **The raise limit under many runs** (`scripts/many-runs-raise.mjs`): 60 open planned runs over one commit, one
  failing report, then an `infra` answer for one environment and the same cause in a second environment. Both
  reports are applied (`batches … processed`), 61 runs blocked by one question, no limit hit.
- **Same report sent twice, corrections of corrections, accept-then-recover, a forgotten actor, policy switched
  mid-way, cases edited under pinned slots, findings interleaved, 300-result reports, `jobs` obligations,
  `minActors: 2`, runs closed by sign-off and reopened**: all exercised by `sequences-extended.test.ts` (see below).
  Its first fifteen audits (the eight shipped ones restated, plus sign-off standing, nothing outstanding, admission
  soundness, admission completeness, the `jobs` count, dependencies in force, no agent result in a commit's gate)
  found nothing beyond H1-04 in the runs listed below. Command outcomes per sequence are mostly accepted
  (`scripts/seq-histogram.mjs`: of 1,440 commands in 15 sequences, 14 refusals, all `plan` on a commit two
  repositories had reported, one report into a closed run).
- **`mistaken` across two open runs** (`scripts/reopen-mistaken.mjs`): a result judged a mistake is discounted in
  both runs that admitted it and both are recomputed (round 10's B03 holds).

## The extended sequence test

`hunt-r1/sequences-extended.test.ts` is ready to copy into `test/` (type-checks with `bunx tsc`, lint-clean with
`biome check`). It extends `test/sequences.test.ts` with the actions the brief lists and seven more audits, each
written against the rows. Two things to know:

- Audits 11 and 12 (admission soundness and completeness) skip runs whose sign-off approval is no longer in force
  (withdrawn, or replaced by a `reject`), because of H1-04; `CASEBOOK_SEQUENCE_REOPENED=audit` turns that skip off
  and the test then fails at seed 31 under `loose` (and 37, 41, 88, 147, 352, 387, 390 elsewhere). Remove the skip
  when H1-04 is fixed.
- The P5 order-dependence of H1-03 is not an audit: the engine's own facts say the producer's answer was legitimate
  when given, so no row-level check distinguishes it from a lawful excuse. It needs the fix first.

Runs: 10 seeds × 100 steps × 3 presets and 5 × 100 × 3 (histogram) clean; 300 × 100 × 3 found only a flaw in audit
12 (it counted results a producer had corrected; fixed, the four seeds it stopped on are clean); 600 × 120 × 3 with
the reopen action found H1-04 at nine seed/preset pairs (seeds 31, 37, 41, 88) and nothing else
(`logs/extended-600x120.log`); 400 × 120 × 3 with the guard for withdrawn sign-offs found H1-04 again through the
`reject` path at nine pairs (seeds 41, 147, 352, 387, 390) and nothing else (`logs/extended-final-400x120.log`);
with the guard widened to both paths those seeds are clean, and the closing run, 200 seeds × 120 steps × 3 presets,
passes with nothing found (`logs/extended-guarded-200x120.log`, 426 s).

## Not reached

- Everything ran in-process through `invoke`; nothing was repeated over HTTP or with reader threads. None of the
  findings depends on the transport.
- Reports above 300 results in a sequence (the brief says thousands); the slice boundary at 200 is crossed, the
  `LIMIT 200` in `failingOfCause` and the 50-test cut on a question's evidence were read but not driven past; by
  reading, they make the engine ask longer rather than say more.
- Policies with custom clauses (only the three presets were switched between).
- `same-claim` admission after an edit that keeps the claim: generated by the sequence (edits change steps, so the
  claim changes) but no case where the claim stayed the same.
- The suite side (conflicts, merges, folders, findings with `apply`) was exercised only as noise, not audited.
