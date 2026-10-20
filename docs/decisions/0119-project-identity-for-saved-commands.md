# 0119: Saved commands name the project identity

Date: 2026-10-20. Status: accepted.

A project key is an address that can be reused. Deleting and recreating a project,
including refreshing the demo, can reuse its question refs, evidence hashes and
SQLite row id. A saved command must name the project it was prepared for.

Every project receives an opaque random `identity` at creation. Migration 0035
assigns identities to existing projects. Project lists and session replies expose
it, and lossless exports retain it. The migration changes exported data and marks
`archive: true`. This build refuses archives before version 35.

Project write inputs share optional `projectIdentity` alongside `cmd`. The registry
checks it against the current project inside the write transaction, before command
replay or any operation runs. A mismatch returns `conflict` with
`details.projectIdentity: "obsolete"` and writes nothing. The identity participates
in the command request digest. The optional field lets immediate web and CLI
commands continue without a separate project read.

The iPhone freezes identity in each prepared answer. Workspace screens, outboxes
and answer files belong to that identity. Account refresh retires a replaced
project's screens and outbox. A delayed send still carries the old identity, so
replacement after the last project-list read cannot send it to the new project.
A refusal for obsolete identity is terminal, even after uncertain delivery.

An unfinished saved answer from an earlier identity, or without identity, becomes
Obsolete and is never sent or recovered against the current project. Its outcome
is unknown. A completed entry keeps its recorded outcome and status, including
when read from an earlier build. Historical outcomes do not clear current drafts.
There is no client migration that attaches an old answer to today's project.

When the current identity has no answer file, its outbox reads earlier files for
the same instance, person and project key. Its first successful write saves the
current file atomically, then removes the readable files it imported. Clearing
outcomes therefore keeps them cleared across later project replacements.
Unreadable earlier files stay on disk and are skipped with one notice per import,
without blocking new saved answers. An unreadable current file still blocks writes
to preserve its saved answers.

A decide-only precondition would protect answers but leave the same fault in
other saved commands. The shared command envelope adds one admission check and
keeps operation-specific handlers concerned with their own inputs. Adding the
identity to admit would mix the caller's authority with a command's expected
project, before the transaction that must check it.
