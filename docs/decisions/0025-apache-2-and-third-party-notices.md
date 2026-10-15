# 0025: Mainworthy is under the Apache License 2.0, and ships the notices of what it bundles

- Date: 2026-10-14
- Status: proposed (built in the pull request that adds this file; the owner reviews)

The repository has been public since 2026-10-13 with no licence (`UNLICENSED` in `package.json`): anyone could
read the code and nobody else had the right to use it (`docs/compliance.md` listed it as a gap). The iPhone app is to go on
the App Store, which asks for a copyright holder. And the executable, the container image and the web UI carry
software that others wrote, whose licences ask that their text travels with every copy. Nothing carried that
text, another gap the register listed.

## Decision

**Apache License 2.0, for all of it.** The server, the web UI, the command line, the agent skill, the iPhone app
and the documentation. The owner chose it over MIT on 2026-10-14. Both let anyone use, change, host and sell
Mainworthy. Apache 2.0 adds a patent licence from each contributor, which ends for anyone who sues over a patent
in the work, and it says outright that a contribution comes in under the same licence. The cost is a longer
text and a NOTICE file that whoever passes Mainworthy on must keep.

**The copyright holder is the owner, by their legal name.** It is written in `NOTICE`, in the
iPhone app's `Info.plist` (`NSHumanReadableCopyright`, which the system reads and the App Store listing copies)
and in the test that checks those lines (`test/licences.test.ts`); every other page links to `NOTICE`, and that
test lists the files that hold the name. This is the one exception to the rule that the owner's name is not written in the repository, at the
owner's request on 2026-10-14. Everywhere else the rule stands.

**Every licence that applies is shipped in full, generated from what the build bundles.** `THIRD-PARTY-NOTICES.md`
holds the text of each licence, exactly as its project publishes it. `bun scripts/licences.ts` writes it from
three sources:

| Source | How it is found | Where it ships |
| --- | --- | --- |
| npm packages | The build's entry points are bundled and the bundler reports which files went in; a package that is installed and never imported is not shipped and not listed. The text is the licence file inside each package. | The executable; the web UI a browser loads takes some of them |
| The Bun runtime | `bun build --compile` puts the whole runtime into the executable, with every library Bun links. The list was made from Bun's source at the release tag (`licences/README.md`). | The executable |
| Archify and JetBrains Mono | Each diagram page embeds Archify's viewer and the font. | The diagrams at `/docs` |

The three files are at the root of the repository, for GitHub and for anyone who takes the code, and the
container image has them in `/usr/share/doc/mainworthy/`. The iPhone app contains no code from others: only its
own and Apple's frameworks.

**The apps do not show the licence yet.** The owner decided on 2026-10-14 that licensing stays out of the user
interfaces for now, like hosting an instance on another server: no page in the guide, no route on the instance
and no rows in the iPhone app's About section. Showing them, and what distribution needs (below), are kept in
[#234](https://github.com/endqwerty/mainworthy/issues/234).

**A licence is accepted once, by name.** `LICENCES` in `scripts/licences.ts` lists each licence a shipped
component may have, with what it asks of us. A dependency under any other licence fails `test/licences.test.ts`
with its name, so adding one is a decision made in review and not found later.

**Bun is audited from its source, not taken at its word.** Bun's `LICENSE.md` names about 30 libraries and 23 polyfills. The
audit of Bun 1.4.3 found 266 parts that are or may be linked into its Linux binary: C and C++ libraries at their
pinned commits, WebKit and ICU, 65 Rust crates, code ported or copied into Bun, 84 npm packages and 27 files built
from them that it embeds for its Node.js fallbacks and its REPL, and the compilers' runtime libraries. Each keeps its licence files as its project publishes
them; `licences/README.md` says how the list was made and what it left open. The licences that came with Bun and
with nothing else (LGPL, MPL-2.0, Artistic-2.0, GPL with runtime exceptions, and two ports that name none) are in
`LICENCES` because Bun is the stack (decision 0010), and this pull request asks the owner to accept them.

**The Bun in the image is pinned to the release the notices were read from.** The Dockerfile named `oven/bun:1.4`,
which moves with every patch release; it now names `1.4.3`, the version CI runs. A test holds the Dockerfile, CI
and the notices to the same version, so upgrading Bun means reading its libraries again.

## What was turned down

- **MIT.** Equally permissive and shorter, but without the patent licence. The owner picked Apache 2.0.
- **A copyleft licence (AGPL) or a source-available one (FSL, BSL)** to protect a future hosted tier (#31). The
  owner was offered both on 2026-10-14 and chose Apache 2.0.
- **Listing every installed package.** `node_modules` holds 105 production packages, most of them reached only
  through the MCP SDK's HTTP server, which Mainworthy never imports. Listing them would claim to ship code it
  does not.
- **Bun's own list.** It leaves out the Rust crates, most of the ported code and the embedded npm packages, and
  it calls domain-browser MIT where the package says Artistic-2.0.
- **Writing the licences by hand.** A list kept by hand is out of date at the next `bun update`; this one is read
  from the bundle and checked by the suite.

## Consequences

- Giving anyone else the executable or the image needs a decision first: how the source of the LGPL and MPL
  parts is offered, and whether the items the audit left open are acceptable (`docs/compliance.md`, gap 4;
  [#234](https://github.com/endqwerty/mainworthy/issues/234)). Running it for others on the owner's server, and
  publishing the source, need none.
- The web UI sends some of the npm packages (React, TanStack, Zod among them) to every browser that opens it, and
  the minified bundle does not carry their notices. Until #234 puts them in the apps, the notices are in the
  repository and the image only.
- The notices are about 1.4 MB, and `licences/` about 2.6 MB: the price of keeping every text as published.
- A Bun upgrade fails `test/licences.test.ts` until `licences/` is brought up to the new release.
- The App Store listing uses Apple's standard licence agreement and the copyright line of `Info.plist`
  (`ios/README.md`).
