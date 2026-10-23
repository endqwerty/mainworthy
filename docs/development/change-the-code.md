# Add an operation, a migration, a screen or a page

Each section below is one common kind of change: the files to touch, in order, and the test that fails if you
miss one. [How the code is organised](code.md) explains the layers these steps move through.

## Add an operation

A capability is an operation in the registry. The HTTP route, the OpenAPI document, the CLI command and its
help, and the MCP tool all come from the registry entry. Add no route, command or tool beside it.

To add an operation, follow these steps:

1. Write the input and reply schemas in `src/core`, so the browser and the server share them.
2. Define the operation with `defineOp` (project scope) or `defineInstanceOp` (instance scope) from
   `src/server/ops/registry.ts`. Give it a `name`, a one-line `summary` longer than 20 characters, the Zod `input`
   and `output`, the capability it `needs`, its `effect` (`read` or `write`) and either `run` or, for long work,
   `steps`. Set `mcp` to a description written for a model if it is an agent tool, or to `null`.
3. Compose domain functions in the operation. Do not write another module's tables from `src/server/ops`.
4. Add the operation to `list` in `src/server/ops/index.ts`. Register its reply in `REPLIES` in
   `src/core/replies.ts`, and add its input to `Inputs` in `src/core/api.ts` so the web client and the CLI
   type-check. An instance operation also goes in `INSTANCE_OPS` in `src/core/api.ts`.
5. Add the name to the operations table in `docs/architecture.md`, under the right row.
6. Run `bun scripts/gen-docs.ts` to regenerate the CLI and API reference in `docs/guide`.
7. Write the behaviour tests and check the operation on a real surface: the CLI, HTTP or the web UI.

`test/architecture.test.ts` ("the registry") fails on a duplicate name, a short summary, an eleventh MCP tool, a
reply missing from `REPLIES`, an input field named like a password and an operation named like a shortcut
(`createCase`, `closeRun`). `test/docs.test.ts` fails when the architecture table or a generated block no longer
matches the registry. Pipeline tokens hold `read` and `record` at most, whatever the grant says, so a new write
that a pipeline must call needs `record`.

## Add a migration

A schema change is a new migration. A shipped migration is never edited.

To add a migration, follow these steps:

1. Add `src/server/kernel/migrations/NNNN_name.sql` with the next free number. If another branch lands a migration
   first, take the next number again when you rebase.
2. Register it in `MIGRATIONS` in `src/server/kernel/migrate.ts` as `{ version, name, sql, archive }`.
3. Set `archive: true` if the migration changes the shape of an exported table or writes data into one. A change
   confined to tables that archives leave out does not break an archive. The comment on `MIGRATIONS` gives the
   rule for a nullable column.
4. Write a test of the behaviour the migration exists for.

The database applies pending migrations when it opens, all in one transaction. Before it changes a database file
it writes a backup beside it, `<file>.v<N>.bak`. The migration tests in `test/architecture.test.ts` keep versions
contiguous, keep each entry equal to its file, check the `archive` marks against the SQL and upgrade every older
schema to the fresh one. Whether a shipped migration was edited is left to review.

Nothing is compatible before 1.0. A migration may break stored data, tokens or archives when that makes the
result simpler. Say what breaks in a `.changes/` fragment with category `Breaks`. Build no migration path.

## Add a web screen

To add a screen to the web UI, follow these steps:

1. Add its name to `Screen` in `src/web/lib/router.ts` and teach `readRoute` its path.
2. Create `src/web/<screen>/index.tsx` and register the component in `app.tsx`. Add it to `navigation` there if it
   is a place of the work, with its `g` key.
3. Name the page that explains it in `SCREEN_DOCS` in `src/core/docs.ts`. The app does not compile without it.
4. Follow `src/web/SHELL.md`: a screen returns two panes, `#list` and `#detail`, imports its own CSS, reads
   through `useQueryOp` and lets the shell's change stream refetch.
5. Register keys with `useBindings`. Mark a binding `list: true` only when it decides nothing about the selected
   row.
6. Put phone styles in `src/web/phone.css` under `:root[data-layout="phone"]`. Add no touch control for what a key
   does. The palette lists the keys on a phone.
7. Describe the screen in its guide page and in `docs/guide/keyboard.md`, and add a browser test in `test/e2e/`.

`test/docs.test.ts` fails when a screen's page does not name the screen. `test/architecture.test.ts` ("the phone
layout") fails on a phone rule outside `phone.css`. The browser tests collect every console error, so a script
the page policy refuses fails the test of whatever it broke.

## Add a page to the user guide

To add a page, follow these steps:

1. Write `docs/guide/<slug>.md`. Its first heading is the title, and its first paragraph says what the page is for.
2. List it in `SECTIONS` in `src/core/docs.ts`, with the same title.
3. Import it in `src/surfaces/docs/content.ts`, so the executable carries it.
4. Run `bun scripts/gen-docs.ts` to update the generated page list in `docs/guide/index.md`.

`test/docs.test.ts` fails when a page and the table of contents disagree, when a page links to something the
site does not serve, when a heading link finds no heading and when a page names a path on the author's machine.
It cannot tell whether a sentence is still true, so read the page.

## Add or rebuild a diagram

Every diagram is a self-contained HTML page that [archify](https://github.com/tt-a1i/archify) builds from a JSON
candidate, which cites the files it describes. There are two sets:

| Set | Pages | Candidates | Shown on |
| --- | --- | --- | --- |
| served | `docs/diagrams/` | `docs/diagrams/src/` | the user guide. Every instance carries these pages. |
| repository | `docs/development/diagrams/` | beside each page | these pages and `docs/features-and-flows.md`, read on GitHub |

To rebuild a diagram after the code it describes has changed, follow these steps:

1. Edit the candidate, and set `meta.repository.revision` to a commit that is on GitHub.
2. Build the page. Installed as a skill, archify is at `~/.claude/skills/archify`.

	```
	$ bun scripts/diagrams.ts build ~/.claude/skills/archify <name>
	```

The script runs archify's `finalize`, which validates the candidate against the files it cites, renders it and
checks the page in a browser. Then it records the hash of the candidate and of the page in the set's
`built.json`. `test/docs.test.ts` fails when a candidate and its page no longer match that record.

A new served diagram also needs one line in `src/surfaces/docs/content.ts` and a link on the guide page that shows
it, a paragraph that is only `[Diagram: caption](../diagrams/<name>.html)`.
[docs/diagrams/src/README.md](../diagrams/src/README.md) lists where each one is shown. A new repository diagram
needs only its candidate, with `meta.output` set to `docs/development/diagrams/<name>.html`. GitHub shows an HTML
file as text, so a repository page shows `<name>.png`, a picture of the whole diagram that links to the HTML.
`build` draws it with the Chromium the browser tests use. To draw it again alone, run
`bun scripts/diagrams.ts picture <name>`.

## Change what the iPhone app reads

The app reads the server through one contract, `scripts/ios/contract.ts` (decision 0023). To change a reply the
app reads, change the contract, then run `bun scripts/ios.ts gen` to rewrite the Swift in the `Generated/`
directories. Never edit those directories by hand. `test/ios-contract.test.ts` holds real replies to the contract
and the Swift to the generator, and names the field that broke. The Swift tests need a Mac:
[ios/README.md](../../ios/README.md).

## Change a dependency

After you add, remove or upgrade a package, run `bun scripts/licences.ts` and commit the regenerated
`THIRD-PARTY-NOTICES.md`. The script reads the licences of what the production build bundles.
`test/licences.test.ts` fails when the notices are stale or a licence is not on the accepted list. A licence the
script does not name is the owner's call. Ask in the pull request.

## Add to the demo

A feature adds to the demo (the owner, 2026-10-15). `src/cli/demo/` decides what the demo writes and stays pure.
`src/cli/seed.ts` sends it through HTTP operations. Draw nothing new from an existing random stream, or every
existing demo changes. Write times only through the demo project's own clock: only a demo project accepts a time
from its caller (decision 0100), and `test/demo-time.test.ts` holds that. If adding to the demo is truly
unreasonable, say why in the pull request.

## Record a visible change

Add one `.changes/<issue-or-unique-id>-<slug>.md` file. Choose an id unique to this fact, such as the issue number or a task name. Different facts for one issue need different ids. The filename starts with the metadata id followed by a hyphen and a descriptive slug. Use lowercase letters, digits and hyphens.

Use this format:

```markdown
---
id: 123-example
category: Fixed
date: 2026-10-23
issue: https://github.com/endqwerty/mainworthy/issues/123
pr: pending
---

Describe the behaviour a person can observe and any compatibility break.
```

The metadata accepts one plain scalar per line. Categories are `Fixed`, `Changed`, `Breaks`, `Security` and `Added`. Dates are real calendar dates in `YYYY-MM-DD` form. Include `issue`, `pr`, or both as full links to this repository. Use `pr: pending` before a PR exists or while it is a draft. Every fragment added by a ready PR must carry that PR's full URL. The `description` job enforces this against files at the PR head. Write one Markdown paragraph, with inline links relative to `.changes/` or HTTPS links. Soft wraps are allowed. Headings, reference definitions and multiple paragraphs are refused. Use LF line endings and keep only lowercase `.md` fragment files in `.changes/`. The assembler relocates relative links for the root changelog and preserves code spans.

Run `bun scripts/changelog.ts --check` to validate fragments. Its count of fragments not yet assembled is information, not a failure. A feature author leaves `CHANGELOG.md` alone. The coordinator previews with `bun scripts/changelog.ts` and assembles with `bun scripts/changelog.ts --write`.

`main` deploys continuously; `CHANGELOG.md` is the user-facing record. At the end of each landing batch, the coordinator opens an ordinary pull request titled "Assemble the changelog" with the updated aggregate. Do this at least daily while fragments are pending. The owner reviews and merges it through the usual workflow. CI must never push to `main`.

Keep the fragments after assembly. Repeated runs replace the same marked section, sorted by descending date and ascending id, and preserve every byte of historical entries. Each fragment occupies one generated line. Both check and write refuse unmarked lines, unknown fragment ids and duplicate ids inside an existing section. Move a hand-written entry into a fragment before retrying. Do not use union merges.

## Record a design decision

Add `docs/decisions/YYYY-MM-DD-<slug>.md` with an unnumbered first heading and this metadata:

```markdown
# A descriptive title

- Date: 2026-10-23
- Status: accepted
- PR: pending

## Problem

Describe the problem, decision, alternatives and checks.
```

The date matches the filename. Status is `proposed`, `accepted`, `superseded`, `rejected` or `deprecated`. Include `- Issue: <full issue URL>`, `- PR: <full PR URL>`, or both. Use `pending` for a PR that does not exist yet, then replace it when opening one. Historical numbered records start with `0` and three digits. Any new record uses a complete calendar date. Keep every historical numbered filename and its links unchanged. Historical records retain their older metadata conventions.

Run `bun test test/docs.test.ts test/decisions.test.ts` to check records. `bun scripts/decisions.ts` prints a Markdown index with repository-relative links, sorted by ascending date and id. Undated historical records come first. Generate this list when needed instead of editing a shared index. The app serves guide pages only; it does not enumerate these records or read the changelog.

[Changelog fragments and dated decisions](../decisions/2026-10-23-changelog-fragments-and-dated-decisions.md) records why these files are independent.
