-- Removing a retired demo reads each table by the demo's own rows (issue #914). These three had no index for the
-- column it reads by, so a slice scanned every project's rows; once the demo's own were gone, every later slice
-- scanned them all again.
CREATE INDEX search_docs_project ON search_docs (project);
CREATE INDEX slot_results_run ON slot_results (run);
CREATE INDEX team_events_project ON team_events (project) WHERE project IS NOT NULL;
-- A table owned through its parents is read one batch of the demo's ancestors at a time, in (project, id) order, from
-- where the last slice stopped. `results` has such an index already (`results_assertion_rebuild`).
CREATE INDEX batches_project_id ON batches (project, id);
CREATE INDEX cases_project_id ON cases (project, id);
CREATE INDEX changes_project_id ON changes (project, id);
CREATE INDEX decisions_project_id ON decisions (project, id);
CREATE INDEX merge_receipt_nodes_project_id ON merge_receipt_nodes (project, id);
CREATE INDEX questions_project_id ON questions (project, id);
CREATE INDEX requirements_project_id ON requirements (project, id);
CREATE INDEX runs_project_id ON runs (project, id);
