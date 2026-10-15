CREATE TABLE teams (
	id INTEGER PRIMARY KEY,
	org INTEGER NOT NULL REFERENCES orgs (id),
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (org, name)
) STRICT;

CREATE TABLE team_members (
	team INTEGER NOT NULL REFERENCES teams (id),
	actor INTEGER NOT NULL REFERENCES actors (id),
	PRIMARY KEY (team, actor)
) STRICT, WITHOUT ROWID;
CREATE INDEX team_members_actor ON team_members (actor, team);

CREATE TABLE team_grants (
	team INTEGER NOT NULL REFERENCES teams (id),
	project INTEGER NOT NULL DEFAULT 0,
	can TEXT NOT NULL,
	PRIMARY KEY (team, project)
) STRICT, WITHOUT ROWID;

CREATE TABLE team_events (
	id INTEGER PRIMARY KEY,
	team INTEGER NOT NULL REFERENCES teams (id),
	by_actor INTEGER NOT NULL REFERENCES actors (id),
	at INTEGER NOT NULL,
	action TEXT NOT NULL CHECK (action IN ('created', 'member.add', 'member.remove', 'grant.set', 'grant.remove')),
	person INTEGER REFERENCES actors (id),
	project INTEGER,
	can TEXT
) STRICT;
CREATE INDEX team_events_team ON team_events (team, id);
