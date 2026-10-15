-- Older decisions retain their basis, but their exact seen-evidence hash cannot be recovered reliably.
ALTER TABLE decisions ADD COLUMN on_evidence TEXT;
