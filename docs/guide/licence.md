# Licence

Mainworthy is open source under the Apache License 2.0. This page describes its terms and the licences of the software Mainworthy bundles.

## Mainworthy's licence

Mainworthy is licensed under the [Apache License 2.0](../../LICENSE), and its copyright notice is in [NOTICE](../../NOTICE). The licence covers Mainworthy's own code and documentation, including the server, the web UI, the command line and the agent skill. Material from others keeps its own licence, as listed below.

You may use Mainworthy for any purpose, change it, run it for others and sell it. Section 3 grants a patent licence for certain claims covered by contributors' work, subject to its conditions. When you give a copy to someone else, changed or not, do the following:

- Include the [licence](../../LICENSE) and the [NOTICE](../../NOTICE) file.
- Keep the copyright notices in the files.
- Mark the files you changed.

Section 6 gives no permission to use the name Mainworthy as a trademark beyond what is needed to describe where your copy came from.

Mainworthy comes with no warranty. Sections 7 and 8 of the licence say so in full.

## Software from others

Mainworthy bundles software and documentation from others under their own licences. [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) contains their licence texts and attributions, and every instance serves the notices file. The web UI names this page as its licence, and every documentation page links to it in the footer.

| What | Where it ships | Licences |
| --- | --- | --- |
| npm packages, including React, TanStack Query and Virtual, Zod, the MCP SDK, Ajv and @noble/hashes | the executable, with some also in the web UI | Apache-2.0, MIT, ISC, BSD-3-Clause, CC0-1.0 |
| The Bun 1.4.3 runtime, with the libraries, Rust crates and packages it links | the executable, compiled with `bun build --compile` | Mostly MIT, BSD, Apache-2.0, ISC, and Zlib. LGPL for JavaScriptCore, WebKit, and TinyCC. MPL-2.0 for some CSS code and three Rust crates. GPL with a runtime exception for the compilers' runtime libraries. Artistic-2.0 for one npm package. |
| Archify's viewer and the JetBrains Mono font | the diagrams on these pages, each with both licences | MIT, OFL-1.1 |
| Basecamp's policies | the adapted privacy policy | CC-BY-4.0 |

None of these licences limits the licence of Mainworthy's own code. Some licences have additional terms:

- **LGPL** covers JavaScriptCore, WebKit, and TinyCC inside Bun. You may replace the library with a version of your own and link the program again. Mainworthy's source is public, so you can build it with a Bun that you built yourself. The notices name each library's revision and source location.
- **MPL-2.0** covers CSS code in Bun from Lightning CSS and Servo, the crates `cssparser`, `selectors`, and `dtoa-short`, and Mozilla's list of root certificates. Those files stay under the MPL. Their source is public at the revisions named in the notices.
- **GPL with a runtime library exception** covers GCC's C++ runtime. The exception lets a compiled program use the library under the program's own licence. Bun also carries TinyCC's runtime source under the GPL with a linking exception.
