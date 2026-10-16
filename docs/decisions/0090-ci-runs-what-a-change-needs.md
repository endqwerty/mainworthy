# 0090. CI runs what a change needs

Date: 2026-10-16. Asked by the owner in a thread; follows decision 0014 and issue #77.

## Problem

Every pull request ran the whole check: six shards of tests, the quiet tests, the type-check and lint, the
container image and the iPhone app on a macOS runner. A change to `AGENTS.md` or to a decision record waited for
all of it, and so did a change to the web UI for the iPhone app's build, which reads only the server.

## Decision

A first job, `scope`, reads the files the change adds, changes or deletes (`scripts/ci-scope.ts`). For a pull
request that is the difference between its merge commit and the base it merges into; for a push to `main`, the
difference from the commit before the push. A rename counts as the file it was and the file it is.

Each job runs when a file it reads changed:

| Job | Runs for a change to |
|---|---|
| `static` | `src/`, `test/`, `bench/`, `scripts/`, a JSON file at the root, `.gitignore` (the lint reads it), `bun.lock`, `bunfig.toml` |
| `image` | what the Dockerfile copies, the Dockerfile and `.dockerignore` |
| `ios` | `ios/`, `scripts/ios.ts`, `scripts/ios/`, `src/` except `src/web/`, the packages, `tsconfig.json`, `bunfig.toml` |
| tests | everything, unless every changed file is prose, another workflow or the iPhone app (below) |

The tests run whole unless every changed file is one that no code of the product, the tests or the scripts
reads: `docs/` other than what `/docs` serves, a Markdown file at the root other than `THIRD-PARTY-NOTICES.md`,
`.github/` other than `check.yml`, and `ios/`. Then one runner runs the three tests that read every file of the tree
or every entry at its top (the former name, the owner's name, the jobs of each top-level entry) and each test file that names a changed file or a directory it is in, from
the root or through `../`. A change to `CHANGELOG.md` runs three test files, one to `AGENTS.md` four, one to the
iPhone app five beside the `ios` job, and one to a decision record nine: every test that names a file under
`docs/` is one that might read that directory.

Everything runs when the change cannot be read (a new branch, a force push), when it is empty, and when it touches
what decides what runs: `check.yml`, `scripts/ci-scope.ts`, `scripts/check-plan.ts`, `scripts/check.ts`,
`scripts/ci-gate.ts`.

The `gate` job still always runs and is still the one to require. It counts a skipped job as passed only when
`scope` said the change did not need it, and it expects in the reports the test files the scope chose, no fewer.
Those results go to Mainworthy as before, under the job name `tests` (and `quiet` when a chosen file is a quiet
one). Running `bun scripts/ci-scope.ts` locally says what CI would run for the branch.

## What holds it

`test/ci-scope.test.ts` holds the `image` paths to the Dockerfile's COPY lines, the `static` paths to
`tsconfig.json` and `biome.json` (with `.gitignore`, which the lint reads), and the `ios` paths to every module
`scripts/ios.ts` loads, none of which is the web UI's. It also lists every entry at the top of the repository with
the jobs a change to it runs, so a new configuration file is placed in review. The verifier of the first version
found two that were missing: `.gitignore` for the lint, and `tsconfig.json`, whose paths Bun reads to start the
iPhone app's server. Narrowing the tests rests on one assumption, that only a test reads those files and names them when it
does. The test lists every module outside the tests whose code names one, so a new reader is seen in review.

## Considered

- **`bun test --changed`.** Bun 1.4 selects the test files that import a changed file. For a change to
  `src/web/app.tsx` or `src/web/lib/layout.ts` it selected no test file: the browser tests reach the web UI
  through a server they start, which no import shows. For a decision record it selected none either, though two
  tests read every file. Not safe as the selector.
- **Nx, Turborepo, Bazel, Pants.** They compute the projects a change affects from a graph of declared projects
  and inputs. This repository is one package, and its tests read files at run time; adopting one means declaring
  those inputs by hand, which is the table above with a build tool around it.
- **`paths:` filters on the workflow, or `dorny/paths-filter`.** A workflow skipped by `paths:` leaves its
  required check pending, so a pull request cannot merge. `dorny/paths-filter` is the same matching as the table,
  as a third-party action that reads the pull request through the API; a script of ours is tested with the rest
  of the check and runs locally.
- **A test map by imports and coverage.** Finer selection within the code, at the cost of a map to keep current.
  Not needed: the wait is mostly for changes that touch no code at all.

## Not done

A change to code still runs every test. A change to the guide pages runs every test and the image, because the
server imports them.
