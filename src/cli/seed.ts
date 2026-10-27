// The demo: a shop's suite, the days of pipeline reports, runs, edits and reviews that came before today, and
// today's open questions. It is written through the operations a person, a pipeline and an agent would use, so
// a project filled here holds nothing those three could not have left. What it writes is decided in
// `src/cli/demo/` from a seed; this file sends it, each request with the time it happened at.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Api } from "../core/api.ts";
import { type ActorKind, type Capability, PolicySettings } from "../core/kinds.ts";
import { ProposeReply } from "../core/ops.ts";
import type { DemoSeed } from "../server/kernel/ctx.ts";
import type { Client } from "./client.ts";
import { automateOf, type DemoCase, demoBulkProposal, demoCases, random, requirementOf } from "./demo/cases.ts";
import { DEMO_FIELDS, demoAliases, demoFields } from "./demo/fields.ts";
import {
	AGENT_MODEL,
	dayStart,
	demoHistory,
	type Failure,
	hex,
	LANDED_CHANGE,
	pipelineSpan,
	REPO,
	REVIEW_CHANGE,
	todayAt,
} from "./demo/history.ts";
import { demoAgentScreenshot, demoScreenshot, demoTrail } from "./demo/trails.ts";
import { DEMO_WORK } from "./demo/work.ts";
import { CliError } from "./errors.ts";

export type SeedResult = z.infer<typeof DemoSeed>;

/** The most cases one seed writes: the size the benchmark measures (`bench/`). */
export const MAX_SEED_CASES = 100_000;
export const DEFAULT_SEED_CASES = 2000;
/** The seed a demo is made from when none is given: the same demo for everybody who does not ask for another. */
export const DEFAULT_SEED = 1;
/** How many days of history a demo holds before today, and the most it can be asked for. */
export const DEFAULT_SEED_DAYS = 14;
export const MAX_SEED_DAYS = 90;

/** The most files of unit tests one seed reports: one open question each. */
export const MAX_SEED_UNLINKED_FILES = 500;

const AREAS = ["cart", "checkout", "accounts", "orders", "catalog", "shipping", "tax", "search", "notify", "api"];
const UNITS = ["totals", "rounding", "validation", "limits", "retries", "locale", "cache", "permissions", "parse"];
const CHECKS = [
	"accepts a plain value",
	"refuses an empty value",
	"keeps the order",
	"rounds half up",
	"is idempotent",
];

/**
 * The unit tests of the shop, which no case names: `files` files of one to nine tests each, the same every time.
 * A real repository's pipeline reports hundreds of these beside the few tests that are linked to cases. The
 * demo asks about tests with no case, so each file is one open question, and every one of them wants the same
 * answer. That is the queue a person meets on their first real project, kept here so that answering many rows
 * at once can be tried against it.
 */
export function unitTests(files: number): Api["report"]["input"]["results"] {
	return Array.from({ length: files }, (_, f) => {
		const area = AREAS[f % AREAS.length] ?? "cart";
		const unit = UNITS[Math.floor(f / AREAS.length) % UNITS.length] ?? "totals";
		const round = Math.floor(f / (AREAS.length * UNITS.length));
		const file = `tests/unit/${area}/${unit}${round === 0 ? "" : `-${round + 1}`}.test.ts`;
		return Array.from({ length: 1 + ((f * 7) % 9) }, (_, t) => {
			const name = `${unit} ${CHECKS[t % CHECKS.length] ?? "works"}${t < CHECKS.length ? "" : ` (${t + 1})`}`;
			return { test: { key: `${file}::${unit}::${name}`, name, file }, outcome: "pass" as const };
		});
	}).flat();
}

const Projects = z.array(z.object({ key: z.string(), identity: z.string() }));
const Actors = z.array(z.object({ name: z.string(), kind: z.string() }));
const Token = z.object({ id: z.number(), token: z.string() });
const PolicyShown = z.object({ version: z.number(), settings: PolicySettings });
const Proposed = z.object({ question: z.string().nullable() });
const Demo = z.object({ since: z.number() });
const Question = z.object({ q: z.string(), state: z.string(), evidenceHash: z.string() });
const UnlinkedTest = z.object({ ref: z.string(), key: z.string(), file: z.string() });
const MapEvidence = z.object({ file: z.string() });

type Producer = { actor: string; kind: Exclude<ActorKind, "rule">; can: Capability[]; label: string };
const PIPELINE: Producer = { actor: "pipeline", kind: "ci", can: ["read", "record"], label: "Demo pipeline" };
const REVIEWER: Producer = {
	actor: "reviewer",
	kind: "agent",
	can: ["read", "produce", "answer"],
	label: "Demo reviewer",
};

const HOUR = 3_600_000;
const MINUTE = 60_000;
type Result = Api["report"]["input"]["results"][number];

/**
 * Fills `project` with the demo, as whoever `client` signs in as: a person who administers the instance. The
 * project is made when the instance has none of that name, and made a demo (decision 0100): its history is dated
 * in the days before the moment it became one. One that holds cases, tests or runs is left alone, unless this
 * caller's seed began there: every write to the project carries a command id and the same time as before, so
 * sending the same seed again finishes one that stopped and writes nothing in the project twice. It does make
 * the two tokens again.
 *
 * What can refuse the caller comes first, so nothing is made for a seed that cannot be finished. The pipeline
 * and the agent are given a grant on this project alone, and their tokens are revoked when the seed ends, or end
 * after an hour if it stops first: nothing that could still sign in is left behind.
 */
export async function seed(client: Client, options: SeedOptions): Promise<SeedResult> {
	const issued: number[] = [];
	try {
		return await fill(client, options, issued);
	} finally {
		await revokeProducers(client.with({ project: options.project }), issued);
	}
}

type SeedOptions = {
	project: string;
	cases: number;
	seed?: number;
	days?: number;
	unlinkedFiles?: number;
	/**
	 * The identity of the project this seed is for, when its caller chose the project (a demo refresh). A seed that finds
	 * another project under the key is refused before it writes anything, and makes none.
	 */
	projectIdentity?: string;
};

/** A repeatable seed write, scoped to the project's identity so a replacement cannot replay its predecessor. */
export function seedCommandId(identity: string, step: string): string {
	return createHash("sha256").update(`demo:${identity}:${step}:v2`).digest("hex");
}

/** What `seed` writes. */
async function fill(client: Client, options: SeedOptions, issued: number[]): Promise<SeedResult> {
	const { project, cases, unlinkedFiles = 0 } = options;
	const seedNumber = options.seed ?? DEFAULT_SEED;
	const days = options.days ?? DEFAULT_SEED_DAYS;
	if (!Number.isInteger(cases) || cases < 1 || cases > MAX_SEED_CASES)
		throw new CliError("invalid", `seed writes from 1 to ${MAX_SEED_CASES} cases, not ${cases}`);
	if (!Number.isInteger(unlinkedFiles) || unlinkedFiles < 0 || unlinkedFiles > MAX_SEED_UNLINKED_FILES)
		throw new CliError(
			"invalid",
			`seed reports from 0 to ${MAX_SEED_UNLINKED_FILES} files of tests with no case, not ${unlinkedFiles}`,
		);
	if (!Number.isInteger(seedNumber) || seedNumber < 0 || seedNumber > 0xffff_ffff)
		throw new CliError("invalid", `the seed is a whole number from 0 to ${0xffff_ffff}, not ${seedNumber}`);
	if (!Number.isInteger(days) || days < 0 || days > MAX_SEED_DAYS)
		throw new CliError("invalid", `seed writes from 0 to ${MAX_SEED_DAYS} days of history, not ${days}`);
	const as = (token: string | undefined) => client.with({ token, project });
	const owner = as(client.options.token);
	const actors = await refuseProducers(owner);
	const known = (producer: Producer) => actors.find((row) => row.name === producer.actor);
	const identityNow = async () =>
		Projects.parse(await owner.call("admin", { do: "project.list" })).find((row) => row.key === project)?.identity;
	const replaced = new CliError("conflict", `project ${project} was replaced since this seed was started for it`);
	const listed = await identityNow();
	if (options.projectIdentity !== undefined && listed !== options.projectIdentity) throw replaced;
	const exists = listed !== undefined;
	if (!exists) await owner.call("admin", { do: "project.create", key: project });
	const identity = await identityNow();
	if (!identity) throw new CliError("conflict", "the demo project no longer exists");
	if (options.projectIdentity !== undefined && identity !== options.projectIdentity) throw replaced;
	const id = (step: string) => seedCommandId(identity, step);
	const begun = exists && (await owner.call("command", { cmd: id("folders") })).state !== "none";
	const taken = new CliError(
		"conflict",
		`project ${project} already holds cases, tests or runs; seed fills a new project or an empty one`,
	);
	if (exists && !begun && (await holdsWork(owner))) throw taken;
	// The moment the project became a demo, by the server's clock: today, for this demo, however often it is sent.
	const { since } = Demo.parse(
		await owner.call("admin", { do: "project.demo", key: project }).catch((error: unknown) => {
			// It holds no case, test or run, and something was written to it all the same: a folder, a policy.
			throw error instanceof CliError && error.code === "conflict" ? taken : error;
		}),
	);
	const signIn = async (producer: Producer) => {
		const { actor, kind, can } = producer;
		const label = labelOf(producer, project);
		// A new token names the grant its actor holds. An actor from an earlier seed is given this project's first.
		if (known(producer)) await owner.call("admin", { do: "grant.set", actor, project, can });
		const token = Token.parse(
			await owner.call("admin", { do: "token.create", actor, kind, can, project, label, expires: "1h" }),
		);
		issued.push(token.id);
		return as(token.token);
	};
	const ci = await signIn(PIPELINE);
	const agent = await signIn(REVIEWER);

	/**
	 * One write of the demo: under its own command id, at the time it happened, and only into the project the seed
	 * began in: a project made in its place under the same key refuses it (`projectIdentity`), so one seed's writes
	 * never land in another's demo. The id is bound to the request, so a seed sent again with other cases, another
	 * seed or other days is another request, and is refused here in words about the seed.
	 */
	const write = async <N extends "propose" | "report" | "claim" | "plan" | "decide" | "change">(
		who: Client,
		op: N,
		step: string,
		at: number,
		input: Api[N]["input"],
	): Promise<Api[N]["reply"]> =>
		who.call(op, { ...input, cmd: id(step), projectIdentity: identity }, at).catch(async (error: unknown) => {
			if (!(error instanceof CliError && error.code === "conflict")) throw error;
			if ((await identityNow()) !== identity) throw replaced;
			if (begun)
				throw new CliError(
					"conflict",
					`project ${project} was seeded with another number of cases, another seed or other days; send those again, or seed another project`,
				);
			throw error;
		});

	/** A person's answer to each of these questions. One answered by an earlier attempt of this seed is left as it is. */
	const answer = async (
		questions: readonly string[],
		step: string,
		at: number,
		given: { answer: Record<string, unknown>; reason?: string },
	) => {
		for (const [n, q] of questions.entries()) {
			const name = questions.length > 1 ? `${step}${n}` : step;
			if ((await owner.call("command", { cmd: id(name) })).state === "done") continue;
			const [question] = z.array(Question).parse(await owner.call("get", { refs: [q] }));
			if (question?.state !== "open") continue;
			await write(owner, "decide", name, at, { q, onEvidence: question.evidenceHash, ...given });
		}
	};

	// ── The suite, written on the first morning of the history, under the policy the project keeps. ──
	const suite = demoCases(seedNumber, cases);
	const suiteAt = days > 0 ? dayStart(since, days) + 8 * HOUR : since - 6 * HOUR;
	// `standard` asks a person which case a new test covers, and asks one before an agent's edit is adopted.
	const policy = await write(owner, "propose", "standard", suiteAt - MINUTE, {
		edits: [{ op: "policy", preset: "standard", unlinked: "ask" }],
	});
	if (policy.question) await answer([policy.question], "standard-yes", suiteAt - MINUTE, { answer: { is: "accept" } });
	// The project's own fields, defined on the policy in force (decision 0052). The edit is built from what is in
	// force, so a seed sent again reads the reply the first one was given instead of sending it again, and answers
	// its question if that one stopped before it did.
	const sent = await owner.call("command", { cmd: id("fields") });
	let fields: z.infer<typeof Proposed>;
	if (sent.state === "done") fields = Proposed.parse(sent.reply);
	else {
		const current = PolicyShown.parse(await owner.call("admin", { do: "policy.show", project }));
		fields = await write(owner, "propose", "fields", suiteAt - MINUTE / 2, {
			edits: [{ op: "policy", base: current.version, settings: { ...current.settings, fields: DEMO_FIELDS } }],
		});
	}
	if (fields.question)
		await answer([fields.question], "fields-yes", suiteAt - MINUTE / 2, { answer: { is: "accept" } });
	const folders = [...new Set(suite.map((item) => item.folder))];
	const made = new Set<string>();
	const folderEdits: Api["propose"]["input"]["edits"] = [];
	for (const path of folders) {
		const parts = path.split("/");
		parts.forEach((name, depth) => {
			const whole = parts.slice(0, depth + 1).join("/");
			if (made.has(whole)) return;
			made.add(whole);
			folderEdits.push({ op: "folder", name, ...(depth > 0 ? { parent: parts.slice(0, depth).join("/") } : {}) });
		});
	}
	await write(owner, "propose", "folders", suiteAt, { edits: folderEdits });
	const refs: string[] = [];
	for (let bucket = 0; bucket < cases; bucket += 250) {
		for (let offset = bucket; offset < Math.min(bucket + 250, cases); offset += 64) {
			const edits: Api["propose"]["input"]["edits"] = suite
				.slice(offset, Math.min(offset + 64, bucket + 250))
				.map((item, n) => {
					const aliases = demoAliases(item, offset + n);
					return {
						op: "create",
						folder: item.folder,
						tags: item.tags,
						...(aliases.length > 0 ? { aliases } : {}),
						body: {
							title: item.title,
							pre: item.pre,
							methods: ["human", "auto", "agent"],
							automate: automateOf(item, offset + n),
							// The first case is the one today's questions are about, and the tests of the web app read it.
							fields: offset + n === 0 ? {} : demoFields(item),
							steps: item.steps,
						},
					};
				});
			const at = suiteAt + Math.min((bucket / 250) * 5_000, 25 * MINUTE);
			const reply = await write(owner, "propose", `cases-${offset}`, at, { edits });
			refs.push(...reply.cases.map((item) => item.ref));
		}
	}
	// Each case covers the requirement of its feature, which the coverage report reads (decision 0095).
	for (let offset = 0; offset < cases; offset += 64) {
		const edits: Api["propose"]["input"]["edits"] = suite.slice(offset, offset + 64).flatMap((item, n) => {
			const ref = refs[offset + n];
			const requirement = requirementOf(item.folder);
			return ref && requirement
				? [{ op: "cover", case: ref, requirement: requirement.key, title: requirement.title, on: true }]
				: [];
		});
		if (edits.length > 0) await write(owner, "propose", `covers-${offset}`, suiteAt + 26 * MINUTE, { edits });
	}
	const first = refs[0];
	if (!first) throw new CliError("internal", "the server created no case");
	const refOf = (index: number): string => {
		const ref = refs[index];
		if (!ref) throw new CliError("internal", `the demo names case ${index}, which the server did not create`);
		return ref;
	};
	const caseOf = (index: number): DemoCase => {
		const item = suite[index];
		if (!item) throw new CliError("internal", `the demo names case ${index}, which it did not plan`);
		return item;
	};

	// ── What a pipeline reports: every automated case, each as the test that covers it. ──
	const tests = suite.flatMap((item, index) => (item.test ? [{ index, test: item.test }] : []));
	const pipelineResults = (
		failures: readonly Failure[],
		jitter: number,
		attach = false,
		only: readonly number[] | null = null,
		retried: readonly Failure[] = [],
	): Result[] =>
		tests.flatMap(({ index, test }, n) => {
			if (only && !only.includes(index)) return [];
			const failure = failures.find((item) => item.case === index);
			const tried = failure ? undefined : retried.find((item) => item.case === index);
			const result = {
				test,
				outcome: failure ? "fail" : "pass",
				durationMs: Math.round((300 + ((n * 7919) % 4200)) * (0.85 + jitter * 0.3)),
				...(failure ? { failure: { message: failure.message } } : {}),
				// Today's failure carries the trace the test runner wrote, as a pipeline attaches it.
				...(failure && attach ? { attachments: [traceOf(test.name, failure.message), demoScreenshot] } : {}),
				...(attach && n < 2
					? { steps: demoTrail(caseOf(index).steps, Boolean(failure), failure ? 1 : undefined) }
					: {}),
				annotation: { case: refOf(index), version: 1 },
				// The runner failed it once and passed it on its own retry, inside this run (decision 0129).
				...(tried ? { tries: [{ outcome: "fail" as const, failure: { message: tried.message } }] } : {}),
			} satisfies Result;
			return [result];
		});

	/** The shop job's report of these results, uploaded at `at`: its runner names when it started and ended them. */
	const shop = (at: number, results: Result[]) => ({ job: "shop", span: pipelineSpan(at, results), results });

	// Use ordinary report shards so a seed never holds the writer for all automated cases at once.
	const report = async (
		who: Client,
		step: string,
		at: number,
		input: Api["report"]["input"],
	): Promise<Api["report"]["reply"]> => {
		// Keep the demonstration's explicit two-of-three runner story intact.
		if (input.shard) return write(who, "report", step, at, input);
		const chunks = Math.max(1, Math.ceil(input.results.length / 128));
		if (chunks === 1) return write(who, "report", step, at, input);
		let last: Api["report"]["reply"] | null = null;
		const questions = new Map<string, Api["report"]["reply"]["questions"][number]>();
		for (let part = 0; part < chunks; part++) {
			const results = input.results.slice(part * 128, (part + 1) * 128);
			const receipt = await write(who, "report", `${step}-part-${part}`, at, {
				...input,
				results,
				...(results.length === 0 ? { nothingRequired: true } : {}),
				shard: {
					index: part + 1,
					of: chunks,
				},
			});
			for (const question of receipt.questions) questions.set(question.q, question);
			last = receipt;
		}
		if (last === null) throw new Error("a report shard was not sent");
		return { ...last, questions: [...questions.values()] };
	};

	/**
	 * Links the tests the pipeline has reported to the cases they cover, as a person does on the day a pipeline
	 * first reports: one answer for each file of tests the queue asks about.
	 */
	const linkTests = async (at: number) => {
		const caseByKey = new Map(tests.map(({ index, test }) => [test.key, refOf(index)]));
		const byFile = new Map<string, [string, string][]>();
		for (let cursor: string | null | undefined; cursor !== null; ) {
			const page = await owner.call("find", { in: "tests", unlinked: true, limit: 500, ...(cursor ? { cursor } : {}) });
			for (const row of z.array(UnlinkedTest).parse(page.items)) {
				const covers = caseByKey.get(row.key);
				if (covers) byFile.set(row.file, [...(byFile.get(row.file) ?? []), [row.ref, covers]]);
			}
			cursor = page.cursor;
		}
		const asked = await owner.call("inbox", { kind: "map", limit: 500 });
		for (const question of asked.items) {
			const pairs = byFile.get(MapEvidence.parse(question.evidence).file);
			if (!pairs) continue;
			await write(owner, "decide", `l-${question.q}`, at, {
				q: question.q,
				onEvidence: question.evidenceHash,
				answer: { is: "link", pairs },
			});
		}
	};

	// ── The history, in the order it happened. ──
	const opened = new Map<string, string[]>();
	const runs = new Map<string, string>();
	const stillOpen = (questions: Api["report"]["reply"]["questions"]) =>
		questions.filter((item) => item.state === "open").map((item) => item.q);
	for (const event of demoHistory({ seed: seedNumber, cases: suite, days, since })) {
		switch (event.kind) {
			case "pipeline": {
				const receipt = await report(ci, event.step, event.at, {
					target: { ...event.target, repo: REPO },
					...(event.rerun ? { attempt: event.rerun.attempt } : {}),
					...shop(
						event.at,
						pipelineResults(event.failures, event.jitter, false, event.rerun?.cases ?? null, event.retried ?? []),
					),
				});
				opened.set(event.step, stillOpen(receipt.questions));
				break;
			}
			case "link":
				await linkTests(event.at);
				break;
			case "answer":
				await answer(opened.get(event.of) ?? [], event.step, event.at, {
					answer: event.answer,
					reason: event.reason,
				});
				break;
			case "plan": {
				const planned = await write(owner, "plan", event.step, event.at, {
					name: event.name,
					select: { cases: event.cases.map(refOf) },
				});
				runs.set(event.name, planned.run);
				break;
			}
			case "execute": {
				const run = runs.get(event.run);
				if (!run) throw new CliError("internal", `the demo works through ${event.run} before planning it`);
				const receipt = await report(owner, event.step, event.at, {
					run,
					results: event.results.map((result) => {
						const steps = caseOf(result.case).steps;
						const last = steps.at(-1)?.id;
						return {
							test: { case: refOf(result.case) },
							outcome: result.failed ? "fail" : "pass",
							steps: steps.map((step) => ({
								step: step.id,
								outcome: result.failed && step.id === last ? "fail" : "pass",
							})),
							...(result.failed
								? {
										failure: { message: result.failed.message, ...(last ? { at: last } : {}) },
										note: result.failed.note,
									}
								: {}),
						} satisfies Result;
					}),
				});
				opened.set(event.step, stillOpen(receipt.questions));
				break;
			}
			case "edit": {
				const steps = caseOf(event.case).steps;
				const n = steps.length;
				await write(owner, "propose", event.step, event.at, {
					reason: event.reason,
					edits: [
						{
							op: "edit",
							case: refOf(event.case),
							base: 1,
							body: { steps: [...steps, { id: `${String.fromCharCode(97 + n)}${n + 1}`, ...event.add }] },
						},
					],
				});
				break;
			}
			case "end":
				await write(ci, "change", event.step, event.at, { change: `pr:${event.pr}`, state: "merged" });
				break;
			case "archive":
				await write(owner, "propose", event.step, event.at, {
					reason: event.reason,
					edits: [{ op: "state", cases: event.cases.map(refOf), to: "archived" }],
				});
				break;
			case "quarantine": {
				const prior = await owner.call("command", { cmd: id(event.step) });
				let proposed: Api["propose"]["reply"];
				if (prior.state === "done") proposed = ProposeReply.parse(prior.reply);
				else {
					const test = caseOf(event.case).test;
					const rows = z.array(UnlinkedTest).parse((await owner.call("find", { in: "tests", text: test?.key })).items);
					const ref = rows.find((row) => row.key === test?.key)?.ref;
					if (!ref) throw new CliError("internal", "the demo quarantine requires its reported test");
					const [detail] = z
						.array(z.object({ quarantine: z.object({ decision: z.number() }).nullable() }))
						.parse(await owner.call("get", { refs: [ref] }));
					proposed = await write(owner, "propose", event.step, event.at, {
						edits: [
							{
								op: "quarantine",
								test: ref,
								base: detail?.quarantine?.decision ?? null,
								exit: event.active ? { kind: "person" } : null,
							},
						],
						reason: event.reason,
					});
				}
				if (proposed.question)
					await answer([proposed.question], `${event.step}a`, event.at, {
						answer: { is: "accept" },
						reason: event.reason,
					});
				break;
			}
			case "review": {
				const on = caseOf(event.finding.case).steps[0]?.id;
				const claimed = await write(agent, "claim", event.step, event.at, {
					lens: "adversarial-review",
					about: `pr:${event.about}`,
					findings: [
						{
							on: on ? `${refOf(event.finding.case)}#${on}` : refOf(event.finding.case),
							category: event.finding.category,
							note: event.finding.note,
						},
					],
				});
				opened.set(event.step, claimed.opened);
				break;
			}
			default: {
				const _exhaustive: never = event;
				throw new CliError("internal", `the demo holds an event it cannot write: ${JSON.stringify(_exhaustive)}`);
			}
		}
	}

	// ── Today: `main` went red an hour and a half after it was green, and a pull request inherits the failure. ──
	const today = random(seedNumber ^ 0x5bd1e995);
	const [green, red, change] = [hex(today), hex(today), hex(today)];
	const broken: Failure[] = [{ case: 0, message: "expected $90.00, got $100.00" }];
	const before = (ago: number): number => todayAt(since, ago);
	await report(ci, "green", before(4.5 * HOUR), {
		target: { commit: green, repo: REPO, branch: "main" },
		...shop(before(4.5 * HOUR), pipelineResults([], 0.5)),
	});
	// A demo with no history links its tests now, on the first report there is.
	if (days === 0) await linkTests(before(4 * HOUR));
	await report(ci, "red", before(3 * HOUR), {
		target: { commit: red, repo: REPO, ...LANDED_CHANGE },
		...shop(before(3 * HOUR), pipelineResults(broken, 0.4, true)),
	});
	await write(ci, "change", "red-landing", before(3 * HOUR - MINUTE), {
		change: `pr:${LANDED_CHANGE.pr}`,
		state: "merged",
		landing: { commit: red, branch: "main" },
	});
	await report(ci, "pr", before(2 * HOUR), {
		target: {
			commit: change,
			repo: REPO,
			...REVIEW_CHANGE,
			base: red,
		},
		...shop(before(2 * HOUR), pipelineResults(broken, 0.6, true)),
	});
	// Another pull request, whose pipeline runs its tests in three shards: two have reported and pass, and its gate
	// waits for the third (decision 0092). Its commit is drawn from a stream of its own, so nothing else moves.
	const sharded = hex(random(seedNumber ^ 0x27d4eb2f));
	const shardResults = pipelineResults([], 0.55);
	// A demo with fewer than two automated cases has nothing to put in the second shard, and leaves it out.
	for (const index of shardResults.length >= 2 ? [1, 2] : []) {
		await report(ci, `shard-${index}`, before((80 - index * 5) * MINUTE), {
			target: {
				commit: sharded,
				repo: REPO,
				branch: "shipping-estimate",
				pr: 483,
				base: red,
				title: "Show the shipping estimate in the cart",
				files: ["src/cart.ts"],
			},
			shard: { index, of: 3 },
			...shop(
				before((80 - index * 5) * MINUTE),
				shardResults.filter((_, n) => n % 3 === index - 1),
			),
		});
	}
	const checkout = suite.flatMap((item, index) => (item.folder.startsWith("Checkout") ? [refOf(index)] : []));
	const planned = await write(owner, "plan", "run", before(90 * MINUTE), {
		name: "Checkout regression",
		select: { cases: checkout.slice(0, 40) },
		accepts: { commit: change, repo: REPO },
	});
	const agentCase = refs[1] ?? first;
	const agentRun = await write(owner, "plan", "agent-run", before(85 * MINUTE), {
		name: "Agent checkout check",
		select: { cases: [agentCase] },
		accepts: { commit: change, repo: REPO },
		require: [{ id: "agent", kind: "exercise", methods: ["human", "agent"], minActors: 1, basis: "exact" }],
	});
	await report(owner, "agent-person-result", before(82 * MINUTE), {
		run: agentRun.run,
		results: [{ test: { case: agentCase }, outcome: "pass" }],
	});
	await report(agent, "agent-results", before(80 * MINUTE), {
		run: agentRun.run,
		model: AGENT_MODEL,
		results: [
			{
				test: { case: agentCase },
				outcome: "pass",
				note: "The coupon check passed.",
				steps: demoTrail(caseOf(refs.length > 1 ? 1 : 0).steps, false, 0),
				attachments: [refs.length > 1 ? demoAgentScreenshot : demoScreenshot],
			},
			...pipelineResults([], 0.3, true).slice(refs.length > 1 ? 1 : 0, refs.length > 1 ? 2 : 1),
		],
	});
	const featured = caseOf(0).steps;
	await write(agent, "claim", "finding", before(40 * MINUTE), {
		lens: "adversarial-review",
		about: "pr:482",
		findings: [
			{
				on: `${first}#b2`,
				category: "ambiguous",
				note: "The expected result does not say which message is shown to the customer.",
				suggest: { step: "b2", expected: 'Show "Coupon expired" and keep the $100.00 total.' },
			},
		],
	});
	const proposal = await write(agent, "propose", "agent", before(30 * MINUTE), {
		reason: "Check removing the coupon as well as adding it.",
		edits: [
			{
				op: "edit",
				case: first,
				base: 1,
				body: {
					steps: [...featured, { id: "d4", action: "Remove the coupon", expected: "Total returns to $100.00" }],
				},
			},
		],
	});
	const bulkEdits = demoBulkProposal(suite);
	if (bulkEdits.length > 0) {
		await write(agent, "propose", "catalog-review", before(25 * MINUTE), {
			reason: "Review the catalog cases together before adding them to the suite.",
			edits: bulkEdits,
		});
	}
	const shippingAddress = {
		key: "tests/e2e/shipping.spec.ts::shipping::address",
		name: "Shipping accepts an address",
		file: "tests/e2e/shipping.spec.ts",
	};
	// A pull request merged by rebase: its head passed, and `main` holds a rewritten commit no report has named, as
	// when a stack lands in one push and the pipeline tests only its newest commit. Changes shows the head's gate and,
	// apart, the landed commit's (decision 0127). Both commits come from a stream of their own.
	const rebased = random(seedNumber ^ 0x165667b1);
	const [rebasedHead, rebasedLanding] = [hex(rebased), hex(rebased)];
	await report(ci, "rebased-head", before(23 * MINUTE), {
		target: {
			commit: rebasedHead,
			repo: REPO,
			branch: "refund-currency",
			pr: 484,
			base: red,
			title: "Keep the currency on refunds",
			files: ["src/refunds.ts"],
		},
		job: "misc",
		// The test the unlinked report below names, so no other test's latest result moves.
		results: [{ test: shippingAddress, outcome: "pass" }],
	});
	await write(ci, "change", "rebased-merge", before(22 * MINUTE), {
		change: "pr:484",
		state: "merged",
		head: rebasedHead,
		landing: { commit: rebasedLanding, branch: "main" },
	});
	// The final job arrives after this merge was reported: the receipt stays passed beside a now-blocked head.
	await report(ci, "rebased-late-job", before(21 * MINUTE), {
		target: { commit: rebasedHead, repo: REPO, branch: "refund-currency", pr: 484 },
		job: "refund-smoke",
		results: [
			{ test: shippingAddress, outcome: "fail", failure: { message: "The final refund smoke check timed out" } },
		],
	});
	await report(ci, "unlinked", before(20 * MINUTE), {
		target: { commit: change, repo: REPO, branch: "coupon-total", pr: 482 },
		job: "misc",
		results: [{ test: shippingAddress, outcome: "pass" }],
	});
	// The shop's unit tests on the pull request, in a job of their own: one more open question for each file.
	if (unlinkedFiles > 0) {
		await report(ci, `unit-${unlinkedFiles}`, before(10 * MINUTE), {
			target: { commit: change, repo: REPO, branch: "coupon-total", pr: 482 },
			job: "unit",
			results: unitTests(unlinkedFiles),
		});
	}
	// What the demo leaves to answer, read back: more than the replies above name. The failing test is a question
	// on `main` and on the pull request, and the demo asks about a test with no case, so that one is too.
	const questions: string[] = [];
	for (let cursor: string | undefined; ; ) {
		const page = await owner.call("inbox", { limit: 500, ...(cursor ? { cursor } : {}) });
		questions.push(...page.items.map((item) => item.q));
		if (!page.cursor) break;
		cursor = page.cursor;
	}
	const candidates = z
		.array(z.object({ id: z.number(), state: z.string() }))
		.parse((await owner.call("find", { in: "slots", run: planned.run, limit: 200 })).items);
	const workSlot = candidates.find((slot) => slot.state === "missing" || slot.state === "skipped")?.id;
	const working =
		workSlot === undefined
			? null
			: await owner.call("work", {
					do: "take",
					run: planned.run,
					slot: workSlot,
					seconds: DEMO_WORK.seconds,
					projectIdentity: identity,
				});
	return {
		cases: refs,
		run: planned.run,
		agentRun: agentRun.run,
		proposal: proposal.proposal,
		questions,
		workSlot: working?.slot ?? null,
	};
}

/** The trace a test runner writes for a failing test, as a text file to attach to its result. */
function traceOf(name: string, message: string): { name: string; data: string } {
	const trace = [
		`Test: ${name}`,
		"",
		"  ✓ open the cart with one $100.00 item (412 ms)",
		"  ✓ apply the coupon (238 ms)",
		`  ✗ check the total (5003 ms)`,
		"",
		`Error: ${message}`,
		'  Locator: getByTestId("cart-total")',
		"  at tests/e2e/checkout.spec.ts:42:38",
		"",
		"Console:",
		"  [warn] coupon service answered 304 Not Modified",
		"  [info] total recalculated from cached prices",
	].join("\n");
	return { name: "trace.txt", data: Buffer.from(trace).toString("base64") };
}

/** The label of a producer's token names the project, so the token list says which demo it was made for. */
const labelOf = (producer: Producer, project: string) => `${producer.label} for ${project}`;

/**
 * Revokes the tokens this seed made for its pipeline and agent, by the ids `token.create` gave it: they stop working
 * with the seed, and no other token is touched. A seed that stops before this leaves tokens that end within the hour.
 */
async function revokeProducers(owner: Client, issued: readonly number[]): Promise<void> {
	for (const id of issued) await owner.call("admin", { do: "token.revoke", id }).catch(() => undefined);
}

/**
 * Refuses a seed that could not finish because the name of its pipeline or its agent is somebody else's, before it
 * writes anything. Returns the instance's actors.
 */
export async function refuseProducers(client: Client): Promise<z.infer<typeof Actors>> {
	const actors = Actors.parse(await client.call("admin", { do: "actor.list" }));
	for (const producer of [PIPELINE, REVIEWER]) {
		const kind = actors.find((row) => row.name === producer.actor)?.kind ?? producer.kind;
		if (kind !== producer.kind)
			throw new CliError(
				"conflict",
				`actor ${producer.actor} exists and is a ${kind}, not a ${producer.kind}: the demo needs that name`,
			);
	}
	return actors;
}

/** Whether the project holds anything a person, a pipeline or an agent put there. */
async function holdsWork(client: Client): Promise<boolean> {
	for (const kind of ["cases", "tests", "runs"] as const)
		if ((await client.call("find", { in: kind, limit: 1 })).items.length > 0) return true;
	return false;
}
