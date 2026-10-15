-- An explicit CI declaration, distinct from a report whose results were all refused.
ALTER TABLE batches ADD COLUMN nothing_required INTEGER NOT NULL DEFAULT 0 CHECK (nothing_required IN (0, 1));
