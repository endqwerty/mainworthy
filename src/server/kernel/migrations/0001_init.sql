-- Casebook schema, version 1.
--
-- Conventions
--   * Table names are plural. Ids are integers; the public id of a thing is its ref (C-311, Q-12, R-4, T-1904,
--     P-880), built from `no`, which is unique per project and never reused.
--   * Times are integer milliseconds since the Unix epoch, UTC.
--   * JSON is stored as TEXT. The shape of every JSON column is a schema in src/core.
--   * `seq` is the project's logical clock: assigned in commit order, no gaps. `rev` is the seq of the last change
--     to a row, so "changed since S" is one range read.
--   * Facts are append-only. Columns marked STANDING change only through a decision's effect (decision 0008).
--   * Every KEY named in docs/product-design.md section 6 that an access pattern needs is an index here.

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT, WITHOUT ROWID;

-- ── Identity ────────────────────────────────────────────────────────────────────────────────────────────────

-- One row today. It exists so a hosted tier can hold many organisations without a migration of every table.
CREATE TABLE orgs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;

-- A person, an agent, a pipeline or a rule. There is no seat or licence anywhere in this schema.
CREATE TABLE actors (
	id INTEGER PRIMARY KEY,
	org INTEGER NOT NULL REFERENCES orgs (id),
	kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'ci', 'rule')),
	name TEXT NOT NULL,
	on_behalf_of INTEGER REFERENCES actors (id),
	created_at INTEGER NOT NULL,
	disabled_at INTEGER,
	UNIQUE (org, name)
) STRICT;

-- project = 0 grants the capabilities on every project of the actor's organisation.
CREATE TABLE grants (
	actor INTEGER NOT NULL REFERENCES actors (id),
	project INTEGER NOT NULL DEFAULT 0,
	can TEXT NOT NULL,
	PRIMARY KEY (actor, project)
) STRICT, WITHOUT ROWID;

-- Only the SHA-256 of a token is stored. The secret is shown once, when it is created.
CREATE TABLE tokens (
	id INTEGER PRIMARY KEY,
	actor INTEGER NOT NULL REFERENCES actors (id),
	hash TEXT NOT NULL UNIQUE,
	label TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER,
	revoked_at INTEGER
) STRICT;

-- ── Kernel ──────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE projects (
	id INTEGER PRIMARY KEY,
	org INTEGER NOT NULL REFERENCES orgs (id),
	key TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	seq INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
) STRICT;

-- The next `no` per kind of ref, per project.
CREATE TABLE counters (
	project INTEGER NOT NULL,
	name TEXT NOT NULL,
	value INTEGER NOT NULL,
	PRIMARY KEY (project, name)
) STRICT, WITHOUT ROWID;

-- Every write is one command. A retry with the same id returns `outcome` and writes nothing.
-- project = 0 for the few operations that are not about a project (creating one, issuing a token).
CREATE TABLE commands (
	id TEXT PRIMARY KEY,
	project INTEGER NOT NULL,
	op TEXT NOT NULL,
	actor INTEGER NOT NULL,
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	touched TEXT NOT NULL,
	outcome TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX commands_seq ON commands (project, seq);

-- ── Suite: what should be true ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE folders (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	parent INTEGER REFERENCES folders (id),
	name TEXT NOT NULL,
	rank TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
	rev INTEGER NOT NULL
) STRICT;
CREATE INDEX folders_tree ON folders (project, parent, rank);

CREATE TABLE cases (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	no INTEGER NOT NULL,
	-- STANDING, written only by the effect of an `adopt` decision:
	head INTEGER NOT NULL,
	head_hash TEXT NOT NULL,
	claim_hash TEXT NOT NULL,
	title TEXT NOT NULL,          -- copies of head.body fields, so a list page needs no body
	methods TEXT NOT NULL,
	automate TEXT NOT NULL,
	step_count INTEGER NOT NULL,
	folder INTEGER NOT NULL REFERENCES folders (id),
	rank TEXT NOT NULL,
	tags TEXT NOT NULL DEFAULT '[]',
	state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
	aliases TEXT NOT NULL DEFAULT '[]',
	created_by INTEGER NOT NULL REFERENCES actors (id),
	created_at INTEGER NOT NULL,
	updated_by INTEGER NOT NULL REFERENCES actors (id),
	updated_at INTEGER NOT NULL,
	rev INTEGER NOT NULL,
	UNIQUE (project, no)
) STRICT;
CREATE INDEX cases_folder ON cases (project, folder, rank);
CREATE INDEX cases_rev ON cases (project, rev);

CREATE TABLE case_tags (
	project INTEGER NOT NULL,
	tag TEXT NOT NULL,
	case_id INTEGER NOT NULL REFERENCES cases (id),
	PRIMARY KEY (project, tag, case_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX case_tags_case ON case_tags (case_id);

-- A foreign id a case still answers to (TestRail's C1234 after an import).
CREATE TABLE case_aliases (
	project INTEGER NOT NULL,
	alias TEXT NOT NULL,
	case_id INTEGER NOT NULL REFERENCES cases (id),
	PRIMARY KEY (project, alias)
) STRICT, WITHOUT ROWID;

-- Immutable. A version exists only for content that a decision adopted.
CREATE TABLE versions (
	case_id INTEGER NOT NULL REFERENCES cases (id),
	no INTEGER NOT NULL,
	parent INTEGER,
	body TEXT NOT NULL,
	hash TEXT NOT NULL,
	claim_hash TEXT NOT NULL,
	proposal INTEGER NOT NULL,
	decision INTEGER NOT NULL,
	author INTEGER NOT NULL REFERENCES actors (id),
	reason TEXT,
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	PRIMARY KEY (case_id, no)
) STRICT, WITHOUT ROWID;

-- A move, a retag, an archive: history, but not a new version.
CREATE TABLE placements (
	id INTEGER PRIMARY KEY,
	case_id INTEGER NOT NULL REFERENCES cases (id),
	before TEXT NOT NULL,
	after TEXT NOT NULL,
	proposal INTEGER NOT NULL,
	decision INTEGER NOT NULL,
	actor INTEGER NOT NULL REFERENCES actors (id),
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL
) STRICT;
CREATE INDEX placements_case ON placements (case_id, seq);

-- A sealed set of edits. Saving a case and proposing a change are the same row.
CREATE TABLE proposals (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	no INTEGER NOT NULL,
	author INTEGER NOT NULL REFERENCES actors (id),
	reason TEXT,
	edits TEXT NOT NULL,
	-- what the edits resolved to when sealed: created case ids, merged bodies, conflicts. JSON.
	resolved TEXT NOT NULL,
	cause TEXT,
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	UNIQUE (project, no)
) STRICT;

-- Full-text index of the current version of every case. rowid = cases.id. Replaced by the adopt effect in the
-- transaction that moves the head.
CREATE VIRTUAL TABLE search_docs USING fts5 (
	title, body, tags, project UNINDEXED,
	tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
);

CREATE TABLE requirements (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	key TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	source TEXT,
	state TEXT NOT NULL DEFAULT 'active',
	rev INTEGER NOT NULL,
	UNIQUE (project, key)
) STRICT;

-- STANDING (adopt).
CREATE TABLE covers (
	requirement INTEGER NOT NULL REFERENCES requirements (id),
	case_id INTEGER NOT NULL REFERENCES cases (id),
	decision INTEGER NOT NULL,
	PRIMARY KEY (requirement, case_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX covers_case ON covers (case_id);

-- ── Evidence: what was observed ─────────────────────────────────────────────────────────────────────────────

-- A thing that produces results: an automated test (key = normalised "file::suite::name") or the manual
-- execution of a case (key = "case:<id>"). It exists with or without a case.
CREATE TABLE tests (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	no INTEGER NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('manual', 'auto')),
	key TEXT NOT NULL,
	name TEXT NOT NULL,
	file TEXT,
	case_id INTEGER REFERENCES cases (id),   -- STANDING (map)
	first_seq INTEGER NOT NULL,
	last_seq INTEGER NOT NULL,
	UNIQUE (project, key),
	UNIQUE (project, no)
) STRICT;
CREATE INDEX tests_case ON tests (project, case_id);
CREATE INDEX tests_file ON tests (project, file);

-- What was tested. `what` is "code:<repo>@<commit>" or "session:<name>"; a session proves nothing about a build.
CREATE TABLE targets (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	what TEXT NOT NULL,
	env TEXT NOT NULL DEFAULT '',
	repo TEXT,
	commit_sha TEXT,
	branch TEXT,
	line TEXT NOT NULL CHECK (line IN ('trunk', 'change', 'release', 'session')),
	change INTEGER,
	first_seq INTEGER NOT NULL,
	UNIQUE (project, what, env)
) STRICT;
CREATE INDEX targets_commit ON targets (project, commit_sha);

-- A pull request or a bare commit: where cases and code meet.
CREATE TABLE changes (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	key TEXT NOT NULL,
	repo TEXT,
	base_sha TEXT,
	head_sha TEXT,
	branch TEXT,
	title TEXT,
	url TEXT,
	files TEXT NOT NULL DEFAULT '[]',
	rev INTEGER NOT NULL,
	UNIQUE (project, key)
) STRICT;

-- One upload, or one keypress. `key` makes the same report twice a no-op. `staged` holds the normalised results
-- from acceptance until they are applied, so a crash between the two loses nothing.
CREATE TABLE batches (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	key TEXT NOT NULL,
	target INTEGER NOT NULL REFERENCES targets (id),
	job TEXT NOT NULL DEFAULT '',
	attempt INTEGER NOT NULL DEFAULT 1,
	method TEXT NOT NULL CHECK (method IN ('human', 'auto', 'agent')),
	actor INTEGER NOT NULL REFERENCES actors (id),
	run INTEGER,
	build_url TEXT,
	state TEXT NOT NULL CHECK (state IN ('accepted', 'processed')),
	counts TEXT NOT NULL,
	staged TEXT,
	receipt TEXT,
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	UNIQUE (project, key)
) STRICT;
CREATE INDEX batches_accepted ON batches (project, state) WHERE state = 'accepted';
CREATE INDEX batches_target ON batches (target, seq);

-- One cause of failure: the class plus the normalised message.
CREATE TABLE signatures (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	hash TEXT NOT NULL,
	class TEXT NOT NULL CHECK (class IN ('assertion', 'timeout', 'infra')),
	text TEXT NOT NULL,
	first_seq INTEGER NOT NULL,
	UNIQUE (project, hash)
) STRICT;

CREATE TABLE results (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL,
	test INTEGER NOT NULL REFERENCES tests (id),
	seq INTEGER NOT NULL,
	ord INTEGER NOT NULL,
	batch INTEGER NOT NULL REFERENCES batches (id),
	target INTEGER NOT NULL REFERENCES targets (id),
	method TEXT NOT NULL,
	actor INTEGER NOT NULL,
	-- What this result proves: exact (a pinned slot, a manifest or an annotation), assumed (the case's head at
	-- ingest, recorded as an assumption) or unresolved (no case; history only).
	basis TEXT NOT NULL CHECK (basis IN ('exact', 'assumed', 'unresolved')),
	basis_case INTEGER,
	basis_version INTEGER,
	basis_claim TEXT,
	outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'skip', 'blocked', 'error')),
	attempt INTEGER NOT NULL DEFAULT 1,
	duration_ms INTEGER,
	signature INTEGER REFERENCES signatures (id),
	message TEXT,
	detail TEXT,
	at_step TEXT,
	steps TEXT,
	note TEXT,
	run INTEGER,
	corrects INTEGER REFERENCES results (id),
	at INTEGER NOT NULL
) STRICT;
CREATE INDEX results_test ON results (project, test, seq DESC, ord DESC);
CREATE INDEX results_batch ON results (batch, outcome);
CREATE INDEX results_target ON results (target, test, attempt);
CREATE INDEX results_signature ON results (project, signature, seq DESC) WHERE signature IS NOT NULL;
CREATE INDEX results_case ON results (basis_case, method, seq DESC) WHERE basis_case IS NOT NULL;
CREATE INDEX results_corrects ON results (corrects) WHERE corrects IS NOT NULL;

-- The same test with different outcomes on the same code: the strongest flaky signal. Recorded on ingest.
CREATE TABLE flips (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL,
	test INTEGER NOT NULL REFERENCES tests (id),
	target INTEGER NOT NULL REFERENCES targets (id),
	first_result INTEGER NOT NULL,
	second_result INTEGER NOT NULL,
	seq INTEGER NOT NULL
) STRICT;
CREATE INDEX flips_test ON flips (project, test, seq DESC);

-- What a reviewer (an agent or a person) found. Evidence of review; never a runtime pass.
CREATE TABLE findings (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	actor INTEGER NOT NULL REFERENCES actors (id),
	lens TEXT NOT NULL,
	locus TEXT NOT NULL,
	case_id INTEGER REFERENCES cases (id),
	category TEXT NOT NULL,
	note TEXT NOT NULL,
	repro TEXT,
	suggest TEXT,
	basis TEXT NOT NULL,
	question INTEGER,
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL
) STRICT;
CREATE INDEX findings_case ON findings (case_id, seq DESC);

-- "This reviewer looked at this case at this basis with this lens." A review with no findings still writes one.
CREATE TABLE reviews (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	reviewer INTEGER NOT NULL REFERENCES actors (id),
	lens TEXT NOT NULL,
	case_id INTEGER NOT NULL REFERENCES cases (id),
	version INTEGER NOT NULL,
	basis TEXT NOT NULL,
	about TEXT,
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	UNIQUE (case_id, basis, lens, reviewer)
) STRICT;

-- STANDING (failure): this cause is answered in this scope ("line:trunk", "change:<id>", "run:<id>").
CREATE TABLE excuses (
	project INTEGER NOT NULL,
	signature INTEGER NOT NULL REFERENCES signatures (id),
	scope TEXT NOT NULL,
	decision INTEGER NOT NULL,
	class TEXT NOT NULL CHECK (class IN ('attributed', 'excused')),
	expires_at INTEGER,
	PRIMARY KEY (project, signature, scope)
) STRICT, WITHOUT ROWID;

-- ── Decisions: the queue, the ledger and the policy ─────────────────────────────────────────────────────────

CREATE TABLE questions (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	no INTEGER NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('adopt', 'map', 'failure', 'finding', 'signoff')),
	subject TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	epoch INTEGER NOT NULL DEFAULT 0,
	prior INTEGER REFERENCES questions (id),
	title TEXT NOT NULL,
	producer TEXT NOT NULL CHECK (producer IN ('human', 'agent', 'ci', 'rule')),
	evidence TEXT NOT NULL,
	evidence_hash TEXT NOT NULL,
	seen_count INTEGER NOT NULL DEFAULT 1,
	seen_first INTEGER NOT NULL,
	seen_last INTEGER NOT NULL,
	carried INTEGER NOT NULL DEFAULT 0,
	ask TEXT NOT NULL,
	blocks TEXT NOT NULL,
	owner INTEGER NOT NULL DEFAULT 0,
	rank INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('open', 'decided', 'dissolved')),
	decision INTEGER,
	opened_at INTEGER NOT NULL,
	rev INTEGER NOT NULL,
	UNIQUE (project, no)
) STRICT;
CREATE INDEX questions_fingerprint ON questions (project, fingerprint, epoch DESC);
CREATE INDEX questions_queue ON questions (project, state, owner, rank);
CREATE INDEX questions_rev ON questions (project, rev);

-- Which things a question is about, so a case, a run, a test or a change can list its questions.
CREATE TABLE question_refs (
	project INTEGER NOT NULL,
	ref TEXT NOT NULL,
	question INTEGER NOT NULL REFERENCES questions (id),
	PRIMARY KEY (project, ref, question)
) STRICT, WITHOUT ROWID;

-- Append-only. An answer names the evidence it was given on; `counts` says whether policy counted it or took
-- it as advice.
CREATE TABLE answers (
	id INTEGER PRIMARY KEY,
	question INTEGER NOT NULL REFERENCES questions (id),
	actor INTEGER NOT NULL REFERENCES actors (id),
	answer TEXT NOT NULL,
	reason TEXT,
	on_evidence TEXT NOT NULL,
	counts INTEGER NOT NULL,
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL
) STRICT;
CREATE INDEX answers_question ON answers (question, id);

-- The ledger. Never edited: a change of mind is a new decision that supersedes this one.
CREATE TABLE decisions (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	question INTEGER NOT NULL REFERENCES questions (id),
	kind TEXT NOT NULL,
	answer TEXT NOT NULL,
	signers TEXT NOT NULL,
	basis TEXT NOT NULL,
	holds TEXT NOT NULL,
	expires_at INTEGER,
	supersedes INTEGER REFERENCES decisions (id),
	effects TEXT NOT NULL DEFAULT '{}',
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL
) STRICT;
CREATE INDEX decisions_question ON decisions (question, id);
CREATE INDEX decisions_seq ON decisions (project, seq);
CREATE INDEX decisions_expiry ON decisions (project, expires_at) WHERE expires_at IS NOT NULL;

-- The policy is a clause table. Each change is a new version; the highest version is in force.
CREATE TABLE policies (
	project INTEGER NOT NULL REFERENCES projects (id),
	version INTEGER NOT NULL,
	preset TEXT NOT NULL,
	clauses TEXT NOT NULL,
	settings TEXT NOT NULL,
	actor INTEGER NOT NULL,
	decision INTEGER,
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	PRIMARY KEY (project, version)
) STRICT, WITHOUT ROWID;

-- ── Runs: a request for evidence ────────────────────────────────────────────────────────────────────────────

CREATE TABLE runs (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	no INTEGER NOT NULL,
	name TEXT NOT NULL,
	origin TEXT NOT NULL CHECK (origin IN ('change', 'planned')),
	accepts TEXT NOT NULL,
	-- for a change run: the target's `what`, so the gate read by CI is one lookup
	accepts_what TEXT,
	require TEXT NOT NULL,
	change INTEGER REFERENCES changes (id),
	-- STANDING (signoff):
	state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
	signoff INTEGER,
	-- the horizon: an accepted upload is outstanding until it is applied, and the gate is pending meanwhile
	accepted_seq INTEGER NOT NULL DEFAULT 0,
	applied_seq INTEGER NOT NULL DEFAULT 0,
	outstanding INTEGER NOT NULL DEFAULT 0,
	next_expiry INTEGER,
	-- projections written only by the run fold:
	tally TEXT NOT NULL,
	blocking TEXT NOT NULL DEFAULT '[]',
	verdict TEXT NOT NULL CHECK (verdict IN ('passed', 'failed', 'blocked', 'pending')),
	created_by INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	rev INTEGER NOT NULL,
	UNIQUE (project, no)
) STRICT;
CREATE UNIQUE INDEX runs_change ON runs (project, accepts_what) WHERE origin = 'change';
CREATE INDEX runs_open ON runs (project, state, id DESC);

-- A change run counts tests: the effective (latest attempt) result of each test on the run's target.
CREATE TABLE run_tests (
	run INTEGER NOT NULL REFERENCES runs (id),
	test INTEGER NOT NULL REFERENCES tests (id),
	result INTEGER NOT NULL REFERENCES results (id),
	outcome TEXT NOT NULL,
	signature INTEGER,
	attempt INTEGER NOT NULL,
	flipped INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (run, test)
) STRICT, WITHOUT ROWID;
CREATE INDEX run_tests_outcome ON run_tests (run, outcome, signature);

-- A planned run counts slots: one per case and obligation, pinned to a version when the run starts.
CREATE TABLE slots (
	id INTEGER PRIMARY KEY,
	run INTEGER NOT NULL REFERENCES runs (id),
	case_id INTEGER NOT NULL REFERENCES cases (id),
	version INTEGER NOT NULL,
	claim TEXT NOT NULL,
	obligation TEXT NOT NULL,
	assignee INTEGER REFERENCES actors (id),
	rank INTEGER NOT NULL,
	-- per actor: passes, uncorrected fails, latest seq. Rebuilt from slot_results; never capped.
	agg TEXT NOT NULL DEFAULT '{}',
	state TEXT NOT NULL DEFAULT 'missing' CHECK (state IN ('missing', 'satisfied', 'failing', 'disputed', 'waived', 'skipped')),
	signature INTEGER,
	waiver INTEGER,
	rev INTEGER NOT NULL,
	UNIQUE (run, case_id, obligation)
) STRICT;
CREATE INDEX slots_rank ON slots (run, rank);
CREATE INDEX slots_next ON slots (run, state, rank);
CREATE INDEX slots_case ON slots (case_id, run);

-- Which results were admitted to which slots, and by which rule. One immutable result may fill several runs.
CREATE TABLE slot_results (
	slot INTEGER NOT NULL REFERENCES slots (id),
	result INTEGER NOT NULL REFERENCES results (id),
	run INTEGER NOT NULL,
	admitted TEXT NOT NULL CHECK (admitted IN ('exact', 'assumed', 'same-claim')),
	corrected INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (slot, result)
) STRICT, WITHOUT ROWID;
CREATE INDEX slot_results_result ON slot_results (result);

-- The decisions a run's verdict rests on, and when the earliest of them stops holding.
CREATE TABLE depends_on (
	run INTEGER NOT NULL REFERENCES runs (id),
	decision INTEGER NOT NULL REFERENCES decisions (id),
	expires_at INTEGER,
	PRIMARY KEY (run, decision)
) STRICT, WITHOUT ROWID;
CREATE INDEX depends_on_decision ON depends_on (decision);
