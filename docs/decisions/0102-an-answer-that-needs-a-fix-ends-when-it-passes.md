# 0102: An answer that needs a fix ends when its cause passes

- Date: 2026-10-16
- Status: accepted (the owner asked for the flow in the thread that built it, 2026-10-16)

## Problem

The owner asked what happens when a test fails on a pull request, is answered, and then passes after a fix: "I
don't want to need to continually manually update the resolution."

A failure question that nobody answered already closes by itself. `dissolveStale` closes it as `dissolved` once
the newest commit of its scope passes one of its tests. An answered question did not. "Defect in the product",
"The test is wrong" and "Expected: behaviour changed" hold on the cause in its scope, a signature and a scope
with no build in it. A pass changes neither, so the answer stood after the fix. When the cause failed again, the
old answer explained the new failure: the gate read `failed` and nobody was asked about the regression. The guide
told people to withdraw the answer themselves when it no longer applied.

## Decision

**The three answers that say the target needs a fix end when the cause passes.** These are the `attributed`
answers, listed once as `ATTRIBUTED` in `src/core/kinds.ts`. Each one's own help text already says when it is
done: "until a build passes", "until the test is fixed". Until the cause passes, the answer carries to later
commits, so nobody is asked again on every commit of a fix in progress. When it passes, the rule ends the answer,
and a later failure of the cause is a new question.

**Passing means more than it does for an open question.** `endPassed` runs beside `dissolveStale` for the newest
commit of a scope, after a report, and the answer ends only when that commit's run shows all of these:

- No test fails with the cause, whether an answer explains it or not. `stoppedFailing` counts an explained row as
  gone, which would end an answer on the failure it explains.
- Every test the question lists passes, in each environment where a pipeline or a person has seen it fail with
  the cause in the scope. A shard that has not reported one of those tests yet ends nothing. A test the fix renamed
  or removed never passes, so its answer stays. Where it failed is read from the results as reported, which a
  passing retry does not change, with no point in time to start from. The job and the reporter are left out: a
  sharded pipeline moves a test between jobs when it balances them again, and a pipeline's token can be replaced.

  The first six versions tried to know where this question's own failures were: from the runs resting on the
  answer, then from the results after the question's sample, after the earliest failure on its targets, after the
  last occurrence of the question before it, and from pairs the question recorded as it was raised. The verifier
  found each one wrong, every time by a way of raising a question that the bound or the record did not see: a
  retry erases what a run counts, a sample is replaced, a retry reuses its commit's target, a change opened again
  asks about earlier failures, a planned run gathers several environments, and a commit that moves into a pull
  request brings a sample. Every failure of the cause in the scope is the one set no way of raising a question can
  leave short. What it costs: an environment where the cause failed once and that no longer reports keeps the
  answer, as before this change, until a person withdraws it.
- The question lists every test it has seen. It lists fifty; with more, the rest are unknown.
- No open planned run names the question. A person asked for that run, and it waits for its own evidence.

Within what the newest commit has reported, each condition errs towards keeping the answer. A job that has not
reported yet is the exception, as the guide says, until Mainworthy knows a commit's shards. When the answer is kept, today's behaviour holds and a person can
still withdraw it. An answer that ends too early costs a person one question, never a gate passing on a failure.

**The ending is the one the ledger has.** `endHold`, which already ends a flaky answer when its time runs out and
a defect answer when its tracker issue closes (decision 0084), writes the ending row. That row is `outdated`,
signed by the rule with the clause `passed`, with a reason naming the commit. The excuse is removed, the
question reopens, and `closeIfGone` closes it as `dissolved` because the failure has gone. Like the other two
endings, the answer stops explaining the commits it covered: an earlier commit that read `failed` now reads
`blocked`, and nobody is asked about it, because it does not speak for its scope.

**What does not end on a pass.** "Flaky": a flaky test passes some of the time, so a pass proves nothing.
"Infrastructure" and "Already failing on base" cover one build already. A slot's settlement and "The failure was
a mistake" are about results already recorded. There is no policy setting.

## Turned down

- **Keeping the answer on the commits it covered.** The ending would keep the excuse on the targets that rested on
  the answer, so an earlier commit keeps reading `failed`. That is what decision 0022 chose for an ended pull
  request. It was built and then dropped. After the ending, undo has no decision to withdraw, so an answer found
  wrong later would explain those commits for good. The random sequences of `test/sequences.ts` failed with it
  under `loose` and `strict`, and pass without it. Reading `blocked` instead of `failed` changes no decision: both fail the gate, and a pull
  request's gate is its newest commit's.
- **Failure episodes** (from an independent design by GPT 6.1 Sol): tables that keep each answer on its own
  commits, so an earlier commit keeps its explanation. That is the first item above, at the cost of an episode
  lookup on every excuse read.
- **Waiting for the whole commit here.** The same design had the answer end only once CI said every job of the
  commit had reported. Mainworthy has no word for that yet, and the gate has the same gap: a sharded pipeline whose
  first shard reports only passes reads `passed` before the other shards report. The owner asked for sharded CI to
  be supported (2026-10-16), so the signal is its own change (decision 0092), which the gate and this ending both use. Until then,
  the requirement that every listed test pass covers the failures already seen, and a test failing with the cause
  for the first time in a shard that reports late is asked about as a new question.
- **A hold term checked when the cause comes back.** `stillHolds` would ask whether the cause passed since the
  answer. It needs no sweep, but the answer would keep reading as current after the fix until the cause failed
  again, which is the stale state the owner asked to be rid of. And `stillHolds` reads no database.
- **A policy setting** for whether these answers end. Every preset would choose to end them, and nobody asked for
  a defect answer that outlives a pass.

## Not done

- Settled lists decided questions only, so an answer that ended leaves it, as one that expired or whose tracker
  issue closed does today. The ledger and the audit export keep the answer and its ending.
- Answers given before this change end the same way, at the next passing report in their scope.
