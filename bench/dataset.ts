import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statfsSync,
	writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { open } from "../src/app/start.ts";
import type { Edit, ReportInput, ResultIn, TargetIn } from "../src/core/ops.ts";
import { authenticate, createToken } from "../src/server/identity/identity.ts";
import { type App, type Config, SESSION_LIFETIMES } from "../src/server/kernel/app.ts";
import type { Actor } from "../src/server/kernel/ctx.ts";
import { MIGRATIONS } from "../src/server/kernel/migrate.ts";
import { call, Decisions, ensure, itemAt, Plan, Proposal, Queue, Receipt, Slots, TestPage } from "./contracts.ts";

const GENERATOR = 1;
export const Parameters = z
	.object({
		cases: z.number().int().min(1_000).default(100_000),
		tests: z.number().int().min(1).default(20_000),
		results: z.number().int().min(1).default(1_000_000),
		seed: z.number().int().nonnegative().default(639),
		openQuestions: z.number().int().nonnegative().default(50_000),
		queueTimeMs: z.number().int().positive().default(180_000),
	})
	.refine((p) => p.results >= p.tests + 5_000, "results must leave at least one report after test registration");
export type Parameters = z.infer<typeof Parameters>;

const Phase = z.object({
	name: z.string(),
	ms: z.number(),
	rows: z.number().int(),
	rowsPerSecond: z.number(),
	load: z.array(z.number()),
});
const Test = z.object({ ref: z.string(), key: z.string(), file: z.string(), name: z.string() });
export const Metadata = z.object({
	generator: z.literal(GENERATOR),
	fingerprints: z.object({ generator: z.string(), migrations: z.string() }),
	parameters: Parameters,
	project: z.literal("benchmark"),
	createdAt: z.string(),
	cases: z.array(z.object({ ref: z.string(), version: z.number().int() })),
	tests: z.array(Test),
	folders: z.array(z.object({ id: z.number().int(), path: z.string() })),
	hotFolder: z.number().int(),
	moveFolders: z.tuple([z.number().int(), z.number().int()]),
	lastCommit: z.string(),
	change: z.string(),
	files: z.array(z.string()),
	run: z.string(),
	runCases: z.array(z.string()),
	since: z.string(),
	counts: z.object({
		cases: z.number().int(),
		versions: z.number().int(),
		tests: z.number().int(),
		linked: z.number().int(),
		results: z.number().int(),
		open: z.number().int(),
		decided: z.number().int(),
		carried: z.number().int(),
	}),
	queueLimited: z.boolean(),
	phases: z.array(Phase),
});
export type Metadata = z.infer<typeof Metadata>;
export type Dataset = { dir: string; metadata: Metadata; reused: boolean };
export type DatasetInstance = {
	app: App;
	owner: Actor;
	ci: Actor;
	ciSecret: string;
	metadata: Metadata;
	dir: string;
	close: () => void;
};

/** Reuse requires the actual generator and migration contents, including embedded migrations in a compiled binary. */
export function fingerprints(): Metadata["fingerprints"] {
	const source = new URL("./dataset.ts", import.meta.url);
	const generator = existsSync(source)
		? readFileSync(source)
		: Buffer.from(
				[
					String(GENERATOR),
					buildDataset.toString(),
					random.toString(),
					testIdentity.toString(),
					generatedResults.toString(),
					JSON.stringify({ domains, actions, subjects, causes }),
				].join("\n"),
			);
	return {
		generator: new Bun.CryptoHasher("sha256").update(generator).digest("hex"),
		migrations: new Bun.CryptoHasher("sha256").update(JSON.stringify(MIGRATIONS)).digest("hex"),
	};
}

const domains = [
	"checkout",
	"billing",
	"identity",
	"inventory",
	"shipping",
	"returns",
	"catalog",
	"orders",
	"profile",
	"support",
	"payments",
	"pricing",
	"discount",
	"invoice",
	"account",
	"address",
	"session",
	"permission",
	"notification",
	"subscription",
];
const actions = ["creates", "updates", "validates", "removes", "restores", "confirms", "rejects", "retries"];
const subjects = [
	"basket",
	"voucher",
	"receipt",
	"delivery",
	"customer",
	"quantity",
	"balance",
	"credential",
	"reservation",
	"refund",
];
const causes = [
	...domains.map((word) => `${word} validation did not preserve the expected state`),
	...domains.map((word) => `${word} response omitted the required attribute`),
];

/** A reproducible integer stream; all generated choices depend only on this seed. */
export function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 4_294_967_296;
	};
}

/** Opens the production configuration on a real filesystem, with no benchmark pragma overrides. */
export function config(dir: string): Config {
	return {
		dataDir: dir,
		host: "127.0.0.1",
		port: 0,
		mode: "local",
		owner: "benchmark-owner",
		ownerToken: null,
		commit: null,
		...SESSION_LIFETIMES,
		proxy: null,
	};
}

/** Rejects memory filesystems so an apparent disk measurement cannot silently become a RAM measurement. */
export function requireDisk(dir: string): void {
	mkdirSync(dir, { recursive: true });
	const filesystem = statfsSync(dir);
	ensure(
		filesystem.type !== 0x01021994 && filesystem.type !== 0x858458f6,
		`benchmark data directory is on tmpfs/ramfs: ${dir}`,
	);
}

/** Creates and authenticates the same scoped CI identity used by the real operation tests. Secrets stay in memory. */
export async function ciActor(app: App): Promise<{ actor: Actor; secret: string }> {
	const { secret } = await createToken(app, {
		actor: "benchmark-ci",
		kind: "ci",
		can: ["read", "record"],
		project: 0,
		label: "benchmark",
	});
	const actor = await authenticate(app, secret, 0);
	ensure(actor !== null, "CI token must authenticate");
	return { actor, secret };
}

/** Reads persisted counts for the benchmark project; no dataset writes bypass the operation layer. */
export function counts(app: App): Metadata["counts"] {
	const count = (sql: string) => {
		const row = z.object({ n: z.number().int() }).parse(app.db.raw.query(sql).get());
		return row.n;
	};
	const project = "(SELECT id FROM projects WHERE key = 'benchmark')";
	return {
		cases: count(`SELECT count(*) AS n FROM cases WHERE project = ${project}`),
		versions: count(
			`SELECT count(*) AS n FROM versions WHERE case_id IN (SELECT id FROM cases WHERE project = ${project})`,
		),
		tests: count(`SELECT count(*) AS n FROM tests WHERE project = ${project} AND kind = 'auto'`),
		linked: count(
			`SELECT count(*) AS n FROM tests WHERE project = ${project} AND kind = 'auto' AND case_id IS NOT NULL`,
		),
		results: count(`SELECT count(*) AS n FROM results WHERE project = ${project}`),
		open: count(`SELECT count(*) AS n FROM questions WHERE project = ${project} AND state = 'open'`),
		decided: count(`SELECT count(*) AS n FROM questions WHERE project = ${project} AND state = 'decided'`),
		carried: count(`SELECT COALESCE(sum(carried), 0) AS n FROM questions WHERE project = ${project}`),
	};
}

/** The realistic automated identity for a test; 400 files at the default scale. */
export function testIdentity(index: number, testCount: number): { key: string; name: string; file: string } {
	const fileNo = index % Math.min(400, testCount);
	const domain = itemAt(domains, fileNo % domains.length);
	const file = `tests/${domain}/flow-${Math.floor(fileNo / domains.length)}.spec.ts`;
	const name = `${domain} ${itemAt(actions, index % actions.length)} ${itemAt(subjects, Math.floor(index / actions.length) % subjects.length)} scenario ${index}`;
	return { key: `${file}::customer journey::${name}`, name, file };
}

/** Generates a report with deterministic 2% failures across forty distinct causes and 1% skips. */
export function generatedResults(start: number, length: number, testCount: number, failures = true): ResultIn[] {
	return Array.from({ length }, (_, offset): ResultIn => {
		const index = start + offset;
		const residue = index % 100;
		const failure = failures && residue < 2;
		return {
			test: testIdentity(index % testCount, testCount),
			outcome: failure ? "fail" : failures && residue === 2 ? "skip" : "pass",
			durationMs: 12 + ((index * 17) % 3_000),
			...(failure ? { failure: { message: itemAt(causes, Math.floor(index / 100) % causes.length) } } : {}),
		};
	});
}

/** A fresh 10k report: 9,900 existing keys, 100 new keys, 200 failures, twenty causes, ten new causes. */
export function ingestInput(metadata: Metadata, id: string, size = 10_000): ReportInput {
	const newCount = Math.min(100, Math.floor(size / 100));
	const failureCount = Math.floor(size / 50);
	const knownCount = size - newCount;
	const results = Array.from({ length: size }, (_, index): ResultIn => {
		const known = itemAt(metadata.tests, index % metadata.tests.length);
		const test =
			index < size - newCount
				? { key: known.key, name: known.name, file: known.file }
				: {
						key: `tests/new/${id}.spec.ts::new scenario ${index}`,
						name: `new scenario ${index}`,
						file: `tests/new/${id}.spec.ts`,
					};
		const cause = index % 20;
		const failing = index >= knownCount - failureCount && index < knownCount;
		return {
			test,
			outcome: failing ? "fail" : "pass",
			durationMs: 20 + (index % 700),
			...(failing
				? {
						failure: {
							message:
								cause < 10
									? itemAt(causes, cause)
									: `New ${id.replace(/\d/g, (digit) => itemAt(["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"], Number(digit)))} ${itemAt(domains, cause)} assertion failed`,
						},
					}
				: {}),
		};
	});
	return {
		target: { commit: `bench-${id}`, repo: "example/mainworthy", branch: "main" },
		job: "e2e",
		attempt: 1,
		results,
	};
}

/** Verifies a fresh report wrote every supplied result, rather than timing a replay or a refused batch. */
export function verifyReport(app: App, receipt: z.infer<typeof Receipt>, expected: number): void {
	ensure(
		receipt.fresh && receipt.rejected.length === 0 && receipt.counts.total === expected,
		"report must be fresh and accept every result",
	);
	const row = z
		.object({ n: z.number().int() })
		.parse(app.db.raw.query("SELECT count(*) AS n FROM results WHERE batch = ?").get(receipt.batch));
	ensure(row.n === expected, `batch ${receipt.batch} persisted ${row.n}, expected ${expected}`);
}

/** Builds the immutable baseline through invoke, or reuses a matching completed baseline. */
export async function buildDataset(options: {
	dir: string;
	parameters: Parameters;
	log?: (message: string) => void;
}): Promise<Dataset> {
	const dir = resolve(options.dir);
	const parameters = Parameters.parse(options.parameters);
	const revision = fingerprints();
	const log = options.log ?? console.log;
	requireDisk(dir);
	const metadataPath = join(dir, "dataset.json");
	if (existsSync(metadataPath) && existsSync(join(dir, "mainworthy.db"))) {
		const saved = Metadata.safeParse(JSON.parse(readFileSync(metadataPath, "utf8")));
		if (
			saved.success &&
			JSON.stringify(saved.data.parameters) === JSON.stringify(parameters) &&
			JSON.stringify(saved.data.fingerprints) === JSON.stringify(revision)
		) {
			log(
				`Reusing dataset: ${dir} (${saved.data.counts.cases} cases, ${saved.data.counts.results} results, ${saved.data.counts.open} open questions)`,
			);
			return { dir, metadata: saved.data, reused: true };
		}
	}
	ensure(
		!existsSync(join(dir, "mainworthy.db")),
		`incomplete or mismatched dataset at ${dir}; choose a new directory or remove this benchmark dataset`,
	);
	const { app, owner } = await open(config(dir));
	const ci = (await ciActor(app)).actor;
	const phases: Metadata["phases"] = [];
	const phase = async <T>(name: string, rowCount: number | (() => number), work: () => T | Promise<T>): Promise<T> => {
		log(`Building ${name}…`);
		const start = performance.now();
		const result = await work();
		const ms = performance.now() - start;
		const load = loadavg();
		const rows = typeof rowCount === "number" ? rowCount : rowCount();
		phases.push({ name, ms, rows, rowsPerSecond: rows / (ms / 1_000), load });
		log(
			`${name}: ${rows.toLocaleString()} rows in ${(ms / 1_000).toFixed(2)} s, ${(rows / (ms / 1_000)).toFixed(0)} rows/s`,
		);
		return result;
	};
	try {
		await call(
			app,
			owner,
			"admin",
			{ do: "project.create", key: "benchmark", preset: "standard", unlinked: "ask" },
			z.unknown(),
		);
		const roots = Math.max(1, Math.min(20, Math.floor(parameters.cases / 250)));
		const folders = await phase("folders", roots * 25, async () => {
			const edits: Edit[] = [];
			for (let root = 0; root < roots; root++) {
				const domain = itemAt(domains, root);
				edits.push({ op: "folder", name: domain });
				for (let leaf = 0; leaf < 24; leaf++) edits.push({ op: "folder", name: `journey-${leaf}`, parent: domain });
			}
			const reply = await call(app, owner, "propose", { edits, reason: "Benchmark project structure" }, Proposal);
			ensure(reply.status === "adopted", "folder proposal must be adopted");
			const found = await call(
				app,
				owner,
				"find",
				{ in: "folders" },
				z.object({ items: z.array(z.object({ id: z.number().int(), path: z.string() })) }),
			);
			return found.items.filter((folder) => folder.path.includes("/"));
		});
		const rng = random(parameters.seed);
		const hotFolder = itemAt(folders, 0).id;
		const stamps = await phase("cases", parameters.cases, async () => {
			const out: Metadata["cases"] = [];
			for (let start = 0; start < parameters.cases; start += 1_000) {
				const edits = Array.from({ length: Math.min(1_000, parameters.cases - start) }, (_, offset): Edit => {
					const index = start + offset;
					const domain = itemAt(domains, index % domains.length);
					const subject = itemAt(subjects, Math.floor(rng() * subjects.length));
					const stepCount = 3 + Math.floor(rng() * 7);
					return {
						op: "create",
						folder: index % 10 === 0 ? hotFolder : itemAt(folders, index % folders.length).id,
						tags: [
							domain,
							index % 3 === 0 ? "smoke" : "regression",
							`priority-${index % 4}`,
							...(index % 100 === 0 ? ["benchrare"] : []),
						],
						covers: [`BENCH-${index % 100}`],
						body: {
							title: `${domain} ${itemAt(actions, index % actions.length)} ${subject} scenario ${index}${index % 997 === 0 ? " benchneedle" : ""}`,
							pre: "Customer has an active account and a valid basket. Verify access before checkout.",
							steps: Array.from({ length: stepCount }, (_, step) => ({
								id: `s${step.toString(36)}`,
								action: `${itemAt(actions, step % actions.length)} the ${subject} using the customer account in ${domain}`,
								expected:
									rng() < 0.6 ? `The ${subject} state is consistent and the customer receives a confirmation` : null,
							})),
							methods: index < parameters.tests ? ["human", "auto"] : ["human"],
							automate: index < parameters.tests ? "none" : "wanted",
						},
					};
				});
				const reply = await call(app, owner, "propose", { edits, reason: "Seeded customer journey cases" }, Proposal);
				ensure(reply.status === "adopted" && reply.cases.length === edits.length, "every created case must be adopted");
				out.push(...reply.cases.map(({ ref, version }) => ({ ref, version })));
				if (start % 10_000 === 0) log(`  cases ${out.length}/${parameters.cases}`);
			}
			return out;
		});
		const revisionCounts = stamps.map((_, index) => (index % 5 === 0 ? 1 + Math.floor(rng() * 5) : 0));
		await phase(
			"history edits",
			revisionCounts.reduce((a, b) => a + b, 0),
			async () => {
				for (let round = 0; round < 5; round++) {
					const selected = stamps.filter((_, index) => itemAt(revisionCounts, index) > round);
					for (let start = 0; start < selected.length; start += 1_000) {
						const batch = selected.slice(start, start + 1_000);
						const edits: Edit[] = batch.map((stamp) => ({
							op: "edit",
							case: stamp.ref,
							base: stamp.version,
							body: {
								pre: `Revision ${round + 1}: customer has an active account, a valid basket, and confirmed checkout access.`,
							},
						}));
						const reply = await call(
							app,
							owner,
							"propose",
							{ edits, reason: "Clarify customer account preconditions" },
							Proposal,
						);
						ensure(
							reply.status === "adopted" && reply.cases.length === batch.length,
							"history edits must all be adopted",
						);
						for (const stamp of batch) stamp.version++;
					}
				}
			},
		);
		let command = 0;
		let lastCommit = "";
		const send = async (results: ResultIn[], target?: TargetIn) => {
			lastCommit = `seed-${parameters.seed.toString(16)}-${(++command).toString(16).padStart(8, "0")}`;
			const input: ReportInput = {
				target: target ?? { commit: lastCommit, repo: "example/mainworthy", branch: "main" },
				job: "e2e",
				attempt: 1,
				results,
			};
			const receipt = await call(app, ci, "report", input, Receipt);
			verifyReport(app, receipt, results.length);
			return receipt;
		};
		await phase("test registration", parameters.tests, async () => {
			for (let start = 0; start < parameters.tests; start += 5_000)
				await send(generatedResults(start, Math.min(5_000, parameters.tests - start), parameters.tests, false));
		});
		const tests: Metadata["tests"] = [];
		const refs = new Map<string, string>();
		let cursor: string | null = null;
		do {
			const page: z.infer<typeof TestPage> = await call(
				app,
				owner,
				"find",
				{ in: "tests", limit: 500, ...(cursor ? { cursor } : {}) },
				TestPage,
			);
			for (const test of page.items) refs.set(test.key, test.ref);
			cursor = page.cursor;
		} while (cursor !== null);
		for (let index = 0; index < parameters.tests; index++) {
			const identity = testIdentity(index, parameters.tests);
			const ref = refs.get(identity.key);
			ensure(ref !== undefined, `test ${identity.key} must exist after registration`);
			tests.push({ ref, ...identity });
		}
		await phase("test linking", Math.ceil(parameters.tests * 0.75), async () => {
			const pairsByFile = new Map<string, [string, string][]>();
			tests.forEach((test, index) => {
				if (index % 4 === 3) return;
				const pairs = pairsByFile.get(test.file) ?? [];
				pairs.push([test.ref, itemAt(stamps, index % stamps.length).ref]);
				pairsByFile.set(test.file, pairs);
			});
			const queue = await call(app, owner, "inbox", { kind: "map", limit: 500 }, Queue);
			const all = queue.items.flatMap((question) => {
				const { file } = z.object({ file: z.string() }).parse(question.evidence);
				const pairs = pairsByFile.get(file);
				return pairs ? [{ q: question.q, onEvidence: question.evidenceHash, answer: { is: "link", pairs } }] : [];
			});
			if (all.length > 0) {
				const replies = await call(
					app,
					owner,
					"decide",
					{ all, reason: "Match existing automated journeys to authored cases" },
					Decisions,
				);
				ensure(
					replies.length === all.length && replies.every((reply) => reply.status === "decided"),
					"bulk map decisions must settle",
				);
			}
		});
		await phase("results", parameters.results - parameters.tests, async () => {
			for (let start = parameters.tests; start < parameters.results; start += 5_000) {
				await send(generatedResults(start, Math.min(5_000, parameters.results - start), parameters.tests));
				if (start === parameters.tests) {
					const queue = await call(app, owner, "inbox", { kind: "failure", limit: 50 }, Queue);
					const all = queue.items
						.slice(0, 10)
						.map((q) => ({ q: q.q, onEvidence: q.evidenceHash, answer: { is: "flaky" } }));
					if (all.length > 0)
						ensure(
							(
								await call(
									app,
									owner,
									"decide",
									{ all, reason: "Known intermittent customer environment checks" },
									Decisions,
								)
							).every((reply) => reply.status === "decided"),
							"failure decisions must settle",
						);
				}
				if (start % 100_000 < 5_000)
					log(`  results ${Math.min(parameters.results, start + 5_000)}/${parameters.results}`);
			}
		});
		const retried = tests.slice(0, 1);
		await phase("fail-then-pass retries", retried.length * 2, async () => {
			await send(
				retried.map((test) => ({
					test: { key: test.key, name: test.name, file: test.file },
					outcome: "fail",
					durationMs: 120,
					failure: { message: "Customer journey passed only on retry" },
				})),
			);
			const receipt = await call(
				app,
				ci,
				"report",
				{
					target: { commit: lastCommit, repo: "example/mainworthy", branch: "main" },
					job: "e2e",
					attempt: 2,
					results: retried.map((test) => ({
						test: { key: test.key, name: test.name, file: test.file },
						outcome: "pass",
						durationMs: 80,
					})),
				},
				Receipt,
			);
			verifyReport(app, receipt, retried.length);
		});
		const base = lastCommit;
		const files = [...new Set(tests.map((test) => test.file))].slice(0, 20);
		let scope = 0;
		let openQuestions = (await call(app, owner, "inbox", { limit: 1 }, Queue)).counts.open ?? 0;
		const initialOpen = openQuestions;
		const queueStart = performance.now();
		await phase(
			"PR scopes and open queue",
			() => openQuestions - initialOpen,
			async () => {
				do {
					const remaining = Math.max(1, Math.min(40, parameters.openQuestions - openQuestions));
					const results = Array.from(
						{ length: remaining },
						(_, index): ResultIn => ({
							test: testIdentity((scope * 40 + index) % parameters.tests, parameters.tests),
							outcome: "fail",
							failure: { message: itemAt(causes, index) },
							durationMs: 70,
						}),
					);
					const receipt = await send(results, {
						commit: `queue-${parameters.seed}-${scope.toString(16).padStart(8, "0")}`,
						repo: "example/mainworthy",
						branch: `feature/journey-${scope}`,
						pr: 10_000 + scope,
						base,
						files,
						title: "Refine customer journey requirements",
					});
					openQuestions += receipt.questions.filter((q) => q.how === "new" && q.state === "open").length;
					scope++;
					if (scope % 100 === 0) log(`  open questions ${openQuestions}/${parameters.openQuestions}`);
				} while (
					(scope < 3 || openQuestions < parameters.openQuestions) &&
					performance.now() - queueStart < parameters.queueTimeMs
				);
			},
		);
		const runCases = stamps.slice(0, 500).map((stamp) => stamp.ref);
		const planned = await phase("planned run", 500, async () => {
			const run = await call(
				app,
				owner,
				"plan",
				{
					name: "Customer acceptance exercise",
					select: { cases: runCases },
					require: [{ id: "manual", kind: "exercise", methods: ["human"], basis: "exact", minActors: 1 }],
				},
				Plan,
			);
			ensure(run.slots === 500 && run.already === 0, "plan must pin 500 initially missing slots");
			const receipt = await call(
				app,
				owner,
				"report",
				{
					run: run.run,
					results: runCases
						.slice(0, 250)
						.map((ref): ResultIn => ({ test: { case: ref }, outcome: "pass", durationMs: 300 })),
				},
				Receipt,
			);
			verifyReport(app, receipt, 250);
			const slots = await call(app, owner, "find", { in: "slots", run: run.run, limit: 500 }, Slots);
			ensure(
				slots.items.filter((slot) => slot.state === "satisfied").length === 250 &&
					slots.items.filter((slot) => slot.state === "missing").length === 250,
				"planned run must be half filled",
			);
			return run.run;
		});
		const stored = counts(app);
		ensure(
			stored.cases === parameters.cases && stored.tests === parameters.tests,
			"dataset counts must match requested cases and automated tests",
		);
		ensure(
			stored.linked === parameters.tests - Math.floor(parameters.tests / 4),
			"three quarters of automated tests must be linked",
		);
		ensure(
			stored.decided > 0 && (parameters.results < parameters.tests + 10_000 || stored.carried > 0),
			"the dataset must contain decided and carried questions",
		);
		const current = (
			await call(
				app,
				owner,
				"since",
				{ cursor: `s:${Number.MAX_SAFE_INTEGER}`, limit: 1 },
				z.object({ cursor: z.string() }),
			)
		).cursor;
		const metadata: Metadata = {
			generator: GENERATOR,
			fingerprints: revision,
			parameters,
			project: "benchmark",
			createdAt: new Date().toISOString(),
			cases: stamps,
			tests,
			folders,
			hotFolder,
			moveFolders: [itemAt(folders, 1).id, itemAt(folders, 2).id],
			lastCommit: base,
			change: "pr:10000",
			files,
			run: planned,
			runCases,
			since: `s:${Math.max(0, Number(current.slice(2)) - 300)}`,
			counts: stored,
			queueLimited: stored.open < parameters.openQuestions,
			phases,
		};
		log(
			`Verified dataset: ${JSON.stringify(stored)}; queue ${metadata.queueLimited ? "time-limited" : "target reached"}`,
		);
		app.close();
		writeFileSync(metadataPath, JSON.stringify(metadata));
		return { dir, metadata, reused: false };
	} catch (error) {
		app.close();
		throw error;
	}
}

/** Clones the closed WAL baseline so every repeated run starts with identical history and removes its writes on close. */
export async function openDataset(dataset: Dataset, dir: string): Promise<DatasetInstance> {
	requireDisk(dir);
	copyFileSync(join(dataset.dir, "mainworthy.db"), join(dir, "mainworthy.db"), constants.COPYFILE_FICLONE);
	const { app, owner } = await open(config(dir));
	const ci = await ciActor(app);
	ensure(
		z.object({ journal_mode: z.literal("wal") }).safeParse(app.db.raw.query("PRAGMA journal_mode").get()).success,
		"on-disk database must use production WAL mode",
	);
	return {
		app,
		owner,
		ci: ci.actor,
		ciSecret: ci.secret,
		metadata: dataset.metadata,
		dir,
		close() {
			app.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
