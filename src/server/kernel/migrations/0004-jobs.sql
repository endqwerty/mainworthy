CREATE TABLE background_jobs (
 id text PRIMARY KEY,
 kind text NOT NULL,
 input text NOT NULL,
 actor bigint,
 accepted_at bigint NOT NULL,
 effect text NOT NULL CHECK (effect IN ('repeatable','uncertain')),
 state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','running','succeeded','failed','uncertain')),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 16),
 next_at bigint NOT NULL,
 owner text,
 token text,
 lease_until bigint,
 started boolean NOT NULL DEFAULT false,
 error text,
 CHECK ((state = 'running') = (owner IS NOT NULL AND token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX background_jobs_due ON background_jobs(next_at,accepted_at,id) WHERE state IN ('ready','running');

CREATE TABLE blob_objects (
 hash text PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'),
 put_at bigint NOT NULL,
 checked_at bigint NOT NULL DEFAULT 0
);
CREATE INDEX blob_objects_age ON blob_objects(checked_at,put_at,hash);
