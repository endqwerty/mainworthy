-- Operational deployment state stays with the demo mark and does not travel in an archive.
ALTER TABLE demo_projects ADD COLUMN deployment TEXT CHECK (deployment IS NULL OR json_valid(deployment));
