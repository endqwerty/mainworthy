CREATE TABLE mail_contacts (
	actor INTEGER PRIMARY KEY REFERENCES actors(id),
	email TEXT NOT NULL UNIQUE,
	verified_at INTEGER,
	revision TEXT NOT NULL
);
