-- Observations share immutable, content-addressed evidence. Each evidence item is bounded; memberships are paged.
CREATE TABLE merge_receipt_payloads (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	hash TEXT NOT NULL,
	body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 32768),
	UNIQUE (project, hash)
) STRICT;
CREATE TABLE merge_receipt_snapshots (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	hash TEXT NOT NULL,
	count INTEGER NOT NULL,
	evidence_count INTEGER NOT NULL,
	UNIQUE (project, hash)
) STRICT;
CREATE TABLE merge_receipt_members (
	snapshot INTEGER NOT NULL REFERENCES merge_receipt_snapshots (id),
	ordinal INTEGER NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('result', 'gate')),
	payload INTEGER NOT NULL REFERENCES merge_receipt_payloads (id),
	PRIMARY KEY (snapshot, ordinal)
) STRICT;
CREATE INDEX merge_receipt_members_kind ON merge_receipt_members (snapshot, kind, ordinal);
CREATE INDEX merge_receipt_members_payload ON merge_receipt_members (payload);
-- An internal decision records a gate read when a merge was reported. It neither approves the merge nor answers
-- a queue question. Like change_ends, these observations do not travel in an archive: imported changes are open.
CREATE TABLE merge_receipts (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	change INTEGER NOT NULL REFERENCES changes (id),
	actor INTEGER NOT NULL REFERENCES actors (id),
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	evidence INTEGER NOT NULL REFERENCES merge_receipt_snapshots (id),
	snapshot TEXT NOT NULL CHECK (json_valid(snapshot) AND length(CAST(snapshot AS BLOB)) <= 4096)
) STRICT;
CREATE INDEX merge_receipts_change ON merge_receipts (change, id);
CREATE INDEX merge_receipts_project ON merge_receipts (project, seq);
ALTER TABLE change_ends ADD COLUMN receipt INTEGER REFERENCES merge_receipts (id);
CREATE INDEX change_ends_receipt ON change_ends (receipt);

CREATE INDEX merge_receipts_evidence ON merge_receipts (evidence);
