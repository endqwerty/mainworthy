-- Immutable radix-32 trees share both result pages and ancestor paths. Live roots/dirty buckets are disposable.
CREATE TABLE merge_receipt_payloads (
 id INTEGER PRIMARY KEY,
 project INTEGER NOT NULL REFERENCES projects(id),
 hash TEXT NOT NULL,
 body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=32768),
 UNIQUE(project,hash)
) STRICT;
CREATE TABLE merge_receipt_nodes (
 id INTEGER PRIMARY KEY,
 project INTEGER NOT NULL REFERENCES projects(id),
 hash TEXT NOT NULL,
 level INTEGER NOT NULL CHECK(level BETWEEN 0 AND 10),
 count INTEGER NOT NULL CHECK(count>0),
 UNIQUE(project,hash)
) STRICT;
CREATE TABLE merge_receipt_members (
 node INTEGER NOT NULL REFERENCES merge_receipt_nodes(id),
 slot INTEGER NOT NULL CHECK(slot BETWEEN 0 AND 31),
 child INTEGER REFERENCES merge_receipt_nodes(id),
 payload INTEGER REFERENCES merge_receipt_payloads(id),
 CHECK((child IS NULL)!=(payload IS NULL)),
 PRIMARY KEY(node,slot)
) STRICT;
CREATE INDEX merge_receipt_members_child ON merge_receipt_members(child);
CREATE INDEX merge_receipt_members_payload ON merge_receipt_members(payload);
CREATE TABLE merge_receipt_snapshots (
 id INTEGER PRIMARY KEY,
 project INTEGER NOT NULL REFERENCES projects(id),
 hash TEXT NOT NULL,
 result_root INTEGER REFERENCES merge_receipt_nodes(id),
 gate_root INTEGER REFERENCES merge_receipt_nodes(id),
 count INTEGER NOT NULL,
 evidence_count INTEGER NOT NULL,
 UNIQUE(project,hash)
) STRICT;
CREATE INDEX merge_receipt_snapshots_results ON merge_receipt_snapshots(result_root);
CREATE INDEX merge_receipt_snapshots_gate ON merge_receipt_snapshots(gate_root);
CREATE TABLE merge_receipt_heads (
 run INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
 project INTEGER NOT NULL REFERENCES projects(id),
 root INTEGER REFERENCES merge_receipt_nodes(id)
) STRICT;
CREATE INDEX merge_receipt_heads_project ON merge_receipt_heads(project);
CREATE INDEX merge_receipt_heads_root ON merge_receipt_heads(root);
CREATE TABLE merge_receipt_dirty (
 run INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 bucket INTEGER NOT NULL,
 PRIMARY KEY(run,bucket)
) STRICT;
CREATE INDEX run_tests_receipt ON run_tests(run,result/32,result);
-- An internal decision records a gate read when a merge was reported. It neither approves the merge nor answers
-- a queue question. Like change_ends, these observations do not travel in an archive: imported changes are open.
CREATE TABLE merge_receipts (
	id INTEGER PRIMARY KEY,
	project INTEGER NOT NULL REFERENCES projects (id),
	change INTEGER NOT NULL REFERENCES changes (id),
	actor INTEGER NOT NULL REFERENCES actors (id),
	at INTEGER NOT NULL,
	seq INTEGER NOT NULL,
	evidence INTEGER NOT NULL REFERENCES merge_receipt_snapshots (id),
	snapshot TEXT NOT NULL CHECK (json_valid(snapshot) AND length(CAST(snapshot AS BLOB)) <= 4096)
) STRICT;
CREATE INDEX merge_receipts_change ON merge_receipts (change, id);
CREATE INDEX merge_receipts_project ON merge_receipts (project, seq);
ALTER TABLE change_ends ADD COLUMN receipt INTEGER REFERENCES merge_receipts (id);
CREATE INDEX change_ends_receipt ON change_ends (receipt);

CREATE INDEX merge_receipts_evidence ON merge_receipts (evidence);

CREATE TRIGGER receipt_run_insert AFTER INSERT ON run_tests BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT NEW.run,NEW.result/32 WHERE EXISTS(SELECT 1 FROM merge_receipt_heads WHERE run=NEW.run) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_run_delete AFTER DELETE ON run_tests BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT OLD.run,OLD.result/32 WHERE EXISTS(SELECT 1 FROM merge_receipt_heads WHERE run=OLD.run) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_run_update_old AFTER UPDATE ON run_tests WHEN OLD.run IS NOT NEW.run OR OLD.result IS NOT NEW.result OR OLD.outcome IS NOT NEW.outcome OR OLD.signature IS NOT NEW.signature OR OLD.flipped IS NOT NEW.flipped OR OLD.target IS NOT NEW.target OR OLD.test IS NOT NEW.test BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT OLD.run,OLD.result/32 WHERE EXISTS(SELECT 1 FROM merge_receipt_heads WHERE run=OLD.run) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_run_update_new AFTER UPDATE ON run_tests WHEN OLD.run IS NOT NEW.run OR OLD.result IS NOT NEW.result OR OLD.outcome IS NOT NEW.outcome OR OLD.signature IS NOT NEW.signature OR OLD.flipped IS NOT NEW.flipped OR OLD.target IS NOT NEW.target OR OLD.test IS NOT NEW.test BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT NEW.run,NEW.result/32 WHERE EXISTS(SELECT 1 FROM merge_receipt_heads WHERE run=NEW.run) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_test AFTER UPDATE OF name,file,no,kind ON tests WHEN OLD.name IS NOT NEW.name OR OLD.file IS NOT NEW.file OR OLD.no IS NOT NEW.no OR OLD.kind IS NOT NEW.kind BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.test=NEW.id ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_target AFTER UPDATE OF line,change,repo,what,env ON targets WHEN OLD.line IS NOT NEW.line OR OLD.change IS NOT NEW.change OR OLD.repo IS NOT NEW.repo OR OLD.what IS NOT NEW.what OR OLD.env IS NOT NEW.env BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.target=NEW.id ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_result AFTER UPDATE OF quarantine_decision,quarantine_exit,signature,method,batch,test,target ON results WHEN OLD.quarantine_decision IS NOT NEW.quarantine_decision OR OLD.quarantine_exit IS NOT NEW.quarantine_exit OR OLD.signature IS NOT NEW.signature OR OLD.method IS NOT NEW.method OR OLD.batch IS NOT NEW.batch OR OLD.test IS NOT NEW.test OR OLD.target IS NOT NEW.target BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.result=NEW.id ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_batch AFTER UPDATE OF job ON batches WHEN OLD.job IS NOT NEW.job BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.result IN (SELECT id FROM results WHERE batch=NEW.id) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_excuses_insert_new AFTER INSERT ON excuses BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.signature=NEW.signature AND rt.outcome IN ('fail','error') AND h.project=NEW.project AND (NEW.target=0 OR rt.target=NEW.target) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_excuses_delete_old AFTER DELETE ON excuses BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.signature=OLD.signature AND rt.outcome IN ('fail','error') AND h.project=OLD.project AND (OLD.target=0 OR rt.target=OLD.target) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_excuses_update_old AFTER UPDATE ON excuses BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.signature=OLD.signature AND rt.outcome IN ('fail','error') AND h.project=OLD.project AND (OLD.target=0 OR rt.target=OLD.target) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_excuses_update_new AFTER UPDATE ON excuses BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.signature=NEW.signature AND rt.outcome IN ('fail','error') AND h.project=NEW.project AND (NEW.target=0 OR rt.target=NEW.target) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_result_excuses_insert_new AFTER INSERT ON result_excuses BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE NEW.slot IS NULL AND rt.result=NEW.result ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_result_excuses_delete_old AFTER DELETE ON result_excuses BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE OLD.slot IS NULL AND rt.result=OLD.result ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_result_excuses_update_old AFTER UPDATE ON result_excuses BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE OLD.slot IS NULL AND rt.result=OLD.result ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_result_excuses_update_new AFTER UPDATE ON result_excuses BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE NEW.slot IS NULL AND rt.result=NEW.result ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_flips_insert_new AFTER INSERT ON flips BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.test=NEW.test AND rt.target=NEW.target ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_flips_delete_old AFTER DELETE ON flips BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.test=OLD.test AND rt.target=OLD.target ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_flips_update_old AFTER UPDATE ON flips BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.test=OLD.test AND rt.target=OLD.target ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_flips_update_new AFTER UPDATE ON flips BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.test=NEW.test AND rt.target=NEW.target ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_correction_insert_new AFTER INSERT ON results WHEN NEW.corrects IS NOT NULL BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.test=(SELECT test FROM results WHERE id=NEW.corrects) AND rt.target=(SELECT target FROM results WHERE id=NEW.corrects) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_correction_delete_old AFTER DELETE ON results WHEN OLD.corrects IS NOT NULL BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.test=(SELECT test FROM results WHERE id=OLD.corrects) AND rt.target=(SELECT target FROM results WHERE id=OLD.corrects) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_correction_update_old AFTER UPDATE ON results WHEN OLD.corrects IS NOT NULL AND OLD.corrects IS NOT NEW.corrects BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.test=(SELECT test FROM results WHERE id=OLD.corrects) AND rt.target=(SELECT target FROM results WHERE id=OLD.corrects) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_correction_update_new AFTER UPDATE ON results WHEN NEW.corrects IS NOT NULL AND OLD.corrects IS NOT NEW.corrects BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE rt.test=(SELECT test FROM results WHERE id=NEW.corrects) AND rt.target=(SELECT target FROM results WHERE id=NEW.corrects) ON CONFLICT(run,bucket) DO NOTHING;
END;
CREATE TRIGGER receipt_quarantine_presence AFTER DELETE ON quarantines WHEN NOT EXISTS(SELECT 1 FROM quarantines WHERE project=OLD.project) BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket) SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run WHERE h.project=OLD.project AND rt.result IN (SELECT id FROM results WHERE quarantine_decision IS NOT NULL) ON CONFLICT(run,bucket) DO NOTHING;
END;

CREATE TRIGGER receipt_quarantine_insert AFTER INSERT ON quarantines
WHEN (SELECT count(*) FROM quarantines WHERE project=NEW.project)=1
BEGIN
 INSERT INTO merge_receipt_dirty(run,bucket)
 SELECT rt.run,rt.result/32 FROM run_tests rt JOIN merge_receipt_heads h ON h.run=rt.run
 WHERE h.project=NEW.project AND rt.result IN (SELECT id FROM results WHERE quarantine_decision IS NOT NULL)
 ON CONFLICT(run,bucket) DO NOTHING;
END;
