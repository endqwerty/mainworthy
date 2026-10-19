# 0117: Results retain an ordered step trail

Date: 2026-10-19. Status: accepted.

A result's optional `steps` retains what the producer did and how long it took.
Each step has an identifier or runner label, an outcome, optional milliseconds,
optional actions with their own outcome and time, and an optional screenshot index.
Case steps already have stable IDs. Expanded fragment IDs qualify the occurrence.
Producers can use those IDs from the result's pinned case version without copying
the case text. Runner labels remain useful for tests without corresponding case
steps. They are observations, not verified case-step membership.

The trail is an immutable JSON aggregate. Existing evidence already stored simple
steps as JSON but did not return them. Migration 0034 names that column `trail`
and clears its redundant failure projection. JSON preserves order, omitted fields,
and zero durations, and every consumer reads the entire value. Normalized step
and action tables would add reconstruction and archive ordering without a current
need for partial writes or step analytics. Optional actions preserve simple trails
and accepted batches written before this change without a second reader schema.

When a trail is present, its first fail or error determines `atStep`, including a
null location for an empty or wholly passing trail. The scalar `at_step` remains
only for `failure.at` on results without trails. The overall result outcome stays
producer-supplied because a trail may be partial. Corrections create new evidence.

The report boundary bounds step and action counts, text lengths, and serialized
UTF-8 bytes per result and report. Screenshot indexes must refer to images in that
result's own report-time attachments. Later attachments append in order. Timing
is optional and does not require sums to agree because actions can overlap.

The registry exposes the same trail to HTTP, CLI, MCP, and the clients. One web
view and one iPhone view display it across changes, tests, and planned runs.
Outcome words remain readable without color. A relative-duration background scale
uses the longest measured step as its maximum; unknown and zero durations remain
untinted. Playwright's existing recorded steps become trails; other native formats
keep their existing result summaries.

MCP keeps its fixed 3950-token ceiling. Shorter discovery summaries and shared
schema definitions make room for the trail. Scalar `failure.at` leaves MCP
schema discovery because the trail supplies that location; HTTP and CLI keep it
for reports without steps. No report field is removed from the operation itself.
