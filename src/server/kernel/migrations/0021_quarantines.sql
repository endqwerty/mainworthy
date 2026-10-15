CREATE TABLE quarantines (
 project INTEGER NOT NULL REFERENCES projects (id),
 test INTEGER NOT NULL REFERENCES tests (id),
 decision INTEGER NOT NULL REFERENCES decisions (id),
 actor INTEGER NOT NULL REFERENCES actors (id),
 reason TEXT NOT NULL,
 exit_rule TEXT,
 at INTEGER NOT NULL,
 seq INTEGER NOT NULL,
 PRIMARY KEY (project, test)
) STRICT, WITHOUT ROWID;
