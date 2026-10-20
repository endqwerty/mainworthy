ALTER TABLE projects ADD COLUMN identity TEXT NOT NULL DEFAULT '';
UPDATE projects SET identity = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX projects_identity ON projects(identity);
