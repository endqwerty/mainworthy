CREATE TABLE handoffs (
	id TEXT PRIMARY KEY,
	nonce TEXT NOT NULL,
	project INTEGER NOT NULL REFERENCES projects(id),
	question INTEGER NOT NULL REFERENCES questions(id),
	body TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'failed')),
	error TEXT,
	at INTEGER NOT NULL
) STRICT;
CREATE INDEX handoffs_queue ON handoffs(state, at);
CREATE INDEX handoffs_question ON handoffs(question, at);
CREATE INDEX handoffs_project ON handoffs(project);
