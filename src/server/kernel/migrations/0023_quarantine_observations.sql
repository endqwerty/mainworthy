ALTER TABLE results ADD COLUMN quarantine_decision INTEGER REFERENCES decisions (id);
ALTER TABLE results ADD COLUMN quarantine_exit INTEGER REFERENCES decisions (id);
CREATE INDEX results_quarantine_exit ON results (quarantine_exit) WHERE quarantine_exit IS NOT NULL;
ALTER TABLE runs ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;
