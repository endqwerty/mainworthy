-- Excuses are found by their whole key now; removal checks foreign keys once before commit (migration 25).
DROP INDEX excuses_signature_fk;
