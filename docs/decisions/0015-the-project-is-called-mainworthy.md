# 0015: The project is called Mainworthy

- Date: 2026-10-13
- Status: proposed (built in the pull request for issue #98; the owner reviews)

The project was called Casebook from its first commit. Three things were wrong with the name:

- `casebook.com` has belonged to someone else since 1996.
- Casebook PBC sells case management software for social services under the same name, at casebook.net.
- Nobody can search for it. On 2026-10-12, 427 GitHub repositories carried the name and the npm and PyPI
  packages were taken. In a chat or in an agent's instructions, "casebook" is also an ordinary word.

## Decision

**The name is Mainworthy**: is this change worthy of `main`? The owner chose it on 2026-10-12 and registered
`mainworthy.com` on 2026-10-13. On 2026-10-12 a web search found no product with the name, no GitHub repository
carried it, and the npm and PyPI packages were free. Nobody has searched the trademark registers.

It is published under the owner's own accounts: the repository becomes `endqwerty/mainworthy`, and the npm
package is the bare name `mainworthy`, so that `npm install mainworthy` cannot fetch someone else's package.

**Every name the code defines changes with it.** The command and the executable, the package, the variables
(`MAINWORTHY_*`), the data directory (`~/.mainworthy`) and the database file (`mainworthy.db`), the MCP server,
the session cookie, the `X-Mainworthy-As` header, the `x-mainworthy-*` keys in the OpenAPI document, the JUnit
property that names a case, the first key of an archive, the prefix of what the page keeps in the browser, and
the agent skill (`skill/mainworthy`).

**What a person cannot type again is carried over. What a person set is renamed.**

| An install made before the rename has | What the new build does |
| --- | --- |
| `~/.casebook/casebook.db` | Moves it on the next `mainworthy serve` (`src/server/kernel/former-name.ts`). |
| Drafts, run notes and a theme in the browser | Moves them to the new keys when the page loads (`src/web/lib/former-name.ts`). |
| Archives it exported | Still imports them: the header may say `casebook` or `mainworthy`. |
| Reports that name a case with `<property name="casebook">` | Still links them. |
| `CASEBOOK_*` variables | Does not read them. Rename them. |
| A signed-in browser | Asks for the token once: the cookie has a new name. |

The first four are data: a draft that vanishes, or a result that silently loses its case, cannot be recovered by
reading a changelog. The last two cost one edit or one sign-in, and a setting that is read under two names can
be given two values.

**The database is renamed only when nobody else has it open.** The server first asks SQLite to fold the
write-ahead log into the database file, which SQLite does only for the last connection to a file. If that
succeeds the file alone is the whole database, and one rename moves it. If another process has the file open the
server refuses to start and changes nothing. Each step looks at what is on disk, so a start that was cut off
between two steps is finished by the next one.

**The deployment on Coolify keeps the names it stored**: the service and the tailnet node `casebook`, the
volume `casebook-data`, and the variables `CASEBOOK_OWNER_TOKEN` and `CASEBOOK_OWNER`, which
`compose.coolify.yaml` passes to the container under their new names. Renaming a volume in a compose file gives
the container an empty one; renaming the node changes the instance's address. `docs/deploy.md` says how to move
each of them by hand.

**A test keeps the former name out** (`test/architecture.test.ts`). It lists the files that may still say
"casebook", each with its reason, and fails on any other.

## Turned down

- **Reading the former data where it lies**, with no move. Every reader of the path (the server, its reader
  threads, the checkpoint thread, the benchmarks) would have to know both names for as long as the code lives.
- **Keeping `casebook.db` as the file's name.** It needs no move, and it leaves the former name in every
  instance for good.
- **Reading `CASEBOOK_*` as a fallback.** One deployment exists, and its compose file can map the names.
- **Leaving the dated records as they were written** (reviews, design candidates, earlier decisions). A search
  of the repository would then find two names, and an agent that reads one old file would use the old one. The
  records now say Mainworthy throughout; this file and the changelog say what it was called.
- **Editing the comment in the first migration.** A shipped migration is never edited.

## Also in this change

- **The icon** is `src/web/icon.svg`: a gate with a check mark, in the green the interface uses for a pass. It
  is the page's favicon, and the same two strokes are the mark beside the name in the page's header.
- **The owner's name is not written in the repository** (their request, 2026-10-13). The documents say "the
  owner", and examples use `dana`.

## Done after the merge (2026-10-13)

- The repository is `endqwerty/mainworthy`. GitHub redirects the former address.
- The instance on Coolify was redeployed from the new address and carried its data over (`docs/deploy.md`).
- The npm package `mainworthy` is published from the owner's account, as a placeholder that holds the name.

## Not done

- The trademark search. The owner put it off.
- `scripts/test-timings.json` has hand-written entries for the two new test files (both take milliseconds);
  the next `bun run test --update-timings` replaces them.
