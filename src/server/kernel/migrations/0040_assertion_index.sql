-- Derived assertion presence. No raw failure payload or repeated runner try is copied into this index.
CREATE TABLE assertion_roots (
	project INTEGER NOT NULL REFERENCES projects(id),
	signature INTEGER PRIMARY KEY REFERENCES signatures(id),
	root INTEGER NOT NULL REFERENCES signatures(id)
) STRICT;
CREATE INDEX assertion_roots_project ON assertion_roots(project);
CREATE INDEX assertion_roots_root ON assertion_roots(root);
CREATE TABLE assertion_seen (
	project INTEGER NOT NULL REFERENCES projects(id),
	scope TEXT NOT NULL,
	root INTEGER NOT NULL REFERENCES signatures(id),
	test INTEGER NOT NULL REFERENCES tests(id),
	file TEXT,
	PRIMARY KEY(project, scope, root, test)
) STRICT;
CREATE INDEX assertion_seen_files ON assertion_seen(project, scope, root, file, test);
CREATE INDEX assertion_seen_root ON assertion_seen(root);
CREATE INDEX assertion_seen_test ON assertion_seen(test);
CREATE TABLE assertion_spreads (
	project INTEGER NOT NULL REFERENCES projects(id),
	scope TEXT NOT NULL,
	root INTEGER NOT NULL REFERENCES signatures(id),
	PRIMARY KEY(project, scope, root)
) STRICT;
CREATE INDEX assertion_spreads_root ON assertion_spreads(root);
CREATE TABLE assertion_index (
	project INTEGER PRIMARY KEY REFERENCES projects(id)
) STRICT;

-- Keyset reconstruction must not walk another project's results.
CREATE INDEX results_assertion_rebuild ON results(project, id);
