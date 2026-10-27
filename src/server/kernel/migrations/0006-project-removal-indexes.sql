-- Removing a retired demo reads each table by the demo's own rows (issue #914). These three had no index for the
-- column it reads by, so a slice scanned every project's rows; once the demo's own were gone, every later slice
-- scanned them all again.
CREATE INDEX search_docs_project ON search_docs (project);
CREATE INDEX slot_results_run ON slot_results (run);
CREATE INDEX team_events_project ON team_events (project) WHERE project IS NOT NULL;
