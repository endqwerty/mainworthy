# 0146: Case proof names its result

- Date: 2026-10-22
- Status: accepted (the owner requested the contract change in issue #792)

## Problem

The web case pane combined the proof reply's outcome and basis with the latest matching result in its timeline.
That timeline is a bounded page. After a pass on v1 and 102 title edits, it contained no result, so the pane used
the case's current version and claimed the pass was on v103. The proof reply correctly said `current: false`.

## Decision

A non-null case proof carries the selected result's `id`, `version`, `by`, `method`, `model`, and `name`, alongside
its `outcome`, `at`, `current`, and `basis`. The result version stays nullable. A client says "unknown version"
when no version was recorded and never substitutes the current case version. A method with no result remains `null`.

Evidence selects the latest result per method. Operations resolve its actor label through identity and its test
name through evidence. Both `get` and rich `find --in cases` return this same projection. The web and iPhone case
screens render it directly. CLI and MCP retain it through the shared reply schema. No stored records change.

The web's timeline reconstruction and version fallback are deleted. Reading more timeline entries would only
move the failure to a larger history, so the proof does not depend on timeline pagination.

The demo already has results and later case edits. Adding 102 artificial edits solely to exhaust a page would
obscure that history. A browser regression reproduces that boundary instead.

Principles: Fix Root Causes (return identity from the selected result); Type System Discipline (every present
proof requires identity and preserves an unknown version); Test Behavior Not Implementation (assert the proof
sentence in a real browser); Migrate Callers Then Delete Legacy APIs (update all clients and delete reconstruction).
