CREATE TABLE artifacts (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	digest TEXT NOT NULL,
	code TEXT NOT NULL,
	actor INTEGER NOT NULL REFERENCES actors (id),
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	UNIQUE (project, digest)
) STRICT;

CREATE TABLE builds (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	label TEXT NOT NULL,
	artifact INTEGER NOT NULL REFERENCES artifacts (id),
	seq INTEGER NOT NULL,
	UNIQUE (project, label)
) STRICT;

CREATE TABLE deployments (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	build INTEGER NOT NULL REFERENCES builds (id),
	env TEXT NOT NULL,
	actor INTEGER NOT NULL REFERENCES actors (id),
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL
) STRICT;
CREATE INDEX deployments_project ON deployments (project, id);
