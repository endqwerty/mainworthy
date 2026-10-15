# Licence

Mainworthy is open source under the Apache License 2.0. This page says what the licence lets you do, what it asks of you when you pass Mainworthy on, and which software from others Mainworthy carries, with the licence of each.

## Mainworthy's licence

Copyright 2026 Daniel Yang. Mainworthy is licensed under the [Apache License 2.0](../../LICENSE). The licence covers all of it: the server, the web UI, the command line, the agent skill, the iPhone app and this documentation.

You may use Mainworthy for any purpose, change it, run it for others and sell it. The licence also grants you the authors' patents on what they contributed. When you give a copy to someone else, changed or not:

- include the [licence](../../LICENSE) and the [NOTICE](../../NOTICE) file;
- keep the copyright notices that are in the files;
- mark the files you changed.

The licence does not give you the name. You may say that your product is based on Mainworthy, but do not call it Mainworthy or make it look like the original.

Mainworthy comes with no warranty. Sections 7 and 8 of the licence say so in full.

## Software from others

Mainworthy contains software that other people wrote. Each part keeps its own licence, and those licences ask that their text travels with every copy. [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) holds the text of each, and every instance serves it.

| What | Where it ships | Licences |
| --- | --- | --- |
| npm packages: React, TanStack Query and Virtual, Zod, the MCP SDK, Ajv, @noble/hashes and the packages they need | the executable, and the web UI a browser loads | MIT, ISC, BSD-2-Clause, BSD-3-Clause, CC0-1.0 |
| The Bun runtime 1.4.3, with the libraries, Rust crates and packages it links | the executable: `bun build --compile` puts the runtime into it | Mostly MIT, BSD, Apache-2.0, ISC and Zlib; LGPL for JavaScriptCore, WebKit and TinyCC; MPL-2.0 for some CSS code and three Rust crates; GPL with a runtime exception for the compilers' runtime libraries; Artistic-2.0 for one npm package |
| Archify's viewer and the JetBrains Mono font | the diagrams on these pages | MIT, OFL-1.1 |

None of these licences limits the licence of Mainworthy's own code. Some ask more than keeping a notice:

- **LGPL** (JavaScriptCore, WebKit and TinyCC, inside Bun). You may replace the library with a version of your own and link the program again. Mainworthy's source is public, so you can build it with a Bun that you built yourself. The notices name the exact revision of each library and where its source is.
- **MPL-2.0** (CSS code in Bun that comes from Lightning CSS and Servo, the crates `cssparser`, `selectors` and `dtoa-short`, and Mozilla's list of root certificates). Those files stay under the MPL, and their source is public at the revisions the notices name.
- **GPL with a runtime library exception** (GCC's C++ runtime). The exception lets a compiled program use the library under the program's own licence. Bun also carries TinyCC's runtime source under the GPL with a linking exception.

## The iPhone app

The iPhone app contains only its own code and Apple's frameworks: no third-party library. Its copyright and licence are listed under **You**, **About**, with a link to this page on your instance. Apple delivers apps from the App Store under its standard licence agreement for apps. The app's source is under the Apache License 2.0, like the rest of Mainworthy.
