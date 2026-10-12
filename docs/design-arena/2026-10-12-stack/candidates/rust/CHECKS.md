# Rust arena acceptance checks, recorded before implementation

Run each workload through a real loopback HTTP listener with persistent clients in both stores. Record latency distributions, sample counts, errors, and internal query/transaction time. Use release builds, SQLite WAL/NORMAL, PostgreSQL synchronous_commit=on, prepared statements and bounded pools.

- W1: returned ref matches input and head version contains structured body.
- W2: ordered page of <=50 cases after cursor, leaf folder matches; linked test glyphs include latest outcome; count agrees with queue.
- W3: <=50 relevance-ranked scoped hits, all AND words matched; area-filtered hits have folders within its 24 leaves.
- W4: transaction adds exactly one command/version/question/decision, advances seq once, updates head/hash/title/FTS; replay 20 commands returns identical receipt and changes no counts or seq.
- W5: exactly 10,000 results per fresh report, 100 new tests, 200 failures with 20 signatures including 10 new; basis/head version checked for linked and unlinked tests, signatures deduplicated, only one open question per fingerprint, run tally exact; batch replay changes no rows or sequence.
- W5a: parse 10,000 XML cases with exactly 200 failures and decoded messages.
- W6/W7/W8: correct test and descending last 20; correct commit; 50 open questions plus accurate index count/evidence.
- W9: 16 read clients plus ingest and save, each validates outputs and counts errors; finite 20 second mixed run.
- Registry: one declaration produces the three typed HTTP operations/OpenAPI 3.1, rmcp tools/list/tools/call, and CLI help. Invalid input is rejected. SDK handshake transcript saved.
- Cold start: five process starts to successful HTTP responses. RSS/artifact size/dependencies/clean and incremental builds measured.
- run.sh: resets only work.db/cb_rust, runs unattended and writes results.json in <10 minutes.
- Read-only independent verifier reviews final source and runs real checks; otherwise explicitly mark unverified.

Independent review follow-up checks:
- Disconnect a PostgreSQL write while blocked on the project row. It must finish or roll back and return the connection without an open transaction.
- Empty/truncated/non-XML JUnit is rejected; valid entity and CDATA messages preserve bytes.
- MCP and CLI reject workload-only names absent from the registry.
- A passing result with an informational message creates no signature or failure question.
- Record WAL peak size and generator CPU during W9; report checkpoint limitations and writer queuing honestly.
