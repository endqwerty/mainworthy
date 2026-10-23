# 0134: a case body and its metadata are one proposal

Date: 2026-10-22. Fixes issue #568.

A case editor holds versioned text, explicit tag additions/removals and requirement
links. They must be proposed together: current and proposed tags classify the whole
proposal under the adoption policy. Sending a body first lets an edit adding a
protected tag become current before the protected scope's review. Rejecting the
later tag proposal cannot undo that body. The security audit found this in the
initial body-first implementation, before this decision landed.

The server now lets a merge resolve exactly one ordinary body edit plus that case's
tag additions/removals and requirement-link deltas. It reconstructs the replacement
from authoritative resolved edits, preserves their order and explicit deltas, and
uses the body edit's stored head as its base. It seals the whole replacement and
raises adoption as the original author. Resolving the conflict does not approve the
replacement: current policy, current tags and proposed tag additions still decide
who must review it. Keeping the current body can therefore leave a metadata-only
proposal awaiting the same review.

Folder/rank/state changes, tag replacement sets, supplied requirement titles,
other-case changes, multiple bodies and exact fragment edits remain unsupported.
They cannot accompany a resolution unseen. The author rejects and proposes them
again on current versions. The merge answer adds optional `tags` and `covers` addition arrays; no stored server data changes.
CLI and MCP use the same merge answer and gain the same narrow behavior. The iPhone
still edits only case text: it decodes mixed proposals, keeps its draft and gives
an explicit instruction to review them in the web app rather than failing to decode.

The web editor submits body and metadata atomically and lists the accompanying
metadata in its conflict card. The durable card remembers the submitted deltas.
Completion retires only those deltas; later additions, removals and inverses stay
in the draft. A waiting merge records its full submitted body and metadata and
waits on that question before submitting later work. Lost replies recover the
original command unchanged. Concurrent requirement links are reconciled as deltas
against freshly read links, for adopted and unchanged bodies alike. Other clients'
changes are not inferred to be local intent.

Body-first staging was rejected because it drops proposed protected tags from the
body's review. Adding tags before the body and removing them afterward was also
rejected: it needs durable sequencing across three partial outcomes and leaves
metadata current when the intended body is rejected. One proposal already has the
policy, validation, recovery and adoption transaction the editor needs.

## Inline metadata in a conflict card

The same pure core parser now extracts inline tags and requirement links from the
ordinary editor and the conflict card's title, actions and expectations. Preconditions
and custom fields remain literal. The merge answer carries a cleaned body and
same-case `tags`/`covers` additions. The server overlays those additions on its original
resolved deltas, cancelling removals of the same items, before sealing and classifying
the atomic replacement under the original author.

Only fields different from both the conflict's recorded current and base values are
inline capture. Equal fields stay byte-for-byte literal, with actions and expectations
matched by step id. "Keep current version" therefore keeps the body exactly and
returns unchanged when there is no metadata to submit. The web uses those snapshots
both at submission and when reconciling the live card after a reply.

The server enforces the same rule using the original resolved edit's stored head
and base versions, read from the database. Newly supplied raw inline tokens are
refused before a replacement is written. Stored literal tokens can pass unchanged.
Automatic server extraction was rejected because it would silently rewrite legal
instructions such as `Enter #critical in the filter`. A blanket refusal of inherited
tokens was also rejected: it prevented legitimate keep-current resolutions.
CLI and MCP receive the same contract through the registry. The iPhone's selection-only
resolver can keep current/base literals and keeps its draft on refusal of other raw
tokens. Ordinary structured proposals, imports, seed/demo data, finding-derived steps
and native ordinary saves retain their literal body contract. Outline capture and web
proposal builders already parse inline syntax. The conflict card was the sole web
body submission that skipped that parser.

Each durable sent merge stores its extracted additions beside the exact body and
command id. The raw live card stays available for retries. Settlement parses a copy
of that card and retires only the winning attempt's effective metadata. A typed tag
is explicit intent even if a server placement refresh already shows it; otherwise
completion could mistake an accepted addition for a later removal. Moving to another
conflict advances the immutable proposal metadata to that replacement's deltas.
Legacy attempts without additions retain their original raw-body semantics.

## One line grammar for capture and merge validation

Outline and inline field capture share one CRLF/LF/CR line tokenizer. Field capture
applies the metadata parser directly to every logical line; it no longer wraps a
field in an outline heading and discards the resulting steps. Thus headings, list
markers, tables and additional lines inside a field stay field text, with recognized
tags and requirement links extracted independently. No nested structure is silently
dropped. Other Unicode separators are not outline line endings.

The server checks both the submitted body and its storable form before sealing a
replacement. This also catches tokens exposed by title whitespace normalization,
including Unicode line/paragraph separators and vertical/form feeds. Stored titles
continue to collapse whitespace to spaces; actions and expectations remain multiline.
No new title storage format is introduced. Exact inherited-field exemptions remain,
as do ordinary structured proposals' literal semantics. A caller must submit the
parsed body with explicit additions, which meet protected review atomically.

Changed titles normalize the same JavaScript whitespace class as storage before
inline capture. Otherwise a pasted nonbreaking or full-width space can hide a
recognized token from the client while the server's normalized-body check refuses
it. The exact inherited-title exemption runs before normalization. Step fields and
outline grammar retain their existing line rules. Broadening every field's token
boundaries was rejected because only titles have single-line storage normalization.

## Bounded reconstruction

Merge answers bound each metadata array by the shared 5,000-edit proposal ceiling.
There was no separate count limit on ordinary case tags or requirement links to reuse;
their existing per-item syntax remains shared. The answer bound counts repetitions,
while sets deduplicate additions and reconcile original removals in linear time.
Sealing itself refuses more than 5,000 edits, including preserved original deltas,
before any replacement is written. The author can reject and propose smaller changes.

The conflict handler yields through the existing sealing and adoption-policy generators,
under the original author and transaction. Readers continue to see the committed case
and question until the entire resolution commits, and command retries recover the same
reply. A new suite-owned reconstruction API was rejected for this change: it has one
caller and would move already reviewed logic without changing this contract. Ordinary
proposal metadata arrays and stored case collections retain their existing semantics.
