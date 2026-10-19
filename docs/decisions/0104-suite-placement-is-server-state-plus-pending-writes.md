# 0104: Suite placement is server state plus pending writes

Date: 2026-10-18. Status: proposed.

## Problem

A change-stream read replaced an optimistic tag or move while its write was still on
its way (issue #462). Deferring the placement's own reads did not cover reads from
the stream. An open draft also kept tags and folder from when it opened, even when
the server recorded a placement elsewhere without changing the case version (issue #452).

## Decision

Keep server rows in the query cache and pending placements in an ordered set owned by
the Suite. Derive the displayed list and case by applying those placements to each
server read. Tag, move, archive, drag and drop, and undo share this projection.
Queue an undo's inverse in the same set before waiting for its original write.
A refused write removes its own entry. An adopted reply holds its confirmed
placement in the cache and cancels older reads before doing so, including paged
reads. Its own reply retires its entry and reads the project again. Confirmed
placement stays visible if that read fails. Other pending entries remain applied
throughout. An original write with a queued undo retires while its inverse remains projected.

A draft owns its versioned text, original body and base version. Its `tagChanges`
contains only tags the person added and removed in the editor. It holds no whole
edited tag set. The editor shows live server tags, with pending placements applied,
then applies the draft's additions and removals. Its save sends only that delta,
leaving out additions the server already has and removals already absent. A tag
added or removed elsewhere never becomes the draft's own change. An existing
case's folder always follows the live case. Moving it is a separate placement write.
New-case drafts start with an empty baseline and own their creation tags as additions.

Stored drafts from before this shape recover their delta against their stored
`originalTags`, before following any live server tags. A pending placement never
becomes a draft edit, even when accepted while the editor is open. Receiving
placement changes neither the draft's text nor its base version. A save remembers
the delta it sent along with its exact request. A recorded save retires that delta
and keeps any additions or removals made since it was sent. Recovery replays the
remembered request unchanged and retires its own delta the same way.

Delete cache snapshots, delta rollback and the placement read counter. Reads from the
stream and the write path now share the same projection rather than needing guards
at every refresh source. Waiting for every placement before refreshing would keep
unrelated server changes from appearing. Other clients and the server contract do
not hold this browser state and do not change.
