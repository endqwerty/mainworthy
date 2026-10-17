# 0094. A window is live while it is open, not while it answers quickly

Date: 2026-10-17. Issue #406. Builds on the eighth review's first finding (R8-1: one live window owns a case's draft).

## Problem

A draft belongs to one window. A window that starts and finds a draft of another window takes it over when that
window is gone, and shows it read-only when that window is live. It knew which by asking: it said hello on a
`BroadcastChannel` and counted as live every window that answered within 40 ms.

A window busy for longer than 40 ms looked gone. A large render or a loaded machine is enough: in the browser tests
beside eight workers a new window took over the draft the other was typing in, and that window's next key was
refused as "being edited in another window" (`test/e2e/draft-conflicts.test.ts`, R4A-5). Blocking the first
window's main thread for three seconds while the second starts made it happen every time. The person at the first
window loses the draft they are typing for having a slow machine.

## Decision

Liveness is a fact the browser keeps, not an answer the window has to give in time. Each window holds a
[Web Lock](https://developer.mozilla.org/docs/Web/API/Web_Locks_API) named for its owner id for as long as its
document lives; the browser releases it when the window closes, goes elsewhere or crashes. A window that starts
asks which locks are held, and those owners are live, however busy they are (`src/web/lib/ids.ts`).

The channel stays for what a lock cannot do: a window that closes says so at once, so the others stop showing it
as live, and a window that finds its own id held by another (a duplicated tab) takes a new one. Web Locks are for
secure contexts; a page served over plain HTTP from another host has the channel alone, as before.

## Consequences

- A window that is open keeps its draft. "This draft is held by a window that is not answering, or has closed" is
  shown only for a window whose lock is gone and whose leaving was not heard: one that crashed, or that closed
  before this window opened and left a conflict card behind (`test/e2e/round7.test.ts`, R7-1).
- A window that crashes still holds nothing: its lock goes with its document, and the next window takes the draft
  over as before.
- A page holding a lock is not kept in the back/forward cache. The app already reads its state again on `pageshow`.
- `test/e2e/draft-ownership.test.ts`, "a window that answers late keeps its draft", now expects the window to be
  called live: a late answer no longer means anything.
