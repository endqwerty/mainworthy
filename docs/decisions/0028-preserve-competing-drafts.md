# 0028: Preserve competing drafts separately

Date: 2026-10-14. Status: accepted.

## Problem

Two clean windows can both read an empty draft slot before either writes it. The last write owns the draft.
Following that owner used to replace the losing window's accepted text without retaining it (issue #196).
Waiting for the storage event before preserving the text also loses it if the window closes first.

## Decision

Keep a separate copy only while a window's ownership is uncertain. Its key uses the person's device prefix,
then the project, case, window and claim attempt. Clearing that person's device keys also removes the copies.
The draft's existing schema validates the contents. Each accepted input remains synchronous.

Before the guarded shared write, store the copy as `writing`. After that write returns, mark it `waiting`.
On the next timer turn, read the copies and then the shared draft. If this window still owns the draft and
no copy says a competing write is in progress, remove its copy and remember the confirmed ownership in memory.
Confirmation and tab-only copies belong to the device session, so signing in again cannot reuse them.
Later input uses the original shared-draft write without extra storage reads or writes. A competing window
paused between its ownership read and write has already published its `writing` copy, so confirmation waits
for a copy storage event. It does not delete the backup while that competing write can still win.

Only text that differs after losing ownership becomes a `lost` copy and appears as **Preserved text**.
A deliberate takeover or an ordinary handoff carries the stored text forward and removes matching copies.
A later attempt in the same window uses a new key, so it cannot overwrite earlier lost text. A copy that
matches a later recorded version is also removed, including its typed merge when it has one. Other lost
copies remain until explicitly discarded and are never proposed automatically.

The Suite holds the displayed copies in state. It reads them when the case or recorded version changes,
a copy storage event arrives, ownership confirmation finishes, or a copy is discarded. Rendering and
confirmed typing do not scan localStorage. If storage refuses a copy, retain it in the tab and say to copy
it before closing the tab.

## Alternatives and tradeoffs

Web Locks would make a claim asynchronous and require buffering input already accepted while waiting.
They would also need to cover takeovers and every later writer. Separate copies preserve the existing
editor flow and retain text even when a window closes before receiving its ownership event.

A timer without the `writing` marker could confirm ownership while a competing first write is paused.
Keeping copies for the whole draft avoids that problem but doubles persistent draft storage and leaves
copies after normal takeovers. The short confirmation period keeps the additional work off ordinary typing.
During that period each input writes its copy twice, before and after the shared write. Confirming or
showing recovery scans device keys once per event, rather than once per render.
