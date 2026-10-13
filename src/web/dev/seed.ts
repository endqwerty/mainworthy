import { z } from "zod";
import type { Api } from "../../core/api.ts";
import { type CallOptions, call } from "../lib/api.ts";

export type SeedResult = { cases: string[]; run: string | null; proposal: string | null; questions: string[] };
/** A deterministic demo, written only through public operations. Secrets never enter the fixture output. */
export async function seed({
	url,
	cases = 2000,
	project = "scratch",
	token,
}: {
	url: string;
	cases?: number;
	project?: string;
	token?: string;
}): Promise<SeedResult> {
	const options: CallOptions = { url, project, ...(token ? { token } : {}) };
	await call(
		"propose",
		{
			cmd: "demo-folders-v1",
			edits: [
				{ op: "folder", name: "Checkout" },
				{ op: "folder", name: "Coupons", parent: "Checkout" },
				{ op: "folder", name: "Cart", parent: "Checkout" },
				{ op: "folder", name: "Accounts" },
				{ op: "folder", name: "Orders" },
				{ op: "folder", name: "Catalog" },
			],
		},
		options,
	);
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
		const reply = await call("propose", { cmd: `demo-cases-${offset}-v1`, edits }, options);
		refs.push(...reply.cases.map((item) => item.ref));
	}
	const first = refs[0];
	if (!first) return { cases: refs, run: null, proposal: null, questions: [] };
	const pipeline = z
		.object({ token: z.string() })
		.parse(
			await call(
				"admin",
				{ do: "token.create", actor: "pipeline", kind: "ci", can: ["read", "record"], label: "Demo pipeline" },
				options,
			),
		);
	const ci: CallOptions = { ...options, token: pipeline.token };
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
	await call(
		"report",
		{ cmd: "demo-green-v1", target: { commit: green, repo: "demo/shop", branch: "main" }, job: "shop", results },
		ci,
	);
	const failures = results.map((result, i) =>
		i === 0
			? ({
					...result,
					outcome: "fail",
					failure: { message: "expected $90.00, got $100.00" },
				} satisfies Api["report"]["input"]["results"][number])
			: result,
	);
	await call(
		"report",
		{ cmd: "demo-red-v1", target: { commit: red, repo: "demo/shop", branch: "main" }, job: "shop", results: failures },
		ci,
	);
	const receipt = await call(
		"report",
		{
			cmd: "demo-pr-v1",
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
		},
		ci,
	);
	const planned = await call(
		"plan",
		{
			cmd: "demo-run-v1",
			name: "Checkout regression",
			select: { cases: refs.slice(0, 40) },
			accepts: { commit: change, repo: "demo/shop" },
		},
		options,
	);
	const policy = await call(
		"propose",
		{ cmd: "demo-standard-v1", edits: [{ op: "policy", preset: "standard" }] },
		options,
	);
	if (policy.question) {
		const question = (await call("inbox", { kind: "adopt" }, options)).items.find((q) => q.q === policy.question);
		if (question)
			await call("decide", { q: question.q, onEvidence: question.evidenceHash, answer: { is: "accept" } }, options);
	}
	const agent = z.object({ token: z.string() }).parse(
		await call(
			"admin",
			{
				do: "token.create",
				actor: "reviewer",
				kind: "agent",
				can: ["read", "produce", "answer"],
				label: "Demo reviewer",
			},
			options,
		),
	);
	const agentOptions: CallOptions = { ...options, token: agent.token };
	const finding = await call(
		"claim",
		{
			cmd: "demo-finding-v1",
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
		},
		agentOptions,
	);
	const proposal = await call(
		"propose",
		{
			cmd: "demo-agent-v1",
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
		},
		agentOptions,
	);
	await call(
		"report",
		{
			cmd: "demo-unlinked-v1",
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
		},
		ci,
	);
	return {
		cases: refs,
		run: planned.run,
		proposal: proposal.proposal,
		questions: [
			...receipt.questions.map((q) => q.q),
			...finding.opened,
			...(proposal.question ? [proposal.question] : []),
		],
	};
}
if (import.meta.main) {
	const args = Bun.argv.slice(2);
	const value = (key: string) => {
		const at = args.indexOf(key);
		return at >= 0 ? args[at + 1] : undefined;
	};
	const url = value("--url") ?? "http://127.0.0.1:7357";
	const result = await seed({
		url,
		cases: Number(value("--cases") ?? 2000),
		project: value("--project") ?? "scratch",
		...(process.env.MAINWORTHY_TOKEN ? { token: process.env.MAINWORTHY_TOKEN } : {}),
	});
	console.info(
		`Seeded ${result.cases.length} cases; run ${result.run ?? "none"}; ${result.questions.length} demo questions.`,
	);
}
