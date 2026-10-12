// Deterministic benchmark dataset. Usage: bun seed.ts <out.db>
// 1 project, 500 folders, 100k cases (~160k versions), 20k tests, 200 targets/batches/runs,
// 1M results, 40 signatures, 60k questions (50k open), 10k decisions, 100k commands.
import { Database } from "bun:sqlite";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const out = process.argv[2] ?? "seed.db";
for (const suffix of ["", "-wal", "-shm"]) rmSync(out + suffix, { force: true });
const db = new Database(out);
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF; PRAGMA cache_size = -400000;");
db.exec(readFileSync(new URL("./schema.sqlite.sql", import.meta.url), "utf8"));

let state = 0x9e3779b9;
const rnd = () => {
	state |= 0;
	state = (state + 0x6d2b79f5) | 0;
	let t = Math.imul(state ^ (state >>> 15), 1 | state);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (n: number) => Math.floor(rnd() * n);
const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const AREAS = ["checkout", "cart", "login", "signup", "search", "profile", "billing", "orders", "shipping", "returns",
	"inventory", "catalog", "reviews", "wishlist", "notifications", "settings", "admin", "reports", "exports", "imports"];
const VERBS = ["open", "apply", "remove", "submit", "reload", "enter", "select", "confirm", "cancel", "upload",
	"download", "filter", "sort", "edit", "delete", "create", "duplicate", "archive", "restore", "share"];
const NOUNS = ["coupon", "invoice", "address", "password", "session", "token", "banner", "dialog", "table", "chart",
	"receipt", "refund", "discount", "subscription", "variant", "barcode", "shipment", "voucher", "ledger", "webhook",
	"avatar", "locale", "currency", "timezone", "permission", "role", "tenant", "queue", "cache", "report"];
const ADJS = ["expired", "percentage", "fixed", "invalid", "duplicate", "empty", "large", "unicode", "concurrent", "offline",
	"guest", "saved", "default", "primary", "archived", "pending", "partial", "international", "legacy", "disabled"];
const EXPECT = ["total shows the discounted amount", "an error message is shown", "the page keeps the selection",
	"the item is listed first", "nothing changes", "a confirmation email is queued", "the button is disabled",
	"the counter increases by one", "the user stays signed in", "the export contains every row"];
export const WORDS = { AREAS, VERBS, NOUNS, ADJS };

const tx = (fn: () => void) => db.transaction(fn)();
let seq = 0;

tx(() => {
	db.run("INSERT INTO project (id, key, seq) VALUES (1, 'bench', 0)");
	const f = db.prepare("INSERT INTO folder (id, project, parent, name, rank) VALUES (?, 1, ?, ?, ?)");
	let id = 0;
	for (let a = 0; a < 20; a++) {
		const top = ++id;
		f.run(top, null, AREAS[a] as string, a * 1000);
	}
	for (let a = 0; a < 20; a++) for (let c = 0; c < 24; c++) f.run(++id, a + 1, `${AREAS[a]}-${NOUNS[c]}`, c * 1000);
});

const LEAF0 = 21;
const LEAVES = 480;
const CASES = 100_000;
const headOf = new Int32Array(CASES + 1);
tx(() => {
	const k = db.prepare("INSERT INTO kase (id, project, ref_no, folder, rank, title, head_no, head_hash, rev) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)");
	const v = db.prepare("INSERT INTO version (case_id, no, parent, body, hash, claim_hash, seq) VALUES (?, ?, ?, ?, ?, ?, ?)");
	const s = db.prepare("INSERT INTO search_doc (rowid, text, project, folder) VALUES (?, ?, 1, ?)");
	for (let id = 1; id <= CASES; id++) {
		const folder = LEAF0 + ((id - 1) % LEAVES);
		const area = AREAS[Math.floor((folder - LEAF0) / 24)] as string;
		const versions = rnd() < 0.8 ? 1 : 2 + int(4);
		let body = "";
		let hash = "";
		let title = "";
		let text = "";
		for (let no = 1; no <= versions; no++) {
			title = `${area} ${pick(VERBS)} ${pick(ADJS)} ${pick(NOUNS)} ${id}`;
			const steps = [];
			const n = 3 + int(7);
			for (let i = 0; i < n; i++) {
				steps.push({
					id: `s${i + 1}`,
					action: `${pick(VERBS)} the ${pick(ADJS)} ${pick(NOUNS)} with code SAVE${int(100000)}`,
					expected: rnd() < 0.6 ? pick(EXPECT) : null,
				});
			}
			body = JSON.stringify({ title, pre: `signed in as a ${pick(ADJS)} user`, steps, methods: [{ m: "human" }], intent: { automate: "none" }, fields: {} });
			hash = sha(body).slice(0, 16);
			text = `${title} ${steps.map((x) => `${x.action} ${x.expected ?? ""}`).join(" ")}`;
			v.run(id, no, no === 1 ? null : no - 1, body, hash, sha(JSON.stringify(steps)).slice(0, 16), ++seq);
		}
		headOf[id] = versions;
		k.run(id, id, folder, Math.floor((id - 1) / LEAVES) * 1000, title, versions, hash, seq);
		s.run(id, text, folder);
	}
});

const TESTS = 20_000;
const LINKED = 15_000;
tx(() => {
	const t = db.prepare("INSERT INTO test (id, project, key, case_id, file) VALUES (?, 1, ?, ?, ?)");
	for (let id = 1; id <= TESTS; id++) {
		const fileNo = Math.floor((id - 1) / 50);
		const file = `tests/${AREAS[fileNo % 20]}/file${fileNo}.spec.ts`;
		t.run(id, `${file}::suite ${id % 7}::test number ${id}`, id <= LINKED ? id : null, file);
	}
});

const SIGS = 40;
tx(() => {
	const s = db.prepare("INSERT INTO signature (id, project, hash, class, sample) VALUES (?, 1, ?, ?, ?)");
	for (let id = 1; id <= SIGS; id++) {
		const sample = `expected ${pick(NOUNS)} to equal ${int(1000)}.00, got ${int(1000)}.00 in ${pick(AREAS)}.ts:${int(400)}`;
		s.run(id, sha(`sig${id}`).slice(0, 16), id % 10 === 0 ? "timeout" : "assertion", sample);
	}
});

const BATCHES = 200;
const PER_BATCH = 5000;
tx(() => {
	const tg = db.prepare("INSERT INTO target (id, project, commit_sha, env) VALUES (?, 1, ?, 'ci')");
	const b = db.prepare("INSERT INTO batch (id, project, key, target, job, attempt, state, seq) VALUES (?, 1, ?, ?, 'e2e', 1, 'processed', ?)");
	const r = db.prepare("INSERT INTO result (id, project, test, seq, ord, batch, target, outcome, basis, basis_case, basis_version, duration_ms, signature, message) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
	const run = db.prepare("INSERT INTO run (id, project, commit_sha, verdict, tally, outstanding, next_expiry, rev) VALUES (?, 1, ?, ?, ?, 0, NULL, ?)");
	let rid = 0;
	for (let bi = 1; bi <= BATCHES; bi++) {
		const commit = sha(`commit${bi}`).slice(0, 40);
		tg.run(bi, commit);
		const bseq = ++seq;
		b.run(bi, sha(`batch${bi}`).slice(0, 32), bi, bseq);
		let pass = 0;
		let fail = 0;
		const first = ((bi - 1) * 2500) % TESTS;
		for (let i = 0; i < PER_BATCH; i++) {
			const test = ((first + i) % TESTS) + 1;
			const x = rnd();
			const outcome = x < 0.97 ? "pass" : x < 0.99 ? "fail" : "skip";
			const linked = test <= LINKED;
			const sig = outcome === "fail" ? 1 + int(SIGS) : null;
			if (outcome === "pass") pass++;
			if (outcome === "fail") fail++;
			r.run(++rid, test, bseq, i, bi, bi, outcome, linked ? "assumed" : "unresolved", linked ? test : null,
				linked ? headOf[test] : null, 5 + int(3000), sig, sig ? `assertion failed in step ${int(9)} for signature ${sig}` : null);
		}
		run.run(bi, commit, fail ? "blocked" : "passed", JSON.stringify({ pass, excused: 0, attributed: 0, unexplained: fail, missing: 0, waived: 0, disputed: 0 }), bseq);
	}
});

tx(() => {
	const q = db.prepare("INSERT INTO question (id, project, ref_no, kind, fingerprint, epoch, state, owner, rank, evidence, evidence_hash, rev) VALUES (?, 1, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?)");
	const d = db.prepare("INSERT INTO decision (id, project, question, kind, answer, basis, seq) VALUES (?, 1, ?, 'failure', ?, ?, ?)");
	const KINDS = ["failure", "failure", "failure", "adopt", "map", "finding"];
	for (let id = 1; id <= 60_000; id++) {
		const open = id <= 50_000;
		const evidence = JSON.stringify({ signature: 1 + int(SIGS), tests: [1 + int(TESTS), 1 + int(TESTS), 1 + int(TESTS)], count: 1 + int(40),
			sample: `expected ${pick(NOUNS)} to equal ${int(1000)}.00, got ${int(1000)}.00`, hints: rnd() < 0.2 ? ["fails-on-base"] : [] });
		const eh = sha(evidence).slice(0, 16);
		q.run(id, id, pick(KINDS), sha(`fp${id}`).slice(0, 24), open ? "open" : "decided", id, evidence, eh, ++seq);
		if (!open) d.run(id - 50_000, id, JSON.stringify({ is: pick(["defect", "flaky", "infra", "expected"]) }), eh, ++seq);
	}
});

tx(() => {
	const c = db.prepare("INSERT INTO command (id, project, op, actor, seq, outcome) VALUES (?, 1, 'propose', 1, ?, ?)");
	for (let i = 1; i <= 100_000; i++) c.run(sha(`cmd${i}`).slice(0, 26), i, sha(`out${i}`).slice(0, 16));
});

db.run("UPDATE project SET seq = ? WHERE id = 1", [seq]);
db.exec("INSERT INTO search_doc (search_doc) VALUES ('optimize'); ANALYZE; PRAGMA wal_checkpoint(TRUNCATE);");
const count = (t: string) => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
const counts = Object.fromEntries(["folder", "kase", "version", "test", "target", "batch", "result", "signature", "question", "decision", "command", "run"].map((t) => [t, count(t)]));
console.log(JSON.stringify({ out, seq, counts }));

// Fixed inputs for the workloads, shared by every candidate.
state = 0x1234567;
const queries: string[] = [];
for (let i = 0; i < 500; i++) {
	const x = i % 5;
	if (x < 3) queries.push(pick([...NOUNS, ...ADJS, ...VERBS]));
	else if (x === 3) queries.push(`${pick(ADJS)} ${pick(NOUNS)}`);
	else queries.push(`SAVE${int(100000)}`);
}
writeFileSync(new URL("./queries.txt", import.meta.url), `${queries.join("\n")}\n`);
db.close();
