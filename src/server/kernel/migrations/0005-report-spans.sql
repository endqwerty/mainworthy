-- When a report's tests started and ended, as its runner said (issue #722). Evidence, never the time of a write:
-- `at` stays the server's. A report from before this, or one that named no span, keeps both NULL. The end is at
-- most 2^53 - 1, the largest time a reply carries exactly, as `report` refuses anything later.
ALTER TABLE batches
 ADD COLUMN started_at bigint,
 ADD COLUMN ended_at bigint,
 ADD CONSTRAINT batches_span CHECK (
  (started_at IS NULL AND ended_at IS NULL)
  OR (started_at IS NOT NULL AND ended_at IS NOT NULL AND started_at >= 0 AND ended_at >= started_at
      AND ended_at <= 9007199254740991)
 );
