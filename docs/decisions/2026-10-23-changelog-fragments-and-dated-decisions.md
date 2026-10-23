# Changelog fragments and dated decisions

- Date: 2026-10-23
- Status: accepted
- PR: https://github.com/endqwerty/mainworthy/pull/832

## Problem

Parallel authors edit the top of `CHANGELOG.md` and choose the same next decision number. Rebases require manual conflict resolution, which has already lost an unrelated changelog entry. These facts do not need a shared write target.

## Decision

Each user-visible change adds `.changes/<issue-or-unique-id>-<slug>.md`. Metadata names its id, category, date and issue or PR. A thread task without a PR yet uses `pr: pending`, which the coordinator replaces with the PR URL when one exists. The `description` job requires every fragment added by a ready PR to carry that PR's URL; `pending` is allowed only for a draft. The entry is one Markdown paragraph describing what a person can observe. Soft wraps assemble onto one line, with one ownership marker. Reference definitions are refused because their labels would share the assembled document.

`bun scripts/changelog.ts --check` validates fragments and reports the number not yet assembled as information, not a failure. Without an option it previews the aggregate on stdout. `--write` atomically replaces `CHANGELOG.md` after validating every fragment. The coordinator assembles it.

`main` deploys continuously, with `CHANGELOG.md` as the user-facing record. At the end of each landing batch, the coordinator opens an ordinary pull request titled "Assemble the changelog". Assembly happens at least daily while fragments are pending. The owner reviews and merges that PR through the usual workflow. CI must never push to `main`.

Authors retain fragments after assembly, so repeated runs regenerate the same marked section without duplicating entries. Merged fragments are immutable, even before assembly. The description check first requires its paginated file count to match GitHub's reported total, refusing truncated lists. It rejects modifications, renames and deletions against the PR base, inspecting both filenames for a rename. Corrections add a new fragment identifying the old entry; there is no typo exception or modifying-PR list.

Both check and write refuse a generated line without a known fragment marker, including a hand-written entry added by an older branch, and direct the author to move it into a fragment. Each present generated line must also match the canonical output of its fragment. When `CHANGELOG.md` changes, CI runs `--check --complete` on one parallel test runner and requires the complete aggregate to match assembly. This refuses removed entries while allowing new fragments to remain pending on PRs that leave the aggregate alone. Historical text outside that section stays byte for byte unchanged. The aggregate orders dates newest first, then ids ascending. Fragment links resolve from `.changes/`; the assembler rewrites relative destinations for the root changelog.

New decisions use `docs/decisions/YYYY-MM-DD-<slug>.md`. Their first heading has no number. The date matches the filename, status is explicit, and an issue or PR identifies the work. Historical numbers are `0001` through `0155`; new records must be dated. PR admission refuses new numbered files even in gaps in that range. A mistyped date cannot fall back to a historical id. Historical numbered files and their links stay unchanged, including their inconsistent older metadata. `bun scripts/decisions.ts` generates a Markdown index on stdout, ordered by date oldest first, then id. Undated historical records precede dated ones and keep numeric order.

No code in `src/` reads `CHANGELOG.md` or enumerates these design records. `src/core/docs.ts` and `src/surfaces/docs/content.ts` describe the user guide only. Neither the in-app docs nor the demo needs a new page or behaviour for this contributor workflow.

## Alternatives

Union merges cannot distinguish an intentionally removed sentence from a lost one. Assigning decision numbers at merge would preserve the integration queue and require reference rewrites. A hand-maintained index would give every author another shared file to edit. Deleting fragments after assembly would require coordinating two writes and would discard the source needed to regenerate the aggregate.

## Checks

[Developer instructions](../development/change-the-code.md) define the formats and commands. `test/changelog.test.ts` checks deterministic, exactly-once assembly, history preservation, metadata and links. `test/decisions.test.ts` exercises both conventions and rejection cases. `test/docs.test.ts` validates repository records, and `test/ci-scope.test.ts` checks fragment-only CI selection.

Principles: Separate Before Serializing Shared State (independent files); Boundary Discipline (parse metadata once); Make Operations Idempotent (retain fragments and replace the generated section).
