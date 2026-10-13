# 0004: Multi-user by default, calm concurrency, online-first with a small offline allowance

- Date: 2026-10-10
- Status: direction accepted (Daniel); mechanisms proposed, to be tested in
  phase 0 mocks and the phase 1 benchmark

Answers open questions 8 and 9. Daniel's position: modern products are
multi-user; real-time collaboration is wanted only where it helps the task,
because badly done live co-editing is more nuisance than help. Offline work
is welcome if it does not hurt the experience, but data is online unless a
git-like sync turns out to be cheap.

## Collaboration

1. **Multi-user is the baseline.** Many people work in one project at once,
   with their own identities, roles and history entries. This is not a
   later add-on and shapes the data model from the start.
2. **No live co-editing of text by default.** No shared cursors and no
   character-level merge of one case body. Two people editing the same case
   is rare and should be handled calmly, not designed around.
3. **Concurrency is detected, not hidden.** Every edit names the version it
   started from (mainworthy versions are already immutable, with a parent).
   - Edits to different fields of the same case merge automatically.
   - Edits to the same field are a conflict: the later save is not lost and
     does not overwrite; the user sees both versions side by side and keeps
     one or merges. The diff view built for version history is reused.
   - Under the review policy of decision 0003 a conflicting edit becomes a
     proposal, which is the same mechanism.
4. **Live awareness where it helps, judged per task.** Candidates, each a
   hypothesis with a rejection criterion in the phase 0 hypothesis list:
   - lists, boards and run progress update when others change them, without
     a reload (high value: a release run executed by several testers);
   - a soft "Alex is editing this" hint on a case (low cost, may be noise);
   - live co-editing of a case body (assumed *no*; revisit only if the mock
     shows a task where it beats the conflict flow).
   A candidate is kept only if it beats the calm alternative on a measured
   job and never interrupts typing, moves the page under the user, or
   changes what they are looking at without a cue.
5. **Agents are users.** An agent writing through MCP gets the same version
   check and conflict handling as a person, and its identity is in history.

## Offline

1. **Online-first.** Data lives on the server (or the Local layer's own
   store). The UI is not a replica; Mainworthy does not promise to work with no
   connection.
2. **A small, honest offline allowance**, kept only where it costs the user
   nothing:
   - the app shell and recently viewed data stay readable during a drop;
   - edits made during a short drop are queued, shown as pending, and
     replayed on reconnect through the same version check as live edits;
   - unsent text drafts survive a reload or crash on the device.
   Anything that cannot be done safely offline (for example starting a
   frozen release run) is disabled with a clear reason, not queued.
3. **No git-style two-way sync commitment.** A full offline-first replica
   with merge is out unless the benchmark and mock show it is cheap and
   removes real pain. The cheap groundwork below keeps the door open.
4. **Local layer is unaffected**: the store is on the same machine, so
   connectivity is not an issue there.

## Groundwork that costs little now

- Every write operation carries a client-generated id, so a retry or replay
  is idempotent. (Also needed for optimistic UI and for CI retries.)
- Every edit carries its base version and is checked on write.
- The server can push change notifications to clients (one channel, used for
  the live-update candidates above); correctness never depends on it, and a
  missed push is repaired by a refetch.

These go into the stack criteria in decision 0001. They are properties of
the operation layer, not a sync engine.

## What this turns down

- Live co-editing of case text (CRDT or operational transform) as the
  baseline: large cost, conflicts rarely, and the user rejected it unless it
  helps.
- Last-write-wins silently: loses work, unacceptable for a QA record and for
  regulated profiles.
- Pessimistic locking ("checked out by Alex"): blocks people, stale locks.
- Offline-first with full sync as the architecture: heavy for little gain
  (see above); revisitable.

## Still open

- Which live-awareness candidates survive the mock (phase 0).
- Whether queued offline edits are worth building in phase 2 or wait for
  real demand, judged on the mock and the stack's cost for it.
- How long drafts and queued edits are kept, and what a user sees when a
  queued edit conflicts after a long drop.
