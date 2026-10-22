# 0134: Record proposal coverage only during animation frames

Date: 2026-10-22. Status: proposed.

## Problem

Decision 0133 bounds scroll measurements with observer-selected parts, but its
observer callbacks, initial setup and answer handler also record coverage outside
animation frames. A script can press Reject repeatedly in one task, page through
a wrapped diff and record an answer before any intervening position appears.
The same reproduction fails under CPU throttling. Issues #620 and #626 describe
between-frame measurement and answers that skip unseen wrapped content.

## Decision

Keep each part's merged vertical ranges and the unread set. Only the watcher's
animation-frame callback records coverage. Scroll and intersection callbacks
schedule that pass. Initial setup, part resize and window resize queue parts to
measure in the same pass. The callback measures the union of queued and visible
parts once, then clears the queue. Detaching still cancels the frame and observers;
reattaching keeps the evidence node's prior coverage.

An answer check may measure heights and invalidate coverage after a reflow, but
cannot add coverage. This check belongs in `proposalReadMessage`, shared by the
initial press, Queue submission and the case timeline's delayed reason form.
Paging remains synchronous so a press reveals the next unread range immediately.
That range counts only when the scheduled frame measures it.

This changes the shared web helper used by Queue and case timelines on both
layouts. CLI and MCP answers have no DOM visibility gate. The native iPhone gate
uses Swift view geometry and does not call the web scheduler. No operation or
stored-data contract changes. The demo already contains paged proposals, so it
needs no new data for this scheduling correction.

Retaining synchronous coverage on answer presses would leave the demonstrated
skip in place even after moving observer measurements. A second visibility model
or a new scroll index would duplicate the existing range gate and its reflow
invalidation. Keep one frame scheduler and delete all other coverage writers.
