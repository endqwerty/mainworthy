CREATE TABLE tracker_requests (
	id TEXT PRIMARY KEY,
	nonce TEXT NOT NULL,
	project INTEGER NOT NULL REFERENCES projects(id),
	result INTEGER NOT NULL REFERENCES results(id),
	repository TEXT NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('create', 'link')),
	item_key TEXT,
	title TEXT NOT NULL,
	body TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'complete', 'failed')),
	issue TEXT,
	error TEXT,
	at INTEGER NOT NULL
) STRICT;
CREATE INDEX tracker_requests_queue ON tracker_requests(state, at);
