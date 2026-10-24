import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Instance } from "../src/app/start.ts";
import { contentHash } from "../src/core/hash.ts";
import { ReportInput } from "../src/core/ops.ts";
import { OPS } from "../src/server/ops/index.ts";
import { invoke } from "../src/server/ops/registry.ts";
import { ciReport } from "./helpers.ts";

export const policyReport = (pr: number) =>
	ciReport({
		commit: `policy-head-${pr}`,
		pr,
		branch: `feature/${pr}`,
		base: "base",
		n: 10,
		fail: { 0: "checkout failed" },
	});

/** A fresh policy-latency project, with real first/last reports and the same intermediate report graph. */
export async function seedPolicyChanges(instance: Pick<Instance, "app" | "owner">, count: number): Promise<void> {
	const report = async (pr: number) => {
		const receipt = await invoke(instance.app, OPS, {
			op: "report",
			project: "policy-latency",
			actor: async () => instance.owner,
			input: policyReport(pr),
		});
		expect(receipt).toMatchObject({ ok: true, result: { fresh: true, counts: { total: 10, fail: 1 } } });
	};
	await report(1);
	await instance.app.database.write((db) =>
		db.transaction(async () => {
			// Allocate identities in report/result order, without assuming database-wide sequences start at one.
			await db.runDynamic(
				`CREATE TEMP TABLE policy_history ON COMMIT DROP AS
 SELECT n AS no,2*n AS seq,nextval(pg_get_serial_sequence('changes','id')) AS change,
 nextval(pg_get_serial_sequence('targets','id')) AS target,nextval(pg_get_serial_sequence('runs','id')) AS run,
 nextval(pg_get_serial_sequence('batches','id')) AS batch,nextval(pg_get_serial_sequence('questions','id')) AS question,
 n+1 AS qno,NULL::bigint[] AS results,''::text AS key,''::text AS fingerprint,''::text AS basis,''::text AS evidence_hash
 FROM generate_series(2,$1::bigint-1) n ORDER BY n`,
				[count],
			);
			await db.exec(`CREATE TEMP TABLE policy_results ON COMMIT DROP AS
 SELECT h.no,r.ord,nextval(pg_get_serial_sequence('results','id')) AS id FROM policy_history h
 CROSS JOIN (SELECT r.ord FROM results r JOIN targets t ON t.id=r.target WHERE t.commit_sha='policy-head-1') r
 ORDER BY h.no,r.ord;
 UPDATE policy_history h SET results=r.ids FROM (SELECT no,array_agg(id ORDER BY ord) ids FROM policy_results GROUP BY no) r WHERE h.no=r.no`);
			const signature = z
				.object({ id: z.number(), hash: z.string() })
				.parse(
					(
						await db.allDynamic(
							"SELECT s.id,s.hash FROM signatures s JOIN projects p ON p.id=s.project WHERE p.key='policy-latency'",
						)
					)[0],
				);
			const history = z
				.array(z.object({ no: z.number(), change: z.number(), target: z.number() }))
				.parse(await db.allDynamic("SELECT no,change,target FROM policy_history ORDER BY no"));
			const hashes = history.map((h) => {
				const scope = `change:${h.change}`;
				const basis = contentHash({ signature: signature.id, scope });
				return {
					no: h.no,
					basis,
					fingerprint: contentHash({ kind: "failure", key: `${signature.hash}|${scope}` }),
					evidence_hash: contentHash({ basis, target: h.target }),
					key: createHash("sha256")
						.update(
							JSON.stringify({
								target: h.target,
								run: null,
								job: "e2e",
								attempt: 1,
								method: "auto",
								actor: instance.owner.id,
								nonce: null,
								results: ReportInput.parse(policyReport(h.no)).results,
							}),
						)
						.digest("hex"),
				};
			});
			await db.runDynamic(
				`UPDATE policy_history h SET key=u.key,fingerprint=u.fingerprint,basis=u.basis,evidence_hash=u.evidence_hash
 FROM jsonb_to_recordset($1::text::jsonb) AS u(no bigint,key text,fingerprint text,basis text,evidence_hash text) WHERE h.no=u.no`,
				[JSON.stringify(hashes)],
			);
			// Clone real defaults as well as the fields this workload reads. Each operation names its relation and edges.
			await db.exec(`
 INSERT INTO changes SELECT cloned.* FROM policy_history h CROSS JOIN changes c JOIN projects p ON p.id=c.project
 CROSS JOIN LATERAL jsonb_populate_record(NULL::changes,to_jsonb(c)||jsonb_build_object(
 'id',h.change,'key','pr:'||h.no,'head_sha','policy-head-'||h.no,'branch','feature/'||h.no,'rev',h.seq)) AS cloned
 WHERE p.key='policy-latency' AND c.key='pr:1' ORDER BY h.no;
 INSERT INTO targets SELECT cloned.* FROM policy_history h CROSS JOIN targets t
 CROSS JOIN LATERAL jsonb_populate_record(NULL::targets,to_jsonb(t)||jsonb_build_object(
 'id',h.target,'what','code:acme/web@policy-head-'||h.no,'commit_sha','policy-head-'||h.no,
 'branch','feature/'||h.no,'change',h.change,'first_seq',h.seq)) AS cloned
 WHERE t.commit_sha='policy-head-1' ORDER BY h.no;
 INSERT INTO runs SELECT cloned.* FROM policy_history h CROSS JOIN runs r JOIN targets t ON t.what=r.accepts_what
 CROSS JOIN LATERAL jsonb_populate_record(NULL::runs,to_jsonb(r)||jsonb_build_object(
 'id',h.run,'no',h.no,'name','policy- on pr:'||h.no,
 'accepts',jsonb_build_object('commit','policy-head-'||h.no,'repo','acme/web')::text,
 'accepts_what','code:acme/web@policy-head-'||h.no,'scope','change:'||h.change,'change',h.change,
 'accepted_seq',h.seq,'applied_seq',h.seq,'blocking',jsonb_build_array('Q-'||h.qno)::text,'rev',h.seq+1)) AS cloned
 WHERE t.commit_sha='policy-head-1' ORDER BY h.no;
 INSERT INTO batches SELECT cloned.* FROM policy_history h CROSS JOIN batches b JOIN targets t ON t.id=b.target
 CROSS JOIN LATERAL jsonb_populate_record(NULL::batches,to_jsonb(b)||jsonb_build_object(
 'id',h.batch,'key',h.key,'target',h.target,'seq',h.seq,'receipt',(
 b.receipt::jsonb||jsonb_build_object('batch',h.batch,'target','policy- (feature/'||h.no||')',
 'questions',jsonb_build_array((b.receipt::jsonb->'questions'->0)||jsonb_build_object('q','Q-'||h.qno)),
 'results',to_jsonb(h.results),'gate',(b.receipt::jsonb->'gate')||jsonb_build_object('run','R-'||h.no,'open',jsonb_build_array('Q-'||h.qno))))::text)) AS cloned
 WHERE t.commit_sha='policy-head-1' ORDER BY h.no;
 INSERT INTO results SELECT cloned.* FROM policy_history h JOIN policy_results i ON i.no=h.no CROSS JOIN results r JOIN targets t ON t.id=r.target
 CROSS JOIN LATERAL jsonb_populate_record(NULL::results,to_jsonb(r)||jsonb_build_object(
 'id',i.id,'seq',h.seq+1,'batch',h.batch,'target',h.target)) AS cloned
 WHERE t.commit_sha='policy-head-1' AND r.ord=i.ord ORDER BY h.no,i.ord;
 INSERT INTO run_tests SELECT cloned.* FROM policy_history h JOIN policy_results i ON i.no=h.no CROSS JOIN run_tests rt JOIN results r ON r.id=rt.result
 JOIN targets t ON t.id=rt.target
 CROSS JOIN LATERAL jsonb_populate_record(NULL::run_tests,to_jsonb(rt)||jsonb_build_object(
 'run',h.run,'result',i.id,'target',h.target,'lane',h.target||':e2e:'||r.actor)) AS cloned
 WHERE t.commit_sha='policy-head-1' AND r.ord=i.ord ORDER BY h.no,i.ord;
 INSERT INTO questions SELECT cloned.* FROM policy_history h CROSS JOIN questions q JOIN projects p ON p.id=q.project
 CROSS JOIN LATERAL jsonb_populate_record(NULL::questions,to_jsonb(q)||jsonb_build_object(
 'id',h.question,'no',h.qno,'subject',jsonb_build_object('signature',(q.subject::jsonb->'signature'),'scope','change:'||h.change)::text,
 'fingerprint',h.fingerprint,'basis',h.basis,'evidence_hash',h.evidence_hash,
 'evidence',(q.evidence::jsonb||jsonb_build_object('scope','pr:'||h.no,'branch','feature/'||h.no,
 'targets',jsonb_build_array(h.target),'sample',h.results[1],'targetId',h.target))::text,
 'seen_first',h.seq+1,'seen_last',h.seq+1,'blocks',jsonb_build_array(h.run)::text,
 'rank',-(2000000000000+(h.seq+1)*1000+10),'rev',h.seq+1)) AS cloned
 WHERE p.key='policy-latency' AND q.no=1 ORDER BY h.no;
 INSERT INTO question_refs (project,ref,question)
 SELECT q.project,x.ref,h.question FROM policy_history h CROSS JOIN questions q JOIN projects p ON p.id=q.project
 CROSS JOIN LATERAL (VALUES ('scope:change:'||h.change),('R-'||h.no),('pr:'||h.no),('T-1')) x(ref)
 WHERE p.key='policy-latency' AND q.no=1;
 INSERT INTO assertion_seen (project,scope,root,test,file)
 SELECT a.project,'commit:code:acme/web@policy-head-'||h.no,a.root,a.test,a.file FROM policy_history h
 CROSS JOIN assertion_seen a WHERE a.scope='commit:code:acme/web@policy-head-1';`);
			await db.runDynamic(
				`UPDATE counters SET value=CASE name WHEN 'run' THEN $1::bigint-1 ELSE $1::bigint END
 WHERE project=(SELECT id FROM projects WHERE key='policy-latency') AND name IN ('run','question')`,
				[count],
			);
			await db.runDynamic("UPDATE projects SET seq=2*$1::bigint-1 WHERE key='policy-latency'", [count]);
		}),
	);
	await report(count);
	const counts = await instance.app.database.read((db) =>
		db.allDynamic(`
 SELECT (SELECT count(*) FROM changes) AS changes,(SELECT count(*) FROM runs) AS runs,
 (SELECT count(*) FROM batches) AS batches,(SELECT count(*) FROM results) AS results,
 (SELECT count(*) FROM run_tests) AS run_tests,(SELECT count(*) FROM questions WHERE kind='failure') AS failures,
 (SELECT count(*) FROM questions WHERE kind='map' AND state='open') AS maps`),
	);
	expect(counts).toEqual([
		{
			changes: count,
			runs: count,
			batches: count,
			results: 10 * count,
			run_tests: 10 * count,
			failures: count,
			maps: 1,
		},
	]);
}
