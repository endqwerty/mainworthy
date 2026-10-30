# Licences of what Mainworthy ships from others

`bun scripts/licences.ts` writes `THIRD-PARTY-NOTICES.md` at the root of the repository from the npm packages the
build bundles and from this directory (decision 0025). The directory holds what the bundler cannot see:

| Path | What |
| --- | --- |
| `components.json` | What the pages at `/docs` carry from others (Archify, JetBrains Mono, Basecamp's policies), and the Bun release the executable is built with |
| `archify/`, `jetbrains-mono/`, `basecamp-policies/` | Their licence files, from their repositories at the versions named |
| `npm/qrcode-generator@2.0.4/LICENSE` | The unchanged MIT licence from [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator/blob/master/LICENSE). Version 2.0.4 omits a licence file from its npm package. Its distributed JavaScript identifies the same author, copyright year, and MIT licence. |
| `npm/saxes@6.0.0/LICENSE` | The unchanged licence from [saxes v6.0.0](https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE); npm's package omits the file. The notice generator uses `npm/<name>@<version>/` only when the installed package has no licence file. |
| `bun-1.4.4/components.json` | Every part of Bun 1.4.4 that is or may be linked into its Linux binary, with its licence files |
| `bun-1.4.4/texts/` | Those licence files, exactly as each project publishes them, each text once |
| `bun-1.4.4/audit.tsv` | The audit's decision for each of 536 parts it looked at, linked or not, and why |
| `npm/<name>/<version>/` | Published manifests and licence files of npm packages embedded inside another bundled package's dist |
| `SOURCE.md` | Where the source of the LGPL and MPL parts is, how to link a changed library again, and the written offer |

Every text is a file as its project publishes it, at the revision named, byte for byte; two parts share a text only
when the bytes are the same. Where the audit kept a source file or a README rather than a licence file, the notice
it states is copied line for line into a file whose name ends in `.licence.txt`: the comment at the head of the
source file, or the licence section of the README. That is kept beside the project's licence file, because a
source file can carry a copyright and conditions of its own (WTF's `FastMalloc.cpp`) or the exception that applies
to it (TinyCC's `libtcc1.c`).

## Packages embedded in npm bundles

The generator reads tsdown's `//#region .../node_modules/.pnpm/<package>@<version>/node_modules/...` paths in
the files the build bundles. These identify code already embedded by a package's publisher, which Bun's input
list cannot name separately. Repeated regions count once per package and version. pnpm's peer-resolution suffix
is not part of the version. A region whose exact version has no installed or saved manifest and licence fails
generation and the licence tests.

For a new embedded package or version, run `npm pack <name>@<version> --ignore-scripts` under `~/.cache`.
Copy its `package.json` and every root licence and NOTICE file from the published tarball, byte for byte, into
`licences/npm/<name>/<version>/`, then run `bun scripts/licences.ts`. The generator checks that the saved
manifest names the package and version in the region. It also checks the licence against `LICENCES` through
`test/licences.test.ts`. A licence that list does not name needs the owner's acceptance.

The six packages currently saved here come from the npm tarballs for Ajv 8.18.0, ajv-formats 3.0.1,
content-type 1.0.5, fast-deep-equal 3.1.3, fast-uri 3.1.0, and json-schema-traverse 1.0.0, embedded in
`@modelcontextprotocol/server` 2.3.1. Only files the build reads are scanned, so an unused validator does not
add its dependencies. Inspect the publisher's dist when upgrading: a bundler that drops or changes these
regions needs another discovery method before its embedded packages can be accounted for.

## The Bun audit

`bun build --compile` puts the whole Bun runtime into the executable, so everything Bun links ships with
Mainworthy. Bun's own `LICENSE.md` lists most of it, but not the Rust crates that most of Bun is now built from,
and not all the code it copied or ported. So the list was made from Bun's source at the tag `bun-v1.4.3` (commit
`c6da4a4d3010e5553438c60f6bd76d981976867c`), on 2026-10-14:

- the C and C++ libraries in `scripts/build/deps/`, each at the commit it pins, with what the build compiles and
  links on Linux;
- WebKit at the revision `scripts/build/deps/webkit.ts` pins: JavaScriptCore, WTF, bmalloc and ICU 78.3, which
  its Linux build links statically;
- the Rust crates the runtime reaches on Linux x86-64 and arm64, resolved from Cargo.lock and each crate's
  manifest: normal dependencies only, without build, development, procedural-macro and other-platform ones; 65
  crates, the standard library's included, each archive checked against its checksum;
- code in Bun's source that names another project (copied WebCore files, ports of esbuild, Lightning CSS, Servo,
  TypeScript-Go, the React Compiler and others), and the npm packages Bun embeds for its Node.js fallbacks;
- the runtime libraries the compilers link: GCC's libstdc++, libgcc and libatomic, and Rust's.

A part is listed as linked when the build reaches it, even if the linker might drop it. Eight parts could not be
settled either way and are listed with "Possibly linked" and the reason. The audit was made by a GPT-6.1 Sol
worker and reviewed by Claude Opus 5.5, which found four faults in its first result; all four were fixed. The
verifier of the pull request that brought it in (Codex GPT-6.1 Sol) found that the import dropped the notices of
source files whose project also has a licence file, and joined texts that differed only in whitespace; both are
fixed, and `test/licences.test.ts` holds the import to it.

Bun 1.4.4 (tag `bun-v1.4.4`, commit `38afee6c84fcf48c0edb2466aa4b27d287a59c30`) was audited on 2026-10-30 as a
change to that list. A GPT-6.1 Sol worker started from the 444 decisions of 1.4.3 and audited again every part the
172 commits between the tags touch. Brotli and WebKit moved their pins. ICU stayed at 78.3. The other dependency
changes were patches and build flags at the same upstream revisions. No crate from the registry was added. The
release adds `bun fmt` and a linter; the released binary has no `bun lint` command, but its build links the linter's
crate and its strings carry the rules' messages, so both count as linked. Of the 92 parts the audit adds, 90 are
linked: ports of Prettier, ESLint, typescript-eslint and their plugins, postcss and its parsers, oxlint and oxc's
formatter, and others, each with the licence file of the release Bun names or, where it names none, the last one
published before Bun 1.4.4. That choice is recorded in each part's reason. None is under a licence that `LICENCES`
does not name. Claude Opus 5.5 reviewed the result and marked one addition as not linked: the worker listed links in
Bun's installer to files in npm's repository as an Artistic-2.0 port of npm. They are comments naming behaviour Bun
matches. The files they point at are ISC packages. The same links were in 1.4.3, whose audit did not count them. The
port of `@handlebars/parser` is the only new part listed without a text: the package declares ISC, but neither it
nor its repository publishes the licence.

What the audit did not settle. The owner settled them on 2026-10-23 for the published image and executable
([#234](https://github.com/endqwerty/mainworthy/issues/234)): [SOURCE.md](SOURCE.md) says where the source of the LGPL
and MPL parts is, how to link a changed library again, and the written offer that `NOTICE` repeats, and lists the
items below that were accepted as they are:

- **LGPL code is linked statically**: JavaScriptCore, WTF, WebCore files Bun copied and TinyCC. A recipient may
  replace them and link again, and may ask for their source.
- **MPL-2.0 files**: about 90 CSS files in Bun's source derived from Lightning CSS and Servo, Mozilla's
  certificate list, and the crates `cssparser`, `selectors` and `dtoa-short`. Their source has to be available;
  it is public at the revisions named.
- **TinyCC's runtime source, `libtcc1.c`**, is embedded as text under GPL-2.0-or-later with a linking exception
  that speaks of compiled code.
- **domain-browser 4.23.0 is under Artistic-2.0**, though Bun's table calls it MIT.
- **Bun's `LICENSE.md` says Bun is MIT-licensed but has no MIT text or copyright line.** It is reproduced as it is.
- **Two ports in Bun name no licence**, and their originals could not be pinned: kprotty's channel and the wyhash
  port (`NOASSERTION`).
- **The released binary was not inspected**: the list is read from the source and the build's configuration.

## When Bun is upgraded

`test/licences.test.ts` fails until the Dockerfile, CI and `components.json` name the same Bun. Audit the new
release the same way, keeping each licence file as fetched and the decision for each part, into a directory with
`manifest.json` and `texts/` (the brief of 2026-10-14 is the method above). Then:

```
$ bun scripts/licences-import-bun.ts <audit directory> <version>
$ bun scripts/licences.ts
```

Delete the previous `bun-<version>/` directory, set `bun` in `components.json`, and add any new licence to
`LICENCES` in `scripts/licences.ts` only after the owner has accepted it.
