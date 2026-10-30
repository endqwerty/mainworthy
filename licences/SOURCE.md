# Source of the parts Mainworthy ships under copyleft licences

The executable, and the container image published to `ghcr.io/endqwerty/mainworthy` that carries it, include the
Bun 1.4.4 runtime and what it links (`licences/README.md`, "The Bun audit"). Some of those parts are under the
LGPL or the MPL, which ask that whoever receives the executable or the image can get their source, and for the
LGPL, can link a changed version of the library again. This page is how Mainworthy meets that. The owner settled
it on 2026-10-23 ([#234](https://github.com/endqwerty/mainworthy/issues/234)).

## Mainworthy's own source

Mainworthy is Apache-2.0 and its whole source is public in this repository. An image names the commit it was
built from three ways: its tag (`ghcr.io/endqwerty/mainworthy:<full commit>`), its OCI label
`org.opencontainers.image.revision`, and `/health`, which reports the commit. The `Dockerfile` at that commit is
the complete build: it compiles the executable with `bun build --compile` using the Bun release it names.

## The parts under the LGPL and the MPL, at the revisions shipped

| Part | Licence | Source at the shipped revision |
| --- | --- | --- |
| JavaScriptCore and WTF (Bun's fork of WebKit) | LGPL-2.0-or-later AND BSD-2-Clause | <https://github.com/oven-sh/WebKit/tree/d6375c72affe0f70222cdcb45012b10f0bf3a9d5> |
| WebCore files and bindings Bun copied | LGPL-2.0-or-later | <https://github.com/oven-sh/bun/tree/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/jsc/bindings> |
| TinyCC | LGPL-2.1-or-later | <https://github.com/oven-sh/tinycc/tree/05f0fafaa3be31e31d7b4b5c17dc60f62c991171> |
| TinyCC's runtime source, `libtcc1.c`, embedded as text | GPL-2.0-or-later with TinyCC's linking exception | <https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/runtime/ffi/libtcc1.c> |
| CSS code derived from Lightning CSS and Servo | MPL-2.0 | <https://github.com/oven-sh/bun/tree/38afee6c84fcf48c0edb2466aa4b27d287a59c30/src/css> |
| Mozilla's certificate list | MPL-2.0 | <https://github.com/oven-sh/bun/blob/38afee6c84fcf48c0edb2466aa4b27d287a59c30/packages/bun-usockets/certdata.txt> |
| The crates `cssparser` 0.36.0, `selectors` 0.33.0 and `dtoa-short` 0.3.5 | MPL-2.0 | <https://static.crates.io/crates/cssparser/cssparser-0.36.0.crate>, <https://static.crates.io/crates/selectors/selectors-0.33.0.crate>, <https://static.crates.io/crates/dtoa-short/dtoa-short-0.3.5.crate> |
| Bun itself, which builds all of these into its runtime | MIT, as Bun's `LICENSE.md` states | <https://github.com/oven-sh/bun/tree/38afee6c84fcf48c0edb2466aa4b27d287a59c30> (tag `bun-v1.4.4`) |

The licence texts and notices of every part are in `THIRD-PARTY-NOTICES.md`, which ships in the image at
`/usr/share/doc/mainworthy/` and inside the executable, served at `/docs/licence`. The compilers' runtime
libraries (GCC's libstdc++, libgcc and libatomic, and glibc's startup objects) are linked under their runtime
exceptions, which put no source condition on the program; their revisions are in that file too.

## Linking a changed library again

The LGPL lets a recipient replace JavaScriptCore, WTF, the WebCore files or TinyCC with a changed version and link
again. Mainworthy's complete source and build are public, so this needs nothing from the owner: build Bun from the
tag above with the changed library (Bun's build pins WebKit and TinyCC to the revisions named, in
`scripts/build/deps/`), then run the `Dockerfile`'s `bun build --compile` step with that Bun.

## A written offer

For three years after the last image or executable built from a given commit was published, anyone who received
it can ask for a copy of the source of the parts in the table above, at the revisions named, by opening an issue in
<https://github.com/endqwerty/mainworthy/issues>. It is given at no more than the cost of making and sending the
copy. The links above are public and are expected to stay so; this offer covers the case that one of them does not.

## What the owner accepted on 2026-10-23

The Bun audit left these items open (`licences/README.md`). The owner accepted distributing the image and the
executable with them as they are:

- **domain-browser 4.23.0 is under Artistic-2.0**, though Bun's table calls it MIT. It ships unchanged, with its
  licence text in `THIRD-PARTY-NOTICES.md`, which Artistic-2.0 allows.
- **Bun's `LICENSE.md` says Bun is MIT-licensed but carries no MIT text or copyright line.** It is reproduced as
  Bun publishes it.
- **Two ports in Bun name no licence** (kprotty's channel and the wyhash port, `NOASSERTION`). Their originals
  could not be pinned. They stay listed as they are, and are looked at again when Bun is upgraded.
- **The released Bun binary was not inspected**; the list comes from Bun's source and build configuration. The
  next Bun upgrade's audit can compare the two.
