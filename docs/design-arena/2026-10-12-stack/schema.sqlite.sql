-- Benchmark schema, SQLite dialect. A representative subset of docs/product-design.md section 6.
-- Every KEY named in the design that a workload uses is an index here.
CREATE TABLE project (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL DEFAULT 0);
CREATE TABLE folder (id INTEGER PRIMARY KEY, project INTEGER NOT NULL, parent INTEGER, name TEXT NOT NULL, rank INTEGER NOT NULL);
CREATE TABLE kase (
  id INTEGER PRIMARY KEY, project INTEGER NOT NULL, ref_no INTEGER NOT NULL, folder INTEGER NOT NULL, rank INTEGER NOT NULL,
  title TEXT NOT NULL, head_no INTEGER NOT NULL, head_hash TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX kase_ref ON kase (project, ref_no);
CREATE INDEX kase_folder ON kase (project, folder, rank);
CREATE INDEX kase_rev ON kase (project, rev);
CREATE TABLE version (
  case_id INTEGER NOT NULL, no INTEGER NOT NULL, parent INTEGER, body TEXT NOT NULL, hash TEXT NOT NULL, claim_hash TEXT NOT NULL,
  seq INTEGER NOT NULL, PRIMARY KEY (case_id, no)
) WITHOUT ROWID;
CREATE VIRTUAL TABLE search_doc USING fts5 (text, project UNINDEXED, folder UNINDEXED, tokenize = 'unicode61');  -- rowid = kase.id
CREATE TABLE test (id INTEGER PRIMARY KEY, project INTEGER NOT NULL, key TEXT NOT NULL, case_id INTEGER, file TEXT);
CREATE UNIQUE INDEX test_key ON test (project, key);
CREATE INDEX test_case ON test (project, case_id);
CREATE INDEX test_file ON test (project, file);
CREATE TABLE target (id INTEGER PRIMARY KEY, project INTEGER NOT NULL, commit_sha TEXT NOT NULL, env TEXT NOT NULL);
CREATE UNIQUE INDEX target_what ON target (project, commit_sha, env);
CREATE TABLE batch (
  id INTEGER PRIMARY KEY, project INTEGER NOT NULL, key TEXT NOT NULL, target INTEGER NOT NULL, job TEXT NOT NULL,
  attempt INTEGER NOT NULL, state TEXT NOT NULL, seq INTEGER NOT NULL
);
CREATE UNIQUE INDEX batch_key ON batch (project, key);
CREATE TABLE signature (id INTEGER PRIMARY KEY, project INTEGER NOT NULL, hash TEXT NOT NULL, class TEXT NOT NULL, sample TEXT NOT NULL);
CREATE UNIQUE INDEX signature_hash ON signature (project, hash);
CREATE TABLE result (
  id INTEGER PRIMARY KEY, project INTEGER NOT NULL, test INTEGER NOT NULL, seq INTEGER NOT NULL, ord INTEGER NOT NULL,
  batch INTEGER NOT NULL, target INTEGER NOT NULL, outcome TEXT NOT NULL, basis TEXT NOT NULL, basis_case INTEGER,
  basis_version INTEGER, duration_ms INTEGER, signature INTEGER, message TEXT
);
CREATE INDEX result_test ON result (project, test, seq DESC, ord DESC);
CREATE INDEX result_batch ON result (project, batch, outcome);
CREATE INDEX result_target ON result (project, target, test);
CREATE INDEX result_signature ON result (project, signature, seq DESC) WHERE signature IS NOT NULL;
CREATE TABLE question (
  id INTEGER PRIMARY KEY, project INTEGER NOT NULL, ref_no INTEGER NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, owner INTEGER NOT NULL DEFAULT 0, rank INTEGER NOT NULL,
  evidence TEXT NOT NULL, evidence_hash TEXT NOT NULL, rev INTEGER NOT NULL
);
CREATE INDEX question_fp ON question (project, fingerprint, epoch DESC);
CREATE INDEX question_open ON question (project, state, owner, rank);
CREATE INDEX question_rev ON question (project, rev);
CREATE TABLE decision (
  id INTEGER PRIMARY KEY, project INTEGER NOT NULL, question INTEGER NOT NULL, kind TEXT NOT NULL, answer TEXT NOT NULL,
  basis TEXT NOT NULL, seq INTEGER NOT NULL
);
CREATE TABLE command (id TEXT PRIMARY KEY, project INTEGER NOT NULL, op TEXT NOT NULL, actor INTEGER NOT NULL, seq INTEGER NOT NULL, outcome TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX command_seq ON command (project, seq);
CREATE TABLE run (
  id INTEGER PRIMARY KEY, project INTEGER NOT NULL, commit_sha TEXT NOT NULL, verdict TEXT NOT NULL, tally TEXT NOT NULL,
  outstanding INTEGER NOT NULL DEFAULT 0, next_expiry INTEGER, rev INTEGER NOT NULL
);
CREATE UNIQUE INDEX run_commit ON run (project, commit_sha);
CREATE TABLE placement_history (id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, from_folder INTEGER NOT NULL, to_folder INTEGER NOT NULL, decision INTEGER NOT NULL, seq INTEGER NOT NULL);
