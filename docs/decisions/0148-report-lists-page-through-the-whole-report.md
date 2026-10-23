# 0148: Report lists page through the whole report

Date: 2026-10-22. Issue [#799](https://github.com/endqwerty/mainworthy/issues/799).

## Problem

Reports counted every matching row in their headlines but silently stopped their tables at the default limit.
Increasing `limit` could reach more rows through the CLI, but its maximum still left larger reports incomplete.
The web page offered no way to continue.

## Decision

Extend the existing `stats` operation. Each limited report accepts a numeric `cursor`, a row offset starting at
zero, and returns `total` and the next `cursor`, or `null` at the end. The existing limits stay in place. Every
report already orders its full result before taking a page, so paging uses that order and leaves headline totals
unchanged. Pass rate lists every day requested and needs no continuation.

The web uses the same pager for flaky tests, rerun tests, the automation backlog and coverage requirements.
It says "Showing N of M" and offers previous and next pages. The `n` and `p` bindings also put those actions in
the phone's Actions palette; page buttons are hidden on the phone. A changed day window starts from page one.
The first page shares the headline's cached read. If live updates remove the current page, the list returns
to the first page.

Pages read current data rather than a frozen snapshot. A write between page reads can change the order; start
again from page one to read the new order. Snapshot cursors would add state and invalidation to an operation
that already computes the whole report. A larger fixed limit would still hide rows eventually. A separate list
operation would duplicate each report's selection and ordering.

The demo's existing nightly failure and rerun now cover up to 25 automated tests. They consume no new random
draws, preserve the runner retry example, and make the flaky and rerun reports span pages in a full demo.
