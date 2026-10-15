-- Scope transfers keep their source, destination and reporter without rewriting the decisions given there.
CREATE TABLE scope_moves (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	what TEXT NOT NULL,
	before_scope TEXT NOT NULL,
	after_scope TEXT NOT NULL,
	actor INTEGER NOT NULL REFERENCES actors (id),
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL
) STRICT;
