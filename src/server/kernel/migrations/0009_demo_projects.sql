-- The projects that are demos (decision 0020). A write to one may say when it happened, so a demo can hold a
-- history; every other project takes the server's clock. `since` is when the project became a demo, by the
-- server's clock: the day a seed counts back from, the same on every retry. A row is written once, while the
-- project holds nothing, and is never removed. An archive leaves the table out (`UNEXPORTED`).
CREATE TABLE demo_projects (
	project INTEGER PRIMARY KEY REFERENCES projects (id),
	since INTEGER NOT NULL
) STRICT;
