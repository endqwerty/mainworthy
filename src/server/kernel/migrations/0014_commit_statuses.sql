CREATE TABLE commit_statuses (
	project INTEGER NOT NULL REFERENCES projects(id),
	repository TEXT NOT NULL,
	commit_sha TEXT NOT NULL,
	nonce TEXT NOT NULL UNIQUE,
	desired TEXT NOT NULL,
	sent TEXT,
	state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'complete', 'stopped')),
	attempts INTEGER NOT NULL DEFAULT 0,
	next_at INTEGER NOT NULL,
	watch_until INTEGER NOT NULL,
	error TEXT,
	PRIMARY KEY (project, repository, commit_sha)
);
CREATE INDEX commit_statuses_watch ON commit_statuses(project, repository, state, watch_until);

CREATE TABLE commit_status_delivery (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	posts TEXT NOT NULL,
	pause_until INTEGER NOT NULL,
	failures INTEGER NOT NULL
);
