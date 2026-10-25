CREATE TABLE identity_ceremony_epoch (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    generation text NOT NULL
);
INSERT INTO identity_ceremony_epoch (singleton, generation) VALUES (true, gen_random_uuid()::text);
CREATE TABLE identity_ceremonies (
    kind text NOT NULL,
    key text NOT NULL,
    owner text NOT NULL,
    deadline bigint NOT NULL,
    generation text NOT NULL,
    payload text NOT NULL,
    PRIMARY KEY (kind, key)
);
CREATE INDEX identity_ceremonies_expiry ON identity_ceremonies (kind, deadline);
CREATE INDEX identity_ceremonies_owner ON identity_ceremonies (kind, owner);

CREATE SEQUENCE identity_limit_version;
CREATE TABLE identity_limits (
    key text PRIMARY KEY,
    entry text NOT NULL,
    expires_at bigint NOT NULL,
    version bigint NOT NULL
);
CREATE INDEX identity_limits_expiry ON identity_limits (expires_at);
CREATE TABLE identity_starts (
    key text PRIMARY KEY,
    since bigint NOT NULL,
    count bigint NOT NULL
);

CREATE TABLE change_events (
    project bigint NOT NULL REFERENCES projects(id) ON DELETE CASCADE DEFERRABLE,
    seq bigint NOT NULL,
    op text NOT NULL,
    revision text NOT NULL DEFAULT gen_random_uuid()::text,
    touched text NOT NULL,
    at bigint NOT NULL,
    PRIMARY KEY (project, seq)
);
CREATE INDEX change_events_retention ON change_events(at);
