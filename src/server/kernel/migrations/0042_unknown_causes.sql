-- Keep signature ids and every reference while widening the column-local class constraint.
CREATE TEMP TABLE unknown_cause_classes_upgrade (
 id INTEGER PRIMARY KEY,
 class TEXT NOT NULL
) STRICT;
INSERT INTO unknown_cause_classes_upgrade SELECT id, class FROM signatures;
ALTER TABLE signatures DROP COLUMN class;
ALTER TABLE signatures ADD COLUMN class TEXT NOT NULL DEFAULT 'assertion'
 CHECK (class IN ('assertion', 'timeout', 'infra', 'unknown'));
UPDATE signatures SET class = (SELECT class FROM unknown_cause_classes_upgrade WHERE id = signatures.id);
DROP TABLE unknown_cause_classes_upgrade;
