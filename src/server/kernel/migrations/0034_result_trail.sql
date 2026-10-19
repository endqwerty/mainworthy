ALTER TABLE results RENAME COLUMN steps TO trail;
UPDATE results SET at_step = NULL WHERE trail IS NOT NULL;
