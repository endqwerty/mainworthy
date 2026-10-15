# 0079: Shared steps are pinned case versions

A fragment is a case whose immutable kind is `fragment`. It has the same version,
proposal and decision history as a case. A case step can hold `use` with the
fragment's project-local case ref and an explicit version. References keep their
own step ids. The reference variant has empty action text and a null expectation;
its `use` carries the content. Ordinary steps cannot carry `use`.

Pins live in the version body. A separate table of pins would duplicate that
source and need another archive replay rule. Current usage is read from the
project's current version bodies. JSON usage queries cost more than a dedicated
index, which can be added if measured project sizes need it. Fragment preconditions and custom
fields belong to the fragment document; a reference inserts only its steps.

Fragments cannot contain fragment references. This keeps reusable instructions
one level deep and prevents self-inclusion and indirect cycles at sealing and
adoption. Each expanded step carries its fragment, pinned version, original step
id and reference occurrence id. Its result anchor is `useId.stepId`, so two uses
of the same fragment remain distinct. Reads expose concrete `steps` and retain
`sourceSteps` for editing. Markdown keeps the reference as
`- !use C-1@v2 ^ab`; a literal action beginning with `!` is escaped.

A new fragment version changes no existing pin. The `propose` edit `fragment`
names `fragment`, `from`, `to`, and selected `cases` with their `base` versions.
It must be the only edit in its request. The suite builds one proposal of ordinary
case edits and marks their bases exact. One adopt decision moves every selected
head through the existing witness, or none. A case changed before sealing or
before acceptance refuses the batch. Unselected cases and old case versions
retain their pins. The proposal records the fragment, both versions, selected
cases, author and reason. Existing policy determines whether it needs review.
Moving a pin changes the consumer's claim hash, even when both fragment versions
have identical steps. Earlier results therefore stop counting as current proof
of that consumer. The pin itself is part of the recorded claim.

Archiving a fragment keeps its versions and existing pins readable. Its users
can keep those pins while editing other content. This lets a team retire shared
instructions without rewriting historical or current consumers. New references,
including additional occurrences or moves to another version, require an active
fragment. Validation checks this both when proposing and when adopting.

The Suite editor can create a fragment, insert a pinned fragment by ref and
version, and remove a reference. A fragment's detail lists current users and
lets a person update selected users of an older version. Default run selections
omit fragments; explicitly selecting a fragment is refused. Run documents expand
the case version pinned when the run started. The native app can read and run
expanded steps. It directs edits of fragments and their consumers to the web
editor so its text-only editor cannot flatten pins.

Ordinary JSON reads continue to omit custom fields and fragment users. A caller
can request `fields` or `users` through the `get` field selection. The usage panel
requests `users` separately, so other fragment reads do not scan all consumers.
An explicit creation kind must agree with the kind in its Markdown document.

Schema 15 adds the case kind with a non-null default, so its archive version
changes. Old archives must be exported by a build using this schema before they
can be imported. Current archives retain all versions, kinds and pins.

Fragment authoring and batch inputs are omitted from MCP discovery with
`x-mcp-hidden`. HTTP, CLI JSON and the web use the full registry schemas. The
existing MCP token ceiling and measured tool sizes remain unchanged.

The creation check also exposed a stale selection event overwriting a newly
inserted step. Caret-only events now update the current draft caret without
replacing its body. Changing a new draft's kind participates in its draft content
comparison and is preserved until creation.
