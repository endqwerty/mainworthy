ALTER TABLE result_excuses RENAME TO earlier_result_excuses;
DROP INDEX result_excuses_decision;
CREATE TABLE result_excuses (
	id INTEGER PRIMARY KEY,
	result INTEGER NOT NULL REFERENCES results (id),
	slot INTEGER REFERENCES slots (id),
	decision INTEGER NOT NULL REFERENCES decisions (id),
	class TEXT NOT NULL CHECK (class IN ('attributed', 'excused')),
	expires_at INTEGER
) STRICT;
INSERT INTO result_excuses (result, decision, class, expires_at)
SELECT result, decision, class, expires_at FROM earlier_result_excuses;
DROP TABLE earlier_result_excuses;
CREATE UNIQUE INDEX result_excuses_global ON result_excuses (result) WHERE slot IS NULL;
CREATE UNIQUE INDEX result_excuses_slot ON result_excuses (slot, result) WHERE slot IS NOT NULL;
CREATE INDEX result_excuses_decision ON result_excuses (decision);
