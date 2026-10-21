import type { Db } from "../src/server/kernel/db.ts";

/** Two projects with independent results: only the retained project has excuses. */
export function removalFixture(db: Db, size: number, retainedSize = size): void {
	db.transaction(() => {
		db.exec(`
			INSERT INTO orgs (id, name, created_at) VALUES (900, 'Removal fixture', 1);
			INSERT INTO actors (id, org, kind, name, created_at) VALUES (900, 900, 'human', 'fixture', 1);
			INSERT INTO projects (id, org, key, name, created_at, identity) VALUES
				(900, 900, 'removing', 'Demo', 1, 'removing-identity'), (901, 900, 'retained', 'Other project', 1, 'retained-identity');
			INSERT INTO demo_projects VALUES (900, 1);
			INSERT INTO tests (id, project, no, kind, key, name, first_seq, last_seq) VALUES
				(900, 900, 1, 'auto', 'a', 'A', 1, 1), (901, 901, 1, 'auto', 'b', 'B', 1, 1);
			INSERT INTO targets (id, project, what, line, first_seq) VALUES
				(900, 900, 'session:a', 'session', 1), (901, 901, 'session:b', 'session', 1);
			INSERT INTO batches (id, project, key, target, method, actor, state, counts, at, seq) VALUES
				(900, 900, 'a', 900, 'auto', 900, 'processed', '{}', 1, 1),
				(901, 901, 'b', 901, 'auto', 900, 'processed', '{}', 1, 1);
			INSERT INTO questions (id, project, no, kind, subject, fingerprint, title, producer, evidence,
				evidence_hash, basis, seen_first, seen_last, ask, blocks, rank, state, opened_at, rev)
				VALUES (900, 901, 1, 'failure', '{}', 'failure', 'Failure', 'ci', '{}', 'hash', '{}',
				1, 1, '{}', '[]', 1, 'decided', 1, 1);
			INSERT INTO decisions (id, project, question, kind, answer, signers, basis, holds, at, seq)
				VALUES (900, 901, 900, 'failure', '{}', '[]', '{}', '{}', 1, 1);
		`);
		const insert = db.raw.prepare(`
			INSERT INTO results (id, project, test, seq, ord, batch, target, method, actor, basis, outcome, at)
			VALUES (?, ?, ?, 1, ?, ?, ?, 'auto', 900, 'unresolved', 'fail', 1)
		`);
		const excuse = db.raw.prepare("INSERT INTO result_excuses (result, decision, class) VALUES (?, 900, 'excused')");
		try {
			for (let i = 1; i <= size; i++) insert.run(i, 900, 900, i, 900, 900);
			for (let i = 1; i <= retainedSize; i++) {
				insert.run(size + i, 901, 901, i, 901, 901);
				excuse.run(size + i);
			}
		} finally {
			insert.finalize();
			excuse.finalize();
		}
	});
}

/** Undo migration 37 when an upgrade fixture reconstructs a schema from before it. */
export function dropResetIndexes(db: Db): void {
	const indexes = db.raw
		.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name GLOB '*_reset'")
		.all();
	for (const { name } of indexes) db.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
}
