// A small project that holds one of everything the iOS app shows: cases in folders, a pipeline's results on the
// trunk and on a pull request, a failure nobody has explained, a test with no case, an agent's finding and an
// agent's edit that waits, and a planned run. The contract test reads its replies, and the app's own tests run
// against a project made here (`instance.ts`).
//
// It is written through the operations a person, a pipeline and an agent call, as the demo is (`src/cli/seed.ts`),
// and is kept apart from the demo on purpose: the demo changes with what the product wants to show, and a test
// of the app should fail only for what the app reads.
import { z } from "zod";
import { Client } from "../../src/cli/client.ts";
import type { Capability } from "../../src/core/kinds.ts";

const Token = z.object({ token: z.string() });
const Linked = z.object({ tests: z.array(z.object({ t: z.string(), name: z.string() })) });

export type World = {
	project: string;
	cases: string[];
	/** A planned run that takes the pull request's commit and has cases nobody has run. */
	run: string;
	/** The pull request, as a change key. */
	change: string;
	commit: string;
};

const MAIN = "1111111111111111111111111111111111111111";
const CHANGE = "3333333333333333333333333333333333333333";
const REPO = "acme/shop";

const CASES: { folder: string; tags: string[]; title: string; pre: string; steps: [string, string | null][] }[] = [
	{
		folder: "Checkout/Coupons",
		tags: ["checkout", "regression"],
		title: "Expired coupon is rejected",
		pre: "Open the shop with a signed-in account.",
		steps: [
			["Open the cart with one $100.00 item", null],
			["Apply the coupon OLD10", 'Error "Coupon expired"; total unchanged'],
			["Reload the page", "The cart keeps the item and total"],
		],
	},
	{
		folder: "Checkout/Coupons",
		tags: ["checkout"],
		title: "A percentage coupon lowers the total",
		pre: "",
		steps: [
			["Open the cart with one $100.00 item", null],
			["Apply the coupon SAVE10", "Total shows $90.00"],
		],
	},
	{
		folder: "Checkout/Cart",
		tags: ["checkout", "regression"],
		title: "Cart preserves the quantity",
		pre: "",
		steps: [
			["Add two of the same item", "The cart shows quantity 2"],
			["Reload the page", "The cart still shows quantity 2"],
		],
	},
	{
		folder: "Accounts",
		tags: ["regression"],
		title: "Password reset restores access",
		pre: "An account whose password is forgotten.",
		steps: [
			["Ask for a reset link", "A mail arrives within a minute"],
			["Open the link and set a new password", "The account is signed in"],
		],
	},
	{
		folder: "Orders",
		tags: [],
		title: "Order total includes shipping",
		pre: "",
		steps: [["Place an order to another country", "The total is the items plus shipping"]],
	},
	{
		folder: "Catalog",
		tags: [],
		title: "Catalog keeps the selected filters",
		pre: "",
		steps: [["Select a category and reload", "The selected category is kept"]],
	},
];

/**
 * Fills a project that does not exist yet, as the owner whose token this is. The project asks a person about
 * an agent's edit and about a test with no case (`standard`, `ask`), so every kind of question but a sign-off
 * is open in it when this returns.
 */
export async function scenario(url: string, ownerToken: string, project: string): Promise<World> {
	const as = (token: string) => new Client({ url, token, project });
	const owner = as(ownerToken);
	await owner.call("admin", { do: "project.create", key: project, preset: "standard", unlinked: "ask" });
	// Each project gets its own pipeline and agent: an actor that exists is not given a second grant by a token.
	const tokenFor = async (actor: string, kind: "ci" | "agent", can: Capability[]) => {
		const made = await owner.call("admin", { do: "token.create", actor: `${actor}-${project}`, kind, can, project });
		return as(Token.parse(made).token);
	};
	const ci = await tokenFor("pipeline", "ci", ["read", "record"]);
	const agent = await tokenFor("reviewer", "agent", ["read", "produce"]);

	await owner.call("propose", {
		edits: [
			{ op: "folder", name: "Checkout" },
			{ op: "folder", name: "Coupons", parent: "Checkout" },
			{ op: "folder", name: "Cart", parent: "Checkout" },
			{ op: "folder", name: "Accounts" },
			{ op: "folder", name: "Orders" },
			{ op: "folder", name: "Catalog" },
		],
	});
	const created = await owner.call("propose", {
		edits: CASES.map((item) => ({
			op: "create" as const,
			folder: item.folder,
			tags: item.tags,
			body: {
				title: item.title,
				pre: item.pre,
				methods: ["human", "auto", "agent"] as ("human" | "auto" | "agent")[],
				automate: "none" as const,
				fields: {},
				steps: item.steps.map(([action, expected], index) => ({ id: `s${index + 1}`, action, expected })),
			},
		})),
	});
	const cases = created.cases.map((stamp) => stamp.ref);
	const [first, second] = cases;
	if (!first || !second) throw new Error("the scenario's cases were not created");

	const tests = cases.slice(0, 4).map((ref, index) => ({
		test: {
			key: `tests/shop.spec.ts::shop::check-${index + 1}`,
			name: `Shop check ${index + 1}`,
			file: "tests/shop.spec.ts",
		},
		outcome: "pass" as const,
		annotation: { case: ref, version: 1 },
	}));
	await ci.call("report", { target: { commit: MAIN, repo: REPO, branch: "main" }, job: "shop", results: tests });
	// The pipeline's tests are linked to their cases by the owner, as a person does it once in the queue. From
	// then on a result of a test counts for its case, and fills that case's place in a run.
	const unlinked = (await owner.call("inbox", { kind: "map" })).items.find((item) => item.kind === "map");
	const named = Linked.safeParse(unlinked?.evidence);
	if (!unlinked || !named.success) throw new Error("the scenario's tests did not ask for their cases");
	await owner.call("decide", {
		q: unlinked.q,
		onEvidence: unlinked.evidenceHash,
		answer: {
			is: "link",
			pairs: named.data.tests.map((test) => [
				test.t,
				cases[Number(test.name.slice("Shop check ".length)) - 1] ?? first,
			]),
		},
	});
	await ci.call("report", {
		target: {
			commit: CHANGE,
			repo: REPO,
			branch: "coupon-total",
			pr: 482,
			base: MAIN,
			title: "Apply a percentage coupon",
			files: ["src/checkout.ts"],
		},
		job: "shop",
		results: [
			...tests.map((result, index) =>
				index === 0
					? { ...result, outcome: "fail" as const, failure: { message: "expected $90.00, got $100.00" } }
					: result,
			),
			{
				test: {
					key: "tests/shipping.spec.ts::shipping::address",
					name: "Shipping accepts an address",
					file: "tests/shipping.spec.ts",
				},
				outcome: "pass" as const,
			},
		],
	});
	const planned = await owner.call("plan", {
		name: "Checkout regression",
		select: { cases },
		accepts: { commit: CHANGE, repo: REPO },
	});
	await owner.call("work", { do: "take", run: planned.run, seconds: 86400 });
	await agent.call("claim", {
		lens: "adversarial-review",
		about: "pr:482",
		findings: [
			{
				on: `${first}#s2`,
				category: "ambiguous",
				note: "The expected result does not say which message the customer sees.",
				suggest: { step: "s2", expected: 'Show "Coupon expired" and keep the $100.00 total.' },
			},
		],
	});
	await agent.call("propose", {
		reason: "Check removing the coupon as well as adding it.",
		edits: [
			{
				op: "edit",
				case: second,
				base: 1,
				body: {
					steps: [
						{ id: "s1", action: "Open the cart with one $100.00 item", expected: null },
						{ id: "s2", action: "Apply the coupon SAVE10", expected: "Total shows $90.00" },
						{ id: "s3", action: "Remove the coupon", expected: "Total returns to $100.00" },
					],
				},
			},
		],
	});
	return { project, cases, run: planned.run, change: "pr:482", commit: CHANGE };
}

/**
 * A project where closing a run is a person's to decide (`strict`), with one run that has passed: the one kind
 * of question `scenario` leaves nobody. Returns the run.
 */
export async function passedRun(url: string, ownerToken: string, project: string): Promise<string> {
	const owner = new Client({ url, token: ownerToken, project });
	await owner.call("admin", { do: "project.create", key: project, preset: "strict" });
	const created = await owner.call("propose", {
		reason: "The scenario's one case.",
		edits: [{ op: "create", outline: "The shop opens\n  Open the shop > The catalog is shown" }],
	});
	const adopt = (await owner.call("inbox", { kind: "adopt" })).items.find((item) => item.q === created.question);
	if (adopt)
		await owner.call("decide", {
			q: adopt.q,
			onEvidence: adopt.evidenceHash,
			answer: { is: "accept" },
			reason: "The scenario's one case.",
		});
	const [only] = (await owner.call("find", { in: "cases", limit: 1 })).items;
	const ref = typeof only?.ref === "string" ? only.ref : null;
	if (!ref) throw new Error("the strict scenario's case was not created");
	const planned = await owner.call("plan", { name: "Release check", select: { cases: [ref] } });
	await owner.call("report", { run: planned.run, results: [{ test: { case: ref }, outcome: "pass" }] });
	return planned.run;
}
