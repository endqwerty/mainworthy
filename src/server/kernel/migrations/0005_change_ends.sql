-- A change ends: its pull request was merged, or closed without merging (decision 0022). Whoever reports for the
-- change says so, a pipeline or a person, like where its head is. A row while the change is ended, none while it
-- is open: a pull request opened again loses its row. An ended change is not asked about.
--
-- An archive leaves the table out (`UNEXPORTED`): exported, it would raise the archive version and refuse every
-- archive taken before it. A change that arrives in an archive is open.
CREATE TABLE change_ends (
	change INTEGER PRIMARY KEY REFERENCES changes (id),
	ended TEXT NOT NULL CHECK (ended IN ('merged', 'closed')),
	at INTEGER NOT NULL
) STRICT;
