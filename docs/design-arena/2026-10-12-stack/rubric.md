# Stack arena: rubric (judge only; candidates did not see this)

Score each criterion 1 to 5 for each candidate (ts, go, rust) with one or two sentences of evidence you checked yourself.

1. **Budgets, honestly measured.** Does the stack meet the budgets in SPEC.md in embedded and server mode? Are errors counted, is the work proven to have happened, is the limiter of each close or missed budget named from measurement? Re-run each candidate's `run.sh` yourself, one at a time (never two at once), and use your numbers, not theirs. Note the machine is shared with other work, so say how noisy your runs were.
2. **One operation layer.** How good is the registry proof: one declaration to HTTP + OpenAPI 3.1 + MCP (maintained SDK, real `tools/list`) + CLI help? What does a fourth operation cost? How much is generated versus hand-synced?
3. **Shared logic with the web UI.** The UI is a keyboard-first TypeScript app that must run the same pure logic as the server on every keystroke (outline grammar for capture and paste, canonical Markdown print and parse, step-level diff, three-way merge, the verdict function) and share the operation input and output types. What does each stack cost here per change: nothing, code generation, WASM, or duplication that can drift?
4. **Agents write most of the code.** An agent sees only the files it opened, copies the nearest example and takes the shortest path that compiles. In which stack does "compiles" most nearly mean "right" for this design (branded ids, exhaustive question kinds, a decision witness that only one module can mint, discriminated unions for answers and edits)? What does an agent get wrong in each?
5. **Deploy and operate.** First deployment: one container on a home server (Coolify on Unraid), one owner. Later: a hosted tier on AWS or GCP and "any number of users and teams". Artifact size, cold start, memory, build time, and how the Local, Server and Cloud layers of docs/decisions/0002-layered-self-hosting.md would work.
6. **Decidedly better?** The owner knows TypeScript best, Python well, Go a little, and said: "if another language is decidedly better, we want to use the correct language rather than what I know". Is any candidate decidedly better than TypeScript for THIS product, on evidence? "Faster on a microbenchmark that is already 20x inside its budget" is not decidedly better; a budget the others miss, or a class of defect one stack rules out, is.

Then answer, each with your reasons and what would change your mind:

A. Which stack should Mainworthy be built on?
B. Store strategy, given the measurements: (1) SQLite only for now, for the Local and Server layers, with Postgres added only when one organisation needs several instances; (2) SQLite and Postgres both supported from the first version behind one store interface; (3) Postgres only, with an embedded Postgres (PGlite) for Local. Consider that domain code over an in-process SQLite can be synchronous and transactional with no connection pool, while Postgres makes every store call asynchronous.
C. If TypeScript: Bun or Node as the runtime, on the evidence in the ts candidate's report?
D. The single biggest risk in your recommendation and the cheapest test that would expose it early.
