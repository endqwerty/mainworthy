CREATE TABLE report_map_pages (
 id text PRIMARY KEY,
 project bigint NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY IMMEDIATE,
 batch bigint NOT NULL REFERENCES batches(id) DEFERRABLE INITIALLY IMMEDIATE,
 actor bigint NOT NULL REFERENCES actors(id) DEFERRABLE INITIALLY IMMEDIATE,
 producer text NOT NULL CHECK (producer IN ('human', 'agent', 'ci', 'rule')),
 files text NOT NULL CHECK (jsonb_typeof(files::jsonb) = 'array' AND jsonb_array_length(files::jsonb) BETWEEN 1 AND 100),
 at bigint NOT NULL
);
CREATE INDEX report_map_pages_project ON report_map_pages(project);
CREATE INDEX report_map_pages_batch ON report_map_pages(batch);
CREATE INDEX report_map_pages_actor ON report_map_pages(actor);

INSERT INTO report_map_pages(id, project, batch, actor, producer, files, at)
 SELECT j.id::jsonb->>1, b.project,
 b.id, j.actor,
 input::jsonb->>'producer', (input::jsonb->'files')::text, accepted_at
 FROM background_jobs j JOIN batches b ON b.id=CASE WHEN j.kind='report-maps' THEN split_part(j.id::jsonb->>1, ':', 1)::bigint END
 WHERE j.kind='report-maps' AND j.state <> 'succeeded';
UPDATE background_jobs SET input=jsonb_build_object('page', id::jsonb->>1)::text
 WHERE kind='report-maps';
