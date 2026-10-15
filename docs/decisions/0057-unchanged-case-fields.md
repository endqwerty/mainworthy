# 0057: An edit can keep unchanged custom field values

- Date: 2026-10-15
- Status: proposed
- Issue: [Custom-field follow-ups](https://github.com/endqwerty/mainworthy/issues/276)
- Amends: [0052](./0052-project-field-definitions.md)

## Problem

An unrelated settings proposal replaced the whole settings object and removed field definitions when it omitted `fields`. MCP does not advertise field definitions, so callers could erase definitions they did not know existed.

The web and iPhone case editors preserve field values without editing them. Requiring every content edit to satisfy new definitions prevented editing an older case with a missing required value or an obsolete choice.

## Decision

A settings object without `fields` preserves the current definitions. An explicit map replaces them, and an empty map removes them all. Other settings still use their existing replacement semantics.

An edit validates each changed field value. An unchanged value from the current stored head can remain missing, blank, or outside the current choices. This applies to both editors, Markdown edits, and content proposals. New cases and restores still validate every definition. Removing a supplied required value counts as a change and fails validation.

The pure `fieldErrors` function accepts previous field values for edits. Proposal sealing compares merged content with the current head. Adoption compares the actual merged content with the head immediately before writing. A proposal that changes a field is checked against the definitions in force at adoption. Neither editor needs a new read contract or a separate exception.

Adding field controls to both editors would also unblock older cases, but would require exposing definitions and values in both client contracts. Allowing unchanged historical values is the smaller fix and lets a definition change take effect without requiring every old case to be completed before an unrelated edit.

## Remaining work

Stale Settings saves need the policy base version from [pull request 271](https://github.com/endqwerty/mainworthy/pull/271). The custom-field form must send the version belonging to the settings it copied and keep its draft on a conflict. That work is separate from this change.

## Checks

Operation regressions cover omitted and empty definition maps, missing and obsolete values, changed invalid values, restores, pending edits, concurrent merges, and archive replay. A real browser editor and the iPhone `CaseEditorScreen` both save an older case after a required choice field is introduced.
