// The demo: a shop's suite, a pipeline's results on three commits, a planned run, and an agent's finding and
// proposal. It is written through the operations a person, a pipeline and an agent would use, so a project
// filled here holds nothing those three could not have left.
import { z } from "zod";
import type { Api } from "../core/api.ts";
import type { ActorKind, Capability } from "../core/kinds.ts";
import { Client } from "./client.ts";
import { CliError } from "./errors.ts";

export type SeedResult = { cases: string[]; run: string; proposal: string | null; questions: string[] };

/** The most cases one seed writes: the size the benchmark measures (`bench/`). */
export const MAX_SEED_CASES = 100_000;

const Projects = z.array(z.object({ key: z.string() }));
const Actors = z.array(z.object({ name: z.string(), kind: z.string() }));
const Token = z.object({ token: z.string() });

type Producer = { actor: string; kind: Exclude<ActorKind, "rule">; can: Capability[]; label: string };
const PIPELINE: Producer = { actor: "pipeline", kind: "ci", can: ["read", "record"], label: "Demo pipeline" };
const REVIEWER: Producer = {
	actor: "reviewer",
	kind: "agent",
	can: ["read", "produce", "answer"],
	label: "Demo reviewer",
};

/**
 * Fills `project` with the demo, as whoever `client` signs in as: a person who administers the instance. The
 * project is made when the instance has none of that name. One that holds cases, tests or runs is left alone,
 * unless this caller's seed began there: every write to the project carries a command id, so sending the same
 * seed again finishes one that stopped and writes nothing in the project twice. It does make the two tokens again.
 *
 * What can refuse the caller comes first, so nothing is made for a seed that cannot be finished. The pipeline
 * and the agent are given a grant on this project alone, and their tokens end after an hour: the secrets are
 * dropped here, and nothing that could still sign in is left behind.
 */
export async function seed(
	client: Client,
	{ project, cases }: { project: string; cases: number },
): Promise<SeedResult> {
	if (!Number.isInteger(cases) || cases < 1 || cases > MAX_SEED_CASES)
		throw new CliError("invalid", `seed writes from 1 to ${MAX_SEED_CASES} cases, not ${cases}`);
	const as = (token: string | undefined) => new Client({ url: client.url, token, project });
	const owner = as(client.options.token);
	const id = (step: string) => `demo-${project}-${step}-v1`;
	const actors = Actors.parse(await owner.call("admin", { do: "actor.list" }));
	const known = (producer: Producer) => actors.find((row) => row.name === producer.actor);
	for (const producer of [PIPELINE, REVIEWER]) {
		const kind = known(producer)?.kind ?? producer.kind;
		if (kind !== producer.kind)
			throw new CliError(
				"conflict",
				`actor ${producer.actor} exists and is a ${kind}, not a ${producer.kind}: the demo needs that name`,
			);
	}
	const exists = Projects.parse(await owner.call("admin", { do: "project.list" })).some((row) => row.key === project);
	if (!exists) await owner.call("admin", { do: "project.create", key: project });
	const begun = exists && (await owner.call("command", { cmd: id("folders") })).state !== "none";
	if (exists && !begun && (await holdsWork(owner)))
		throw new CliError(
			"conflict",
			`project ${project} already holds cases, tests or runs; seed fills a new project or an empty one`,
		);
	const signIn = async (producer: Producer) => {
		const { actor, kind, can, label } = producer;
		// A new token names the grant its actor holds. An actor from an earlier seed is given this project's first.
		if (known(producer)) await owner.call("admin", { do: "grant.set", actor, project, can });
		const made = await owner.call("admin", { do: "token.create", actor, kind, can, project, label, expires: "1h" });
		return as(Token.parse(made).token);
	};
	const ci = await signIn(PIPELINE);
	const agent = await signIn(REVIEWER);
	await owner.call("propose", {
		cmd: id("folders"),
		edits: [
			{ op: "folder", name: "Checkout" },
			{ op: "folder", name: "Coupons", parent: "Checkout" },
			{ op: "folder", name: "Cart", parent: "Checkout" },
			{ op: "folder", name: "Accounts" },
			{ op: "folder", name: "Orders" },
			{ op: "folder", name: "Catalog" },
		],
	});
	const refs: string[] = [];
	const paths = ["Checkout/Coupons", "Checkout/Cart", "Accounts", "Orders", "Catalog"];
	const titles = [
		"Expired coupon is rejected",
		"Cart preserves the quantity",
		"Password reset restores access",
		"Order total includes shipping",
		"Catalog keeps the selected filters",
	];
	for (let offset = 0; offset < cases; offset += 250) {
		const edits: Api["propose"]["input"]["edits"] = Array.from({ length: Math.min(250, cases - offset) }, (_, n) => {
			const i = offset + n;
			return {
				op: "create",
				folder: paths[i % paths.length] ?? "Checkout",
				tags: i % 3 === 0 ? ["checkout", "regression"] : ["regression"],
				body: {
					title: `${titles[i % titles.length] ?? "Checkout is correct"}${i < 5 ? "" : ` · ${String(i + 1).padStart(5, "0")}`}`,
					pre: "Open the shop with a signed-in account.",
					methods: ["human", "auto", "agent"],
					automate: "none",
					fields: {},
					steps: [
						{ id: "a1", action: "Open the cart with one $100.00 item", expected: null },
						{ id: "b2", action: "Apply the coupon OLD10", expected: 'Error "Coupon expired"; total unchanged' },
						{ id: "c3", action: "Reload the page", expected: "The cart keeps the item and total" },
					],
				},
			};
		});
		const reply = await owner.call("propose", { cmd: id(`cases-${offset}`), edits }).catch((error: unknown) => {
			// The command id of a batch is bound to its cases: a seed sent again with another count is another request.
			if (begun && error instanceof CliError && error.code === "conflict")
				throw new CliError(
					"conflict",
					`project ${project} was seeded with another number of cases; send that number again, or seed another project`,
				);
			throw error;
		});
		refs.push(...reply.cases.map((item) => item.ref));
	}
	const first = refs[0];
	if (!first) throw new CliError("internal", "the server created no case");
	const green = "1111111111111111111111111111111111111111";
	const red = "2222222222222222222222222222222222222222";
	const change = "3333333333333333333333333333333333333333";
	const results = refs.slice(0, 8).map(
		(ref, i) =>
			({
				test: {
					key: `tests/shop.spec.ts::shop::check-${i + 1}`,
					name: `Shop check ${i + 1}`,
					file: "tests/shop.spec.ts",
				},
				outcome: "pass",
				annotation: { case: ref, version: 1 },
			}) satisfies Api["report"]["input"]["results"][number],
	);
	await ci.call("report", {
		cmd: id("green"),
		target: { commit: green, repo: "demo/shop", branch: "main" },
		job: "shop",
		results,
	});
	const failures = results.map((result, i) =>
		i === 0
			? ({
					...result,
					outcome: "fail",
					failure: { message: "expected $90.00, got $100.00" },
				} satisfies Api["report"]["input"]["results"][number])
			: result,
	);
	await ci.call("report", {
		cmd: id("red"),
		target: { commit: red, repo: "demo/shop", branch: "main" },
		job: "shop",
		results: failures,
	});
	await ci.call("report", {
		cmd: id("pr"),
		target: {
			commit: change,
			repo: "demo/shop",
			branch: "coupon-total",
			pr: 482,
			base: red,
			title: "Apply a percentage coupon",
			files: ["src/checkout.ts", "src/shipping.ts"],
		},
		job: "shop",
		results: failures,
	});
	const planned = await owner.call("plan", {
		cmd: id("run"),
		name: "Checkout regression",
		select: { cases: refs.slice(0, 40) },
		accepts: { commit: change, repo: "demo/shop" },
	});
	const policy = await owner.call("propose", {
		cmd: id("standard"),
		edits: [{ op: "policy", preset: "standard", unlinked: "ask" }],
	});
	if (policy.question) {
		const question = (await owner.call("inbox", { kind: "adopt" })).items.find((q) => q.q === policy.question);
		if (question)
			await owner.call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } });
	}
	await agent.call("claim", {
		cmd: id("finding"),
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
	const proposal = await agent.call("propose", {
		cmd: id("agent"),
		reason: "Check removing the coupon as well as adding it.",
		edits: [
			{
				op: "edit",
				case: first,
				base: 1,
				body: {
					steps: [
						{ id: "a1", action: "Open the cart with one $100.00 item", expected: null },
						{ id: "b2", action: "Apply the coupon OLD10", expected: 'Error "Coupon expired"; total unchanged' },
						{ id: "c3", action: "Reload the page", expected: "The cart keeps the item and total" },
						{ id: "d4", action: "Remove the coupon", expected: "Total returns to $100.00" },
					],
				},
			},
		],
	});
	await ci.call("report", {
		cmd: id("unlinked"),
		target: { commit: change, repo: "demo/shop", branch: "coupon-total", pr: 482 },
		job: "misc",
		results: [
			{
				test: {
					key: "tests/shipping.spec.ts::shipping::address",
					name: "Shipping accepts an address",
					file: "tests/shipping.spec.ts",
				},
				outcome: "pass",
			},
		],
	});
	// What the demo leaves to answer, read back: more than the replies above name. The failing test is a question
	// on `main` and on the pull request, and the demo asks about a test with no case, so that one is too.
	const open = await owner.call("inbox", { limit: 50 });
	return { cases: refs, run: planned.run, proposal: proposal.proposal, questions: open.items.map((item) => item.q) };
}

/** Whether the project holds anything a person, a pipeline or an agent put there. */
async function holdsWork(client: Client): Promise<boolean> {
	for (const kind of ["cases", "tests", "runs"] as const)
		if ((await client.call("find", { in: kind, limit: 1 })).items.length > 0) return true;
	return false;
}
