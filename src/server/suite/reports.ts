import { type Db, sql } from "../kernel/db.ts";

const Q = {
	counts: sql<{ project: number; linked: string }, { total: number; automated: number; wanted: number }>(
		`SELECT count(*) AS total,
 coalesce(sum(c.id IN (SELECT value FROM json_each($linked))), 0) AS automated,
 coalesce(sum(c.automate = 'wanted' AND c.id NOT IN (SELECT value FROM json_each($linked))), 0) AS wanted
 FROM cases c WHERE c.project = $project AND c.state = 'active'`,
	),
	backlog: sql<{ project: number; linked: string }, { no: number; title: string }>(
		`SELECT no, title FROM cases WHERE project = $project AND state = 'active' AND automate = 'wanted'
 AND id NOT IN (SELECT value FROM json_each($linked)) ORDER BY no LIMIT 50`,
	),
	requirements: sql<{ project: number }, { key: string; title: string; cases: number }>(
		`SELECT r.key, r.title, count(c.id) AS cases FROM requirements r
 LEFT JOIN covers v ON v.requirement = r.id LEFT JOIN cases c ON c.id = v.case_id AND c.state = 'active'
 WHERE r.project = $project GROUP BY r.id ORDER BY r.key`,
	),
};

const requirementOrder = new Intl.Collator("en", { numeric: true });

export function suiteReports(db: Db, project: number, linked: ReadonlySet<number>) {
	const input = { project, linked: JSON.stringify([...linked]) };
	const counts = db.get(Q.counts, input) ?? { total: 0, automated: 0, wanted: 0 };
	const requirements = db.all(Q.requirements, { project }).sort((a, b) => requirementOrder.compare(a.key, b.key));
	return {
		automation: {
			...counts,
			rate: counts.total ? counts.automated / counts.total : null,
			backlog: db.all(Q.backlog, input).map((row) => ({ ref: `C-${row.no}`, title: row.title })),
		},
		requirements: {
			total: requirements.length,
			covered: requirements.filter((row) => row.cases > 0).length,
			items: requirements.slice(0, 100),
		},
	};
}
