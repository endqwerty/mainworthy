CREATE INDEX runs_planned_receiving ON runs (project, state, id DESC)
WHERE origin = 'planned';

CREATE INDEX runs_planned_commit ON runs (project, json_extract(accepts, '$.commit'), state, id DESC)
WHERE origin = 'planned';
