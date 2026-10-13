-- What a token is allowed to be, and where a token and a session were used from.

-- When the token stops working. Null: never. It is refused from this moment on exactly as a revoked one is, and
-- nothing is written when the moment comes.
ALTER TABLE tokens ADD COLUMN expires_at INTEGER;
-- The actor that made the token. Null for the tokens a start makes, and for every token made before this column.
ALTER TABLE tokens ADD COLUMN created_by INTEGER REFERENCES actors (id);
-- Which start-up rule made the token. env: it is the value of MAINWORTHY_OWNER_TOKEN, and a start with another
-- value retires it. generated: a start made it because the owner held none. Null: somebody made it (token.create).
ALTER TABLE tokens ADD COLUMN source TEXT CHECK (source IN ('env', 'generated'));
-- The address of the last request that used the token, written with last_used_at.
ALTER TABLE tokens ADD COLUMN last_used_addr TEXT;
-- Until now the label was all that told the start-up tokens apart. The first pattern also matches the label of
-- the builds before the project was renamed, which named another variable.
UPDATE tokens SET source = 'env' WHERE label LIKE 'owner (from %';
UPDATE tokens SET source = 'generated' WHERE label = 'owner (generated)';
-- The address the session was opened from, and the address of the last request that used it, written with
-- last_seen_at. Null for a session opened before these columns.
ALTER TABLE sessions ADD COLUMN created_addr TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_addr TEXT;
