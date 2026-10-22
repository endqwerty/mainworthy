-- An internal decision records a gate read when a merge was reported. It neither approves the merge nor answers
-- a queue question. Like change_ends, these observations do not travel in an archive: imported changes are open.
CREATE TABLE merge_receipts (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	change INTEGER NOT NULL REFERENCES changes (id),
	actor INTEGER NOT NULL REFERENCES actors (id),
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
) STRICT;
CREATE INDEX merge_receipts_change ON merge_receipts (change, id);
CREATE INDEX merge_receipts_project ON merge_receipts (project, seq);
ALTER TABLE change_ends ADD COLUMN receipt INTEGER REFERENCES merge_receipts (id);
CREATE INDEX change_ends_receipt ON change_ends (receipt);
