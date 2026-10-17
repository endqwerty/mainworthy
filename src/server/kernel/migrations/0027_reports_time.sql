CREATE INDEX results_report_days ON results (
 project, cast(at / 86400000 AS INTEGER), at, outcome
);
CREATE INDEX results_report_lanes ON results (
 project, method, test, target, actor, seq, ord, at, batch, outcome, duration_ms
);
