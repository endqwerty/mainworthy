CREATE TABLE result_excuses (
	result INTEGER PRIMARY KEY REFERENCES results (id),
	decision INTEGER NOT NULL REFERENCES decisions (id),
	class TEXT NOT NULL CHECK (class IN ('attributed', 'excused')),
	expires_at INTEGER
) STRICT;
CREATE INDEX result_excuses_decision ON result_excuses (decision);
CREATE INDEX changes_base ON changes (project, base_sha, repo);
