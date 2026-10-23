# UI R9 fix verification

Revision: `778b56c5428ee603ad6277af6a248a027addaa75`, parent `5df174722dc991b0399ad26493f3a1a3b17e0b88`.

Review runs locally in the requested clean archive. The shared checkout is read-only. No other agents are started. The exported test support uses ports 8900–8949 in place of 7400–7449; TMPDIR is inside this review directory. Product code is unchanged except during the explicitly requested negative control.

Safety fact to prove: a submitted merge that the server combines with a newer field must not leave a stale draft that later replaces that field; genuine subsequent typing must survive.

Planned checks: inspect both finishConflict callers; run new test, revert condition and observe failure, restore; real-browser delayed-reply typing, external rejection, lost-reply retry and reload, side choice, same-field second conflict, later editor typing; run round8, round6, round7, conflict individually, TypeScript and Biome. Each result will be appended here.

Browser work uses the explicitly requested Playwright workflow and real local server.

## New regression and negative control

PASS. `bun test test/e2e/conflict-merge.test.ts` on the fixed export: `1 pass`, `0 fail`, five assertions. With only the changed condition reverted: `0 pass`, `1 fail`, at `conflict-merge.test.ts:71`, waiting for the draft count to become zero. The two assertions on version 4 content passed first. This is the expected leftover-draft failure, not the known route-interception race. Restored the exact fixed source from a saved copy. Logs: `logs/regression-fixed.log`, `logs/regression-old-condition.log`.

## Diff and callers

The changed predicate affects only a stored conflict whose body still matches the original local draft, whose merged body differs from the recorded head, and for which a sent body is available. When the stored merge equals sent, hand typing no longer makes it count as subsequent text. No-sent behavior is unchanged.

There are two callers. The successful `resolveConflict` path passes the merged body submitted by that invocation and `removeUnchanged=true`. `releaseSettledConflict` reads persisted `conflict.sentMerge` and passes it as sent, with `removeUnchanged` equal to full-body equality between the current head and sent (or state.merged if no sent). It runs for an externally settled question, retry after a lost reply, or restored card after reload. Rejection bypasses finishConflict and calls forgetRequest, retaining a typed merge. The recovery caller's full-body equality remains suspect when the server combined another field; browser probes below test it.

## Existing tests and static checks

PASS. Each browser file ran in its own process, one at a time, using `TMPDIR=$HOME/.cache/mainworthy-arena/verify/ui-r9-fix/tmp bun test test/e2e/<file>.test.ts`.

| File | Deciding lines |
| --- | --- |
| round8 | `18 pass`, `0 fail`, `67 expect() calls` |
| round6 | `14 pass`, `0 fail`, `59 expect() calls` |
| round7 | `12 pass`, `0 fail`, `59 expect() calls` |
| conflict | `1 pass`, `0 fail`, `7 expect() calls` |

Logs are `logs/round8.log`, `logs/round6.log`, `logs/round7.log`, and `logs/conflict.log`. No route-interception race occurred, so none required a rerun. These include rejected typed title and step, lost reply followed by additional card typing and reload, external merge settlement, and both draft-removal guards.

PASS. `bunx tsc --noEmit` exited 0 with no diagnostics (`logs/tsc.log`). `bunx biome check src/web test/e2e` exited 0: `Checked 64 files in 60ms. No fixes applied.` (`logs/biome.log`).

Probe `delay`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts delay`.

Probe `delay-plain`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts delay-plain`.

Probe `reject`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts reject`.

Probe `lost-retry`: ISSUE: Colleague step silently overwritten. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts lost-retry`.

Probe `lost-reload`: ISSUE: Colleague step silently overwritten. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts lost-reload`.

Probe `choice`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts choice`.

Probe `same-field`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts same-field`.

Probe `later-editor`: PASS. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts later-editor`.

## F1: Lost reply recovery rebases the original draft onto the merged head

BLOCKING. Confirmed on both a second Resolve conflict press and a reload after the reply is lost. The server records version 4 with the hand-typed merged title and the colleague's step. Recovery then retains the original pre-merge draft on base 4. Escape records version 5 with `Coupon case mine` and `Open the cart`, replacing both `Coupon case, merged by hand` and `Open the cart, changed by a colleague`. The status describes this original text as later text. No subsequent typing occurred.

Smallest reproduction is the reported route, except let the merge request reach the server and drop its reply. Press Resolve conflict again, or reload, then Escape. The browser probes intercept only `/decide`, call `route.fetch()` to perform the real write, then abort the reply. All route installs have the requested page-evaluation barrier.

Deciding request, on both routes: `propose base:4`, title `Coupon case mine`, first step `Open the cart`; server reply `status:adopted`, `version:5`. Raw structured observations are in `logs/probes.jsonl` under `lost-retry` and `lost-reload`.

Cause: the recovery caller at `src/web/suite/index.tsx:472` passes `removeUnchanged=false` because the merged head includes the newer step and differs from sentMerge. The new condition correctly says the stored merge is not later text, but `remove` is false too. The fallback at line 437 keeps `stored.body` and moves its base to the current head at line 438. This is the original draft, not the sent merge or later typing. The successful-reply caller passes true and avoids it. Repetition and old-condition comparison follow below.

Probe `lost-retry`: ISSUE: Colleague step silently overwritten. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts lost-retry`.

Probe `lost-reload`: ISSUE: Colleague step silently overwritten. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts lost-reload`.

## Real-page checks adjacent to the change

Command: `TMPDIR=$HOME/.cache/mainworthy-arena/verify/ui-r9-fix/tmp bun ../probe.ts delay delay-plain reject lost-retry lost-reload choice same-field later-editor`. The script and all output are retained under this review directory. Each scenario starts an isolated real server and Chromium context, then closes both. Logs: `logs/probe-run.log`, `logs/probes.jsonl`.

| Requested check | Verdict and deciding observations |
| --- | --- |
| c1, typing while reply is held 1.5 seconds | PASS. Tested both with and without the colleague's second edit. Browser keys into Merged title are refused; the value stays `Coupon case, merged by hand`, and the visible message is `Wait for the merge reply before editing the card. Your merge is kept.` No draft remains after the reply. The second-edit route ends at version 4 with the colleague's step. |
| c2, another person rejects the question | PASS. Typed title remains in the editor and storage after rejection and reload. The round8 tests independently cover both title and step through eventual recording. |
| c3, lost reply then retry or reload | ISSUES, F1 above. Both overwrite the colleague's step and replace the recorded hand-typed merged title with the original title on the next seal. Each repeated twice on the fixed condition; the reload repeat explicitly waits for the Conflict resolved status before inspecting and leaving. |
| c4, Use my title | PASS. Version 4 contains the selected title and newer colleague step; no draft remains, Escape sends no proposal. |
| c4, colleague changes the same field again | PASS. Head remains version 3, title `Coupon case theirs AGAIN`. One replacement card and a different open adopt question remain; nothing records over the new change. |
| c5, real later editor typing | PASS. After a clean merge to version 4, Step 2 is edited to `Apply the coupon SAVE10 AND LATER`. The browser sends a proposal on base 4 containing that text and `Open the cart, changed by a colleague`. Version 5 holds both. |

The normal acknowledged-response route fixes R9-1. The safety fact remains false for lost replies because of F1.

Probe `lost-retry`: ISSUE: Colleague step silently overwritten. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts lost-retry`.

Probe `lost-reload`: ISSUE: Colleague step silently overwritten. Evidence: `logs/probes.jsonl`, command `bun ../probe.ts lost-reload`.

## Repetition and attribution

The fixed condition reproduced F1 twice for retry and twice for reload. On the second reload run the probe waited for `Conflict resolved.` before leaving, eliminating an early page-mount observation as an explanation. Screenshots show the recovered draft in `logs/lost-retry-fixed.png` and `logs/lost-reload-fixed.png`.

I then reverted only the condition again and ran `REVIEW_VARIANT=old-condition bun ../probe.ts lost-retry lost-reload`. Both routes still reverted the colleague's step, but kept the hand-typed merged title in version 5. With the fix they instead revert that title to `Coupon case mine`. Thus the step overwrite is an incompletely fixed R9-1 path, and the merged-title replacement is a regression introduced by this predicate through its fallback. They share one cause and count as one blocker. Logs: `logs/probe-repeat.log`, `logs/probe-old-condition.log`, and the variant-tagged rows in `logs/probes.jsonl`.

The original fixed source was restored. A final `bun test test/e2e/conflict-merge.test.ts` passed: `1 pass`, `0 fail`, `5 expect() calls`, in `logs/regression-restored.log`. A byte comparison of every tracked exported file against commit 778b56c found only the documented port substitution in `test/e2e/support.ts`. All product code is exactly the judged revision.

The fix needs to account for the recovery caller as well as the acknowledged-reply caller. It must discard an unchanged submitted draft after a confirmed successful merge even when another field makes the current head differ from the sent body, while preserving genuinely later text. Add both lost-reply routes to the regression coverage. No product fix was attempted in this review.

## Limits and completion

No full test suite, budgets, other browsers, production, or unrelated workflows were checked, as requested. The custom probes used Chromium and real local requests. I did not wait 30 idle seconds in the new probes; I exercised Escape and directly observed the offending base-4 proposal and version-5 server state. Existing round6, round7, and round8 tests cover additional lost-reply and external-settlement cases without the newer colleague field.

The reviewer was Codex, gpt-6-astra. This is a direct review of the specified revision, not an endorsement based on another reviewer's output. No agents were started, no repository files changed, no commit or PR was created, and no shared-checkout cleanup ran. Each probe and test closed its own browser and server. All report, probe, log, and screenshot files are under this review directory.

ISSUES (1 blockers)
