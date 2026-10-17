-- The reports read the results of a window of days (decision 0094): by project and time, not the whole history.
CREATE INDEX results_at ON results (project, at);
