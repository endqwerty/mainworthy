-- What a browser holds instead of a token. The cookie carries 32 random bytes; only their SHA-256 is stored.
CREATE TABLE sessions (
	id INTEGER PRIMARY KEY,
	actor INTEGER NOT NULL REFERENCES actors (id),
	hash TEXT NOT NULL UNIQUE,
	-- The token that opened it. While this is set the session lives only as long as that token does.
	token INTEGER REFERENCES tokens (id),
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	user_agent TEXT,
	ended_at INTEGER,
	-- signed-out: its browser signed out. ended: somebody ended it from a list. forgotten: its actor was
	-- forgotten. expired: it passed its idle or its absolute lifetime, and a clock set back does not revive it.
	ended_why TEXT CHECK (ended_why IN ('signed-out', 'ended', 'forgotten', 'expired'))
) STRICT;
CREATE INDEX sessions_actor ON sessions (actor, ended_at);
