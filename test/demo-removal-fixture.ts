import type { WriteDb } from "../src/server/kernel/db.ts";

/** Two projects with independent results: only the retained project has excuses. */
export async function removalFixture(db: WriteDb, size: number, retainedSize = size): Promise<void> {
	await db.transaction(async () => {
		await db.exec(`
			INSERT INTO orgs (id, name, created_at) VALUES (900, 'Removal fixture', 1);
			INSERT INTO actors (id, org, kind, name, created_at) VALUES (900, 900, 'human', 'fixture', 1);
			INSERT INTO projects (id, org, key, name, created_at, identity) VALUES
				(900, 900, 'removing', 'Demo', 1, 'removing-identity'), (901, 900, 'retained', 'Other project', 1, 'retained-identity');
			INSERT INTO demo_projects (project, since) VALUES (900, 1);
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

		await db.runDynamic(
			`INSERT INTO results (id, project, test, seq, ord, batch, target, method, actor, basis, outcome, at)
   SELECT n, 900, 900, 1, n, 900, 900, 'auto', 900, 'unresolved', 'fail', 1 FROM generate_series(1, $1::bigint) n
   UNION ALL SELECT $1::bigint + n, 901, 901, 1, n, 901, 901, 'auto', 900, 'unresolved', 'fail', 1 FROM generate_series(1, $2::bigint) n`,
			[size, retainedSize],
		);
		await db.runDynamic(
			`INSERT INTO result_excuses (result, decision, class)
   SELECT $1::bigint + n, 900, 'excused' FROM generate_series(1, $2::bigint) n`,
			[size, retainedSize],
		);
	});
}
