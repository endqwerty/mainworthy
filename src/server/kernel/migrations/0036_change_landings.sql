-- A PR head is not proof of a landing. Earlier ends keep NULL; only received landing metadata can name one.
-- Ends, including their landings, stay out of archives: an imported change is open (decision 0022).
ALTER TABLE change_ends ADD COLUMN landing_commit TEXT;
ALTER TABLE change_ends ADD COLUMN landing_repo TEXT;
ALTER TABLE change_ends ADD COLUMN landing_branch TEXT CHECK (
	(landing_commit IS NULL AND landing_repo IS NULL AND landing_branch IS NULL)
	OR (ended = 'merged' AND landing_commit IS NOT NULL AND landing_branch IS NOT NULL AND landing_branch IN ('main', 'master', 'trunk'))
);
CREATE INDEX change_ends_landing ON change_ends (landing_commit, landing_repo, landing_branch) WHERE ended = 'merged';
