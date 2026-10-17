-- A report can say it is one shard of its job: `shard` of `shards`. Both or neither; NULL is a whole job.
ALTER TABLE batches ADD COLUMN shard INTEGER CHECK (shard IS NULL OR shard >= 1);
ALTER TABLE batches ADD COLUMN shards INTEGER CHECK (shards IS NULL OR shards >= shard);
CREATE INDEX batches_target_shards ON batches (target, job) WHERE shards IS NOT NULL;
