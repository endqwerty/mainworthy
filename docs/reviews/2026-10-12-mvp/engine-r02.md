# Mainworthy engine verification, round 2

Revision: `3d7d8605c150668bb4491b63e551790bbfe3eb08` on `t3/mvp-product-delivery`.

Review in progress. This report judges the isolated Git export under `engine-r2/tree`; the shared repository is untouched. Verifier: OpenAI Codex, GPT-6 Astra. No delegated reviewers.

The safety fact is that a green gate follows only from evidence admitted for its target, pinned case version, method and policy, and that every change to standing follows a valid recorded decision. It remains unproven until the checks below finish.

## Confirmed findings

### R2-B01. Witness construction remains public at runtime, so standing can cite an unrelated decision

Blocks: yes. Round-1 B15 is not fully fixed.

`src/server/kernel/witness.ts:22` makes the constructor private only to TypeScript. `Reflect.construct(Witness, [existingDecision, "failure", [actorId], null])` creates the real private field without claiming the mint. `decisionOf()` accepts it. A foreign key proves only that the decision ID exists, not that it authorized this link or excuse.

Smallest reproduction: from this directory run `bun scripts/witness-constructor.mjs`. This invokes the actual standing writers after normal operation-layer setup. It is an internal authority-boundary probe, not remote code execution.

Twice observed in `logs/witness-constructor.log`: `constructedOutsideDecisions:true`, `decisionRowsBefore:2`, `decisionRowsAfter:2`. The reused decision is `kind:"adopt", answer:{is:"accept"}`; a new `excuses` row and `tests.linked_by` both cite its ID. This contradicts P0, departure 0012's runtime guarantee, and the requirement that only the decision machinery can mint authority. The new plain-object and second-claim tests do not cover construction of a real instance outside that machinery.

### R2-B02. An agent's keyed pass can satisfy the default commit gate and erase a pipeline's failure

Blocks: yes. The label fix in B02 works, but the change-run fold ignores that label. `applyBatchSteps` writes every method into `run_tests`, whose key is only run/test. There is no agent opt-in or producer separation there.

Run `bun scripts/new-probes.mjs agent-change-gate`. A lone agent report on `agent001` produces `passed`, with no case or obligation admitting agents. On `agent002`, a CI failure produces `blocked`; another actor of kind agent sends a pass for the same key and attempt, and the gate becomes `passed`. The failing CI result remains in `results`. Deciding evidence is in `logs/agent-change-gate-confirmed.log`, repeated from `logs/new-probes.log`.

This violates decision 0009's agent gate rule and P3's requirement to preserve contradictory producers. Giving an agent the correct method name does not enforce that rule in change gates.

### R2-B03. A slot with two distinct failure causes passes after only one is excused

Blocks: yes. B06's original fail-plus-pass and attempt probes are fixed, but `aggregateSlot` retains only one failure result per producer; `refreshSlot` and `retally` then classify the slot by one signature. Other admitted failure causes disappear from the planned gate.

Run `bun scripts/new-probes.mjs two-failures-one-slot`. One producer reports two failing keyed tests, `alpha` and `beta`, both exact at C-1@1 but with distinct failure signatures. Excuse only the signature stored on the slot. Observed `blocked` becomes `passed` with `excused:1`, although both failing slot results remain `corrected:0` and the commit gate remains blocked by the second cause. See `logs/two-failures-confirmed.log`.

This violates P3 and the documented promise that a slot folds all effective evidence. A single representative cause cannot establish that all its failures have valid excuses.

### R2-B04. A later skip hides an uncorrected failure in a planned run

Blocks: yes. The skip guard added for B04 applies only to `run_tests`. `aggregateSlot` chooses the latest result even when it is skip/blocked, discarding that producer's previous failure.

Run `bun scripts/new-probes.mjs planned-skip-erases-failure`. In a two-case run, one person fails C-1 and passes C-2; another person passes C-1, leaving a dispute. The first person then reports only a skip on C-1. Observed gate `blocked` becomes `passed`, `disputed:1` becomes `0`, and the original failure still has `corrected:0`. No fresh passing evidence or resolving decision was supplied. See `logs/planned-skip-confirmed.log`.

This violates P3, check 7 and departure 15's statement that a skip never replaces a pass or failure.

### R2-B05. Repository-qualified changes still read another repository's gate

Blocks: yes. B12 now stores two change rows, but downstream commit lookup still ignores the repository. `gate --change`, impact, and planning can select the first matching commit across repositories.

Run `bun scripts/new-probes.mjs repo-pinned-prior-and-excuse`. Report repository a's PR 12 passing and repository b's PR 12 failing at the same commit string. Such equal SHAs are normal in forks. Both `gate(change:"pr:12")` and `gate(change:"b#pr:12")` return a's passed R-1; b's impact also reports that passed gate. A new planned run explicitly accepting `{repo:"b",commit:"samecommit"}` stores `accepts_what:"code:a@samecommit"` and misses b's existing evidence. See `logs/repo-confirmed.log`.

This violates P3 and departure 17. Repository qualification must survive through the lookup, not only the change's display key.

### R2-B06. Automated keys can take over a manual case's identity

Blocks: yes. Both variants share the `(project,key)` namespace, and `resolveTest` reuses the found row without checking its kind. The key `case:1` is accepted for an automated test even though manual C-1 uses exactly that key.

Run `bun scripts/new-probes.mjs manual-key-identity-collision`. Create C-1, upload a keyed result with key `case:1`, then record a manual C-1 pass into a pinned run. The report accepts it but stores `basis:"unresolved",basis_case:null`; the slot stays missing. The test row is still `kind:"auto",case_id:null`. See `logs/manual-key-confirmed.log`.

A stronger variant, `bun scripts/new-probes.mjs manual-key-linked-to-wrong-case`, maps that automated T-1 to C-2 first. A subsequent manual report naming C-1 is accepted as **exact C-2@1** and satisfies C-2, leaving C-1 missing. This was reproduced twice in `logs/manual-key-wrong-case.log`.

This contradicts the new P0 exception that a manual test is its case by definition. A prior arbitrary keyed upload must not change the meaning of `{test:{case:"C-1"}}` or prevent ordinary manual recording.

### R2-B07. A passing subset run dissolves an unrelated live failure question

Blocks: yes. `decisions/decisions.ts:dissolveStale` lets any planned run speak for the whole target scope. A subset of cases can therefore decide that a cause still failing elsewhere has disappeared.

Run `bun scripts/new-probes.mjs planned-run-dissolves-other-failure`. Plan only C-1 at a commit, then upload a passing C-1 result and failing C-2 result. The receipt raises open Q-2 and the commit gate says `blocked` with `open:["Q-2"]`. Yet the inbox is empty and the stored Q-2 is already `dissolved`; the subset run passed and removed it. Reproduced twice in `logs/subset-question.log`.

This violates P3/P4 and the one decision queue promise: a narrower run cannot erase an unanswered cause belonging to the full commit, or leave the gate citing an already-dissolved question.

### R2-B08. A target-only excuse covers failures in another environment of the same commit

Blocks: yes. B08's different-commit reproduction is fixed, but `retally` checks only whether the run contains the excuse's target. A change run contains all environments; its failure groups no longer carry a target when classified.

Run `bun scripts/new-probes.mjs infra-multiple-environments`. Report the same cause in staging and production at `envsame1`, using distinct test keys. Decide infra on production. The excuse records `target:2`, but the shared gate passes with `excused:2` even though one counted failure is on target 1. Reproduced twice in `logs/infra-environments.log`.

This violates P3 and departure 8's promise that an excuse for one target excuses that target only. Test the result's target, not merely membership of the target in a run.

### R2-B09. Search limits global matches before applying the requested folder

Blocks: yes. The new search path in `suite/read.ts:listCases` takes a bounded set of global full-text hits, then applies folder/tag/state filters. Valid matches outside that intermediate cut vanish, and the response may claim there are zero results.

Run `bun scripts/new-probes.mjs filtered-search-loses-match`. Create 300 cases titled Needle in Elsewhere and one titled Needle in Wanted. `find({folder:"Wanted"})` lists C-301, and `get(C-301)` confirms the title. `find({folder:"Wanted",text:"Needle",limit:1})` returns `count:0,items:[],cursor:null`. Reproduced twice in `logs/filtered-search.log`.

This breaks scoped search and the basic bounded-query contract. The query must filter before limiting; a performance optimization must not manufacture an empty result set. No timing claim is involved in this finding.

### R2-N01. An unambiguous commit prefix becomes unknown when two environments reported it

Blocks: no. `targetByCommit` counts matching target rows, rather than distinct commits. Run `bun scripts/new-probes.mjs commit-prefix-environments`. With only commit `abcdef0123456789` reported in staging and production, the full hash returns `passed`, but `abcdef0` returns `pending: nothing has been reported`. Reproduced twice in `logs/commit-prefix.log`. Full-hash lookup works; deduplicate by commit/repository before deciding a prefix is ambiguous.

### R2-N02. Capability authorization happens in the reader, after dispatch

Blocks: no on the observed HTTP behavior. The brief requires authorization before worker dispatch. `invokeAsync` resolves the actor in the parent, but does not check `op.needs` there; the worker's `invoke` makes that check. `bun scripts/readers-live.mjs` records `workerSawDeniedRequest:true` for a produce-only token's `find`. The request still returns 403, and forged actor/capability fields in the HTTP payload do not change it. This is a mismatch with the specified placement of the authorization boundary, not a demonstrated HTTP privilege escalation.

## Check results

Pending. Round-1 reproductions, all twelve checks, architecture mutation controls and reader-thread checks are required. The eight known JUnit parser failures are outside this review.

ISSUES (9 blockers)
