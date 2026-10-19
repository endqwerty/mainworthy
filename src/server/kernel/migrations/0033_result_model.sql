ALTER TABLE batches ADD COLUMN model TEXT CHECK (model IS NULL OR method = 'agent');
ALTER TABLE results ADD COLUMN model TEXT CHECK (model IS NULL OR method = 'agent');
