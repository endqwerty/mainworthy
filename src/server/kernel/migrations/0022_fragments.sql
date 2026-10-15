ALTER TABLE cases ADD COLUMN kind TEXT NOT NULL DEFAULT 'case' CHECK (kind IN ('case', 'fragment'));
CREATE INDEX cases_project_kind ON cases(project, kind, state);
