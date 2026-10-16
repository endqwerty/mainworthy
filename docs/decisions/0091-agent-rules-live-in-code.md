# 0091. Agent rules live in code

Date: 2026-10-16. Asked by the owner in a thread.

## Problem

`AGENTS.md` grew from 2.9 KB on 2026-10-11 to 33.6 KB on 2026-10-16 and was touched by 55 of the repository's 514
commits. Every agent that works here reads all of it on every request. Most of the growth was a dated note for each
mistake an agent made ("On 2026-10-13 an agent ..."), plus shell recipes typed from the file, and a note holds
nothing: the next agent who skipped it made the mistake again (`pkill -f` took the shell that ran it three times).

## Decision

A mistake is fixed at the highest level that works, in this order: the architecture, a type, a check or a test
that fails and names what to do instead, a script, and only then a sentence for the judgment call that remains.
`AGENTS.md` keeps a rule only when it still needs judgment or the owner asked for it, and then as one row that
names what enforces it. It has a budget of 12,000 bytes (about 3,000 tokens), and no dated incident notes and no
shell recipes. History goes in `CHANGELOG.md` and here.

`bun scripts/work.ts` holds the commands that were recipes. Each is tested by the mistake it replaces
(`test/work.test.ts`):

| Was in `AGENTS.md` | Is now | The mistake the test makes |
|---|---|---|
| `pkill -f '[m]ain.ts serve'` (the shell that ran it was killed, three times on 2026-10-13) | `stop-server` | a caller whose own command line has the pattern is left alone; a server of another checkout is too |
| `pgrep -f '[t]est-worker'` (without the brackets the wait never ends) | `wait-tests` | a caller with `--test-worker` in its command line does not wait for itself |
| `mktemp -d ~/.cache/mw-XXXXXX` and "never delete by a pattern" (`rm -rf ~/.cache/mw-verify-*` deleted earlier verifiers' reports on 2026-10-16) | `scratch new`, `scratch rm` | a pattern, a directory nobody made, a symlink out of the root and the root itself are refused |
| the board's project, field and option ids, copied by hand | `board start`, `todo`, `done`, `check` | the ids are written once; `check` names the one that moved |
| "read back `closingIssuesReferences`"; "the closed #88" linked an issue nobody meant (pull request #172) | `pr-body`, run by the `description` job of `check.yml` | a closing word outside a line of its own, links GitHub made that the description did not, a milestone that is not the issue's. Pull request #327 had one: "Fixes #42" in a sentence closed issue 42 |
| "ask for base and head alternately, twice each, and judge the spread"; "a rebase that leaves the tree needs no round" | `check-time <base> <head>` | the same tree needs no timing; a difference inside the spread between runs of one revision is not slower |
| `git fetch && git reset --hard origin/main && git push --force-with-lease` after a merge | `sync-branch` | a branch with a commit that is not on `origin/main` is refused and keeps it |
| `rm -rf node_modules ...` in `t3.json`, and two children that released the worktree under a builder that was still running (2026-10-12) | `release` | it refuses while a server, a test run or another bun process works from the checkout |
| "one agent at a time runs the whole suite" | `bun run check` says when another run is going | `wait-tests` |
| no tailnet name in a public repository | `test/architecture.test.ts`, "a public repository" | a file with a tailnet name other than `example.ts.net` fails |

Also moved: how to land a stack, to `docs/landing-a-stack.md`; the CI jobs, the check's timing history
and the dated state of the project, to `.github/workflows/check.yml`, `scripts/check-plan.ts`, `CHANGELOG.md` and the
decisions that already held them. The rules for delegating (wording a verifier's brief, a child's findings file, a
worker that ends with "Selected model is at capacity", a child leaving the worktree release to its parent, scratch
made with `mktemp -d`) are not about this repository, and went to the owner's global agent rules in a change of the
same day.

## What stays open

The merge method is rebase only (a repository setting). Requiring `gate` on `main` is proposed in the pull request
that made this decision and not switched on: `gate` stays red until a person answers a question on the instance, so
it changes how the owner lands work.
