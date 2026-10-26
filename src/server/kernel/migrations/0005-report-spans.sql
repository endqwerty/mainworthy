-- When a report's tests started and ended, as its runner said (issue #722). Evidence, never the time of a write:
-- `at` stays the server's. A report from before this, or one that named no span, keeps both NULL.
ALTER TABLE batches
 ADD COLUMN started_at bigint,
 ADD COLUMN ended_at bigint,
 ADD CONSTRAINT batches_span CHECK (
  (started_at IS NULL AND ended_at IS NULL)
  OR (started_at IS NOT NULL AND ended_at IS NOT NULL AND started_at >= 0 AND ended_at >= started_at)
 );
