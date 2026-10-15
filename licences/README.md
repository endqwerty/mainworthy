# Licences of what Mainworthy ships from others

`bun scripts/licences.ts` writes `THIRD-PARTY-NOTICES.md` at the root of the repository from the npm packages the
build bundles and from this directory (decision 0025). The directory holds what the bundler cannot see:

| Path | What |
| --- | --- |
| `components.json` | What the diagrams embed (Archify, JetBrains Mono), and the Bun release the executable is built with |
| `archify/`, `jetbrains-mono/` | Their licence files, from their repositories at the versions named |
| `bun-1.4.3/components.json` | Every part of Bun 1.4.3 that is or may be linked into its Linux binary, with its licence files |
| `bun-1.4.3/texts/` | Those licence files, exactly as each project publishes them, each text once |
| `bun-1.4.3/audit.tsv` | The audit's decision for each of 444 parts it looked at, linked or not, and why |

Every text is a file as its project publishes it, at the revision named. A part that publishes no licence file is
represented by the licence where it states one: the comment at the head of a source file, or the licence section
of its README, copied line for line into a file whose name ends in `.licence.txt`.

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
worker and reviewed by Claude Opus 5.5, which found four faults in its first result; all four were fixed.

What the audit did not settle, and what Mainworthy must do about each before anyone else is given the executable
or the container image (`docs/compliance.md`, gap 4):

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
