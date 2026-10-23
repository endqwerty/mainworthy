# Escape "sends no proposal": the page sends it, the test's route does not see it

Investigated 2026-10-12 on commit `5cc2b3a`, in the scratch worktree
`$HOME/.cache/mainworthy-arena/ci-repro`. Bun 1.4.3, playwright-core 1.64.0,
Google Chrome 155.0.8059.39 and Chromium 152.0.7977.82, Linux, 16 cores.

## Verdict

- **Test defect, not a product defect.** In every captured miss the page handled Escape, sent its
  proposal 2 to 18 ms later, got `conflict` back and drew the conflict card. The request never reached
  the test's `page.route("**/propose")` handler, so the helper's `replied` flag stayed false and
  `eventually` gave up after 10 s.
- **A person using the product cannot hit it.** Nothing was lost or delayed in the page. The idle seal
  is not involved: no trace shows `sealDraft` returning early.
- **Cause.** `await page.route()` returns when Chrome has acknowledged `Fetch.enable`. A page that is
  already open starts sending its requests through the interceptor a moment later, and it handles a
  key press before it makes that switch. The helper presses Escape as the very next action, so under
  load the proposal goes out through the old path: Chrome never pauses it and Playwright never reports
  it.
- **Fix.** Wait until a request from the page is seen to be intercepted before pressing the key
  (`interceptionLive(page)` in `test/e2e/support.ts`). Patch: `fix.patch`. Before: 13 of 18 runs failed
  under the load recipe below. After: see "The fix".
- The same pattern (install a route, then act at once) appears at about 36 of the suite's 54 route
  installs. One of them, `recovery.test.ts:357`, failed the same way in my loaded runs.

## The trace

Three views of the same event. All files are under `traces/`.

**1. The page's own account** (12 misses, `traces/mainworthy-race-*.json`; the product was instrumented
with trace points in `sealDraft`, `change`, `leaveEditor`, the editor's `keys` and the global key
handler; times are ms since page load). One of them:

```
1747 editor.keys key=Escape field=s2:action readOnly=false repeat=false composing=false propDraft: dirty=true title=My title
1747 leaveEditor active=TEXTAREA
1748 sealDraft enter saved=false snapshot=C-1 dirty=true base=1 title=My title sub=none sent=false session=true pending=
1749 sealDraft calling propose base=1
1765 global.keydown key=Escape prevented=true repeat=false target=TEXTAREA
1830 sealDraft propose replied conflict
```

After the 10 s wait failed the page showed one conflict card, a read-only editor and the status "Both
edits are kept. Choose each field to resolve the conflict." All twelve traces have this shape:

| | range over 12 misses |
|---|---|
| Escape handled → `call("propose")` | 2 to 18 ms |
| proposal → reply (`conflict`) | 30 to 183 ms |
| conflict cards on screen afterwards | 1 in all 12 |
| Playwright `request` event for the proposal | none in all 12 |
| route handler entered | never in all 12 |

**2. The test's account** (same files, `trace`): Playwright reported the page's later `find`, `inbox`,
`timeline` and `get` requests, and no `propose`.

**3. The browser's account** (`traces/protocol-miss-and-pass.txt`, from a run with
`DEBUG=pw:protocol`). The miss:

```
21:07:53.303 SEND id=65 Network.setCacheDisabled
21:07:53.303 SEND id=66 Fetch.enable
21:07:53.305 RECV id=65 {}                      (from the raw log)
21:07:53.308 RECV id=66 {}                      (from the raw log)
21:07:53.309 SEND id=67 Input.dispatchKeyEvent  key=Escape rawKeyDown
21:07:53.377 RECV Network.requestWillBeSent     .../api/p/scratch/propose  req=1713918.23
21:07:53.398 RECV Fetch.requestPaused           .../api/p/scratch/find     interception-job-1.0  net=1713918.24
21:07:53.412 RECV Network.responseReceived      .../api/p/scratch/propose  req=1713918.23
```

Chrome acknowledged `Fetch.enable` before the key was sent, yet never paused the proposal: the first
request it paused (`interception-job-1.0`) is the one after it. In the passing test just before, the
proposal is `interception-job-1.0`. Playwright holds a `requestWillBeSent` until its `requestPaused`
arrives (`_onRequestWillBeSent` in `coreBundle.js`), which is why there is no `request` event either.

## Why the browser does this, and the forced order

Two scratch tests with no Mainworthy code in the page's path (`work/scratch-tests/`):

- `zz-cdp-forced.test.ts` keeps the page's main thread busy for 300 ms, sends `Fetch.enable` meanwhile
  (acknowledged in 1 to 5 ms, while the page is still busy), then presses a key whose handler sends a
  request. When the busy period ends the page has both the switch and the key waiting. **The key's
  request was not paused in 10 of 10 rounds.** With one round trip to the page before the key
  (`page.evaluate(() => undefined)`) or with the fix's helper: 0 of 10.
- `zz-route-window.test.ts` has the page send a request every millisecond from ordinary tasks while a
  route is installed. In 52 installs under load, no request started after `page.route()` returned went
  unseen. So ordinary page work queues behind the switch; a key press jumps ahead of it.

This also explains what was seen before:

- It needs load. On a quiet machine the switch lands within a millisecond or two and the key arrives
  later. Under load the page is still busy re-reading after the other producer's change event.
- The instrumented helper never failed. Its added `exposeFunction` and `evaluate` calls between
  `page.route()` and Escape are exactly the round trip that closes the window: 0 failed runs of 17
  under load, against 13 of 18 once I removed them.
- Throttling the page's CPU, pinning it to a core and pausing before Escape could not reproduce it.
  The pause sat before the route was installed, and throttling slows the key as much as the switch.

I did not read Chromium's source. That the key is handled ahead of the switch is shown by the forced
test; which queues are involved inside Chromium is my inference.

## Reproduction

Forced order, deterministic, about 7 s (fails 10 of 10 without a barrier):

```
cd $HOME/.cache/mainworthy-arena/ci-repro
# zz-cdp-forced.test.ts is already in test/e2e/ (copy: race/work/scratch-tests/); it imports the helper from
# the patched support.ts, which the scratch worktree has
bun test test/e2e/zz-cdp-forced.test.ts                      # barrier none: 10 of 10 not intercepted
BARRIER=evaluate bun test test/e2e/zz-cdp-forced.test.ts     # 0 of 10
BARRIER=helper   bun test test/e2e/zz-cdp-forced.test.ts     # 0 of 10
```

The real tests, on `5cc2b3a` without the fix, fail most runs under this load (`work/recipe.sh`: three
loops of `round7.test.ts` + `conflict.test.ts` in Google Chrome and one loop of three other browser
test files, each beside three busy loops):

```
$HOME/.cache/mainworthy-arena/verify/race/work/recipe.sh <tag> 6
```

Result on the unfixed helper: **13 of 18 runs failed** (4/6, 4/6, 5/6), 16 failing tests, every one at
`conflict()` → `eventually(async () => replied, Boolean)`, a different test each time. `conflict.test.ts`
never failed. CPU load alone (24 busy loops, no other browser tests) with the instrumented helper: 0 of 8.

I could not force the order through `page.route()` itself. It sends `Network.setCacheDisabled` together
with `Fetch.enable` and waits for both, and the page answers the first only when it is free, so a busy
page delays `page.route()` rather than opening the window. The forced test therefore sends
`Fetch.enable` over its own protocol session.

## The fix

`fix.patch` (against `5cc2b3a`, test files only, 4 files):

- `test/e2e/support.ts`: `interceptionLive(page)`. It installs a route for a probe URL
  (`/healthz?interception=<uuid>`), has the page fetch it until the reply is the route's and not the
  server's, and removes the probe route. It observes the switch instead of assuming an order. An
  unintercepted probe gets the server's ordinary 200, so it adds no console error.
- `test/e2e/round7.test.ts`: `conflict()` calls it between `page.route("**/propose", …)` and Escape.
- `test/e2e/recovery.test.ts`: the same before Enter at line 360 (failed once in my loaded runs:
  `waitForFunction` timed out waiting for "Answer unavailable").
- `test/e2e/interception.test.ts`: the forced-order test using the helper. With the helper call
  removed it fails in both browsers (`Expected length: 1, Received length: 0`); with it, it passes.

Nothing in `src/` changes. `bun x tsc --noEmit` and `biome check` are clean on the changed files.

Validation under the same load recipe (`work/recipe.sh fixed 6`, logs in `work/fixed-*`): **0 of 18
runs failed** for `round7.test.ts` + `conflict.test.ts` (13 tests passing in each), and 0 of 6 for the
loop that contains `recovery.test.ts`. Before the fix the same recipe failed 13 of 18.

What I turned down:

- Moving the route to the top of `conflict()`. It works by putting several round trips between the
  route and the key, but leaves the reason invisible and the other sites unfixed.
- Installing a route in `openPage` so interception is on from the first navigation. It removes the
  race for every test in one line, but every request of every test then pauses in the test process
  and the cache is disabled throughout, which touches the latency budgets.

Still open: the other route installs that are followed at once by the action
(`work/route-sites.txt`, 36 of 54 by a line-based scan, including the two fixed here). Each can miss
the same way under load. They should get the same call, or `route` + `interceptionLive` should become
one helper. I did not change them: another agent is editing those files.

## CI: `conflict.test.ts` at 12 s before the round-7 change, and the 30 s time-out

This cause does not explain either. `conflict.test.ts` installs no route.

- It is the first browser test of the CI job in both runs. In the passing run it took 12.2 s and the
  next browser test 2.0 s. In the failed run the first three browser tests took over 30 s (time-out),
  29.4 s and 6.7 s, then 2.4 s: the runner was slow at the start of the browser tests and recovered.
- The 29.4 s pass was not rescued by the idle seal. The helper waits 10 s for the proposal, so a pass
  means the route saw it within 10 s of Escape; the time went elsewhere in the test.
- The fourth failure signature in that run, "R7-1 storage freezes…" at 12.0 s in `conflict()` line 62,
  is this race: about 2 s of set-up and the 10 s wait.
- In my 18 unfixed runs under heavy load `conflict.test.ts` passed every time.

Where the first browser test spends its 12 to 30 s on the runner is not established. The log has no
finer timing, and "killed 2 dangling processes" only says the server and the browser were both up
when the test timed out.

## What I ran

| what | result |
|---|---|
| instrumented helper (extra round trips), 24 busy loops, Chrome, 8 runs | 0 failed |
| instrumented helper, 4 parallel test loops, 9 runs of the two files | 0 failed |
| original helper timing + in-page trace points, same 4 loops, 18 runs | 13 failed, 12 traces captured |
| the same with `DEBUG=pw:protocol`, 1 run | failed, browser-side trace captured |
| `zz-route-window`: ordinary requests after `page.route()`, 52 installs under load | 0 unseen |
| `zz-key-probe`: key right after `page.route()`, no Mainworthy code, under heavy load, 3 × 12 | 1, 2, 1 unseen |
| `zz-key-probe`, 3 × 60 under lighter load (no barrier, evaluate, probe) | 0, 0, 0: too little load to tell the barriers apart |
| `zz-cdp-forced`: forced order, 10 rounds each | none 10/10 unseen, evaluate 0/10, helper 0/10 |
| `interception.test.ts` without / with the helper call, Chromium and Chrome | fails / passes |

## Not established

- Chromium's internals (see above).
- Where the CI runner's slow first browser tests spend their time.
- Whether CPU load alone reproduces the original helper's miss: I only ran CPU-only load against the
  instrumented helper.
- The patch was not run through the full `bun run check`.

## State left behind

- Scratch worktree: product instrumentation reverted (saved as `work/instrumentation.patch`), the fix
  applied, scratch tests `test/e2e/zz-*.test.ts` left in place. Nothing committed.
- `work/`: loop scripts, per-run logs, `route-sites.txt`, scratch tests. The raw protocol log (24 MB,
  with session cookies) is deleted; `traces/protocol-miss-raw-excerpt.txt` keeps the miss with cookie
  values redacted.
- No process of mine is left running. I removed one temp directory my interrupted run left
  (`/tmp/mainworthy-e2e-1764284-4HG6ma`) and touched no other.
