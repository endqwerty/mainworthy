-- A test runner's earlier tries of a result within one run, oldest first (decision 0129). The result is the runner's
-- last word and what a gate counts; a try is evidence only, read by the flaky signals and shown with the result.
CREATE TABLE result_tries (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL,
	result INTEGER NOT NULL REFERENCES results (id),
	try INTEGER NOT NULL,
	outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'skip', 'blocked', 'error')),
	duration_ms INTEGER,
	signature INTEGER REFERENCES signatures (id),
	message TEXT,
	detail TEXT
) STRICT;
CREATE UNIQUE INDEX result_tries_result ON result_tries (result, try);
CREATE INDEX result_tries_project ON result_tries (project);
CREATE INDEX result_tries_signature ON result_tries (signature) WHERE signature IS NOT NULL;

-- Which end of a flip was a try of its result rather than the result itself: the id of a row of result_tries. A flip
-- inside one run has the same result at both ends. Written in the transaction that writes the tries. No foreign key:
-- the upgrade tests rebuild an earlier schema by dropping these columns, which SQLite refuses for a column a foreign
-- key names.
ALTER TABLE flips ADD COLUMN first_try INTEGER;
ALTER TABLE flips ADD COLUMN second_try INTEGER;
CREATE INDEX flips_first_try ON flips (first_try) WHERE first_try IS NOT NULL;
CREATE INDEX flips_second_try ON flips (second_try) WHERE second_try IS NOT NULL;
