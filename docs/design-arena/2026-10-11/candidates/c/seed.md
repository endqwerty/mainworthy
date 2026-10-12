## Your seed lens (candidate C)

Start from this whole-shape idea and push it as far as it goes; abandon it only if you can show it breaks, and say so:

**Repository-centric ("tests as a versioned knowledge repo", bun/deno-style tooling first).** The suite is a versioned tree of plain, diffable documents (cases, shared steps, requirements, charters) that a single binary owns: `casebook` is a CLI and a server in one artifact, like `bun`. Automated test files, manual cases and agent charters are all documents in that tree, with links between them; the UI is a fast editor and dashboard over the same store, and the MCP server is the same operations exposed to agents. Branching/proposals of the suite follow the review policy; runs record evidence against a tree revision. Ask whether the tree should live next to the code (in git) or in Casebook's own store, and decide.
