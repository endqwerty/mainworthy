-- Benchmark schema, PostgreSQL dialect. Same tables, keys and indexes as schema.sqlite.sql.
CREATE TABLE project (id BIGINT PRIMARY KEY, key TEXT NOT NULL UNIQUE, seq BIGINT NOT NULL DEFAULT 0);
CREATE TABLE folder (id BIGINT PRIMARY KEY, project BIGINT NOT NULL, parent BIGINT, name TEXT NOT NULL, rank BIGINT NOT NULL);
CREATE TABLE kase (
  id BIGINT PRIMARY KEY, project BIGINT NOT NULL, ref_no BIGINT NOT NULL, folder BIGINT NOT NULL, rank BIGINT NOT NULL,
  title TEXT NOT NULL, head_no INT NOT NULL, head_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', rev BIGINT NOT NULL
);
CREATE TABLE version (
  case_id BIGINT NOT NULL, no INT NOT NULL, parent INT, body TEXT NOT NULL, hash TEXT NOT NULL, claim_hash TEXT NOT NULL,
  seq BIGINT NOT NULL, PRIMARY KEY (case_id, no)
);
CREATE TABLE search_doc (case_id BIGINT PRIMARY KEY, project BIGINT NOT NULL, folder BIGINT NOT NULL, text TEXT NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED);
CREATE TABLE test (id BIGINT PRIMARY KEY, project BIGINT NOT NULL, key TEXT NOT NULL, case_id BIGINT, file TEXT);
CREATE TABLE target (id BIGINT PRIMARY KEY, project BIGINT NOT NULL, commit_sha TEXT NOT NULL, env TEXT NOT NULL);
CREATE TABLE batch (
  id BIGINT PRIMARY KEY, project BIGINT NOT NULL, key TEXT NOT NULL, target BIGINT NOT NULL, job TEXT NOT NULL,
  attempt INT NOT NULL, state TEXT NOT NULL, seq BIGINT NOT NULL
);
CREATE TABLE signature (id BIGINT PRIMARY KEY, project BIGINT NOT NULL, hash TEXT NOT NULL, class TEXT NOT NULL, sample TEXT NOT NULL);
CREATE TABLE result (
  id BIGINT PRIMARY KEY, project BIGINT NOT NULL, test BIGINT NOT NULL, seq BIGINT NOT NULL, ord INT NOT NULL,
  batch BIGINT NOT NULL, target BIGINT NOT NULL, outcome TEXT NOT NULL, basis TEXT NOT NULL, basis_case BIGINT,
  basis_version INT, duration_ms INT, signature BIGINT, message TEXT
);
CREATE TABLE question (
  id BIGINT PRIMARY KEY, project BIGINT NOT NULL, ref_no BIGINT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL,
  epoch INT NOT NULL DEFAULT 0, state TEXT NOT NULL, owner BIGINT NOT NULL DEFAULT 0, rank BIGINT NOT NULL,
  evidence TEXT NOT NULL, evidence_hash TEXT NOT NULL, rev BIGINT NOT NULL
);
CREATE TABLE decision (
  id BIGINT PRIMARY KEY, project BIGINT NOT NULL, question BIGINT NOT NULL, kind TEXT NOT NULL, answer TEXT NOT NULL,
  basis TEXT NOT NULL, seq BIGINT NOT NULL
);
CREATE TABLE command (id TEXT PRIMARY KEY, project BIGINT NOT NULL, op TEXT NOT NULL, actor BIGINT NOT NULL, seq BIGINT NOT NULL, outcome TEXT NOT NULL);
CREATE TABLE run (
  id BIGINT PRIMARY KEY, project BIGINT NOT NULL, commit_sha TEXT NOT NULL, verdict TEXT NOT NULL, tally TEXT NOT NULL,
  outstanding INT NOT NULL DEFAULT 0, next_expiry BIGINT, rev BIGINT NOT NULL
);
CREATE TABLE placement_history (id BIGINT PRIMARY KEY, case_id BIGINT NOT NULL, from_folder BIGINT NOT NULL, to_folder BIGINT NOT NULL, decision BIGINT NOT NULL, seq BIGINT NOT NULL);
-- indexes are created after the bulk load (schema.pg.indexes.sql)
