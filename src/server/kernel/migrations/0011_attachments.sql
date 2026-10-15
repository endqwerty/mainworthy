CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  result INTEGER NOT NULL REFERENCES results(id),
  name TEXT NOT NULL,
  hash TEXT NOT NULL CHECK(length(hash) = 64),
  size INTEGER NOT NULL CHECK(size >= 0 AND size <= 4194304),
  type TEXT NOT NULL,
  at TEXT
);
CREATE INDEX attachments_result ON attachments(result, id);
