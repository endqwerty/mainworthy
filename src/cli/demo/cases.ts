// The demo's suite: the catalog's scenarios turned into cases. Pure: the same seed and count give the same
// cases, in the same order, so a seed sent again asks for what the first one asked for.
import { type Axis, CATALOG, CONTEXTS, type Feature, type Scenario, VALUES } from "./catalog.ts";

export type DemoCase = {
	/** The folder path, for example `Checkout/Coupons`. */
	folder: string;
	tags: string[];
	title: string;
	pre: string;
	steps: { id: string; action: string; expected: string | null }[];
	/** The automated test that reports on this case, or null: a case only a person runs. */
	test: { key: string; name: string; file: string } | null;
};

/** A reproducible stream of numbers in [0, 1): every choice the demo makes is drawn from one of these (mulberry32). */
export function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

export const pick = <T>(rng: () => number, from: readonly T[]): T => {
	const item = from[Math.floor(rng() * from.length)];
	if (item === undefined) throw new Error("nothing to pick from");
	return item;
};

export function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

const SLOT = /\{([a-z]+)\}/g;
const fill = (text: string, values: Readonly<Record<string, string>>): string =>
	text.replace(SLOT, (_, name: string) => values[name] ?? `{${name}}`);

/** The slots a scenario names, in the order they first appear. */
function slotsOf(scenario: Scenario): string[] {
	const text = [scenario.title, scenario.pre ?? "", ...scenario.steps.flatMap(([a, e]) => [a, e ?? ""])].join("\n");
	return [...new Set([...text.matchAll(SLOT)].map((match) => match[1] ?? ""))];
}

/** Every way to fill a scenario's slots: one case each. A scenario with no slot is one case. */
function variantsOf(scenario: Scenario): Record<string, string>[] {
	let variants: Record<string, string>[] = [{}];
	for (const slot of slotsOf(scenario)) {
		const values = VALUES[slot];
		if (!values) throw new Error(`the catalog names the slot {${slot}} and gives it no values`);
		variants = variants.flatMap((variant) => values.map((value) => ({ ...variant, [slot]: value })));
	}
	return variants;
}

type Context = { title: string; pre: string; tags: string[] };
const NO_CONTEXT: Context = { title: "", pre: "", tags: [] };

/**
 * Where and for whom a feature's cases are repeated, in tiers: one thing changed (another browser), then two,
 * then all three. Each tier is in the seed's order. A feature names the axes that apply to it.
 */
function contextsOf(feature: Feature, rng: () => number): Context[][] {
	const across = feature.across ?? ["platform", "language", "customer"];
	const options = (axis: Axis): (string | null)[] => [null, ...(across.includes(axis) ? CONTEXTS[axis] : [])];
	const tiers: Context[][] = [[], [], []];
	for (const platform of options("platform"))
		for (const language of options("language"))
			for (const customer of options("customer")) {
				const parts = [platform, language && `in ${language}`, customer && `as ${customer}`].filter((part) => part);
				if (parts.length === 0) continue;
				const mobile = platform !== null && /iPhone|Android|app/.test(platform);
				tiers[parts.length - 1]?.push({
					title: parts.join(", "),
					pre: [
						platform && `Use ${platform}.`,
						language && `Set the language to ${language}.`,
						customer && `Shop as ${customer}.`,
					]
						.filter((part) => part)
						.join(" "),
					tags: mobile ? ["mobile"] : [],
				});
			}
	return tiers.filter((tier) => tier.length > 0).map((tier) => shuffled(rng, tier));
}

/**
 * The context of case `variant` in pass `pass` (from 1), or null when the feature has no context left. Within a
 * tier each pass moves every case on by one, so a pass is not a column of one browser and no case meets a
 * context twice.
 */
function contextOf(tiers: readonly Context[][], pass: number, variant: number): Context | null {
	let before = 0;
	for (const tier of tiers) {
		if (pass - before <= tier.length) return tier[(pass - before - 1 + variant) % tier.length] ?? null;
		before += tier.length;
	}
	return null;
}

/**
 * How many cases each feature gets: its share by weight, with the remainders handed out largest first. The first
 * feature always gets one, because the demo's open questions are about its first case.
 */
function shares(count: number): number[] {
	const total = CATALOG.reduce((sum, feature) => sum + feature.weight, 0);
	const exact = CATALOG.map((feature) => ((count - 1) * feature.weight) / total);
	const given = exact.map(Math.floor);
	let left = count - 1 - given.reduce((sum, n) => sum + n, 0);
	const byRemainder = exact.map((value, index) => ({ index, rest: value - Math.floor(value) }));
	byRemainder.sort((a, b) => b.rest - a.rest || a.index - b.index);
	for (const { index } of byRemainder) {
		if (left-- <= 0) break;
		given[index] = (given[index] ?? 0) + 1;
	}
	given[0] = (given[0] ?? 0) + 1;
	return given;
}

const slug = (text: string): string =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9/]+/g, "-")
		.replace(/^-|-$/g, "");

/**
 * The cases of one feature. First each scenario once, then again with other values, so a small demo still shows
 * every scenario. When the scenarios run out they are repeated for another browser, language or customer, as a
 * real suite repeats them. A feature with nothing left to vary numbers the rest, so a title stays its own.
 */
function casesOf(feature: Feature, count: number, rng: () => number): DemoCase[] {
	const perScenario = feature.scenarios.map((scenario) => ({
		scenario,
		variants: shuffled(rng, variantsOf(scenario)),
	}));
	const base: { scenario: Scenario; values: Record<string, string>; first: boolean }[] = [];
	const rounds = Math.max(...perScenario.map((entry) => entry.variants.length));
	for (let round = 0; round < rounds; round++)
		for (const { scenario, variants } of perScenario) {
			const values = variants[round];
			if (values) base.push({ scenario, values, first: round === 0 });
		}
	const tiers = contextsOf(feature, rng);
	const name = feature.path.split("/").at(-1) ?? feature.path;
	const file = `tests/${slug(feature.path)}.spec.ts`;
	const out: DemoCase[] = [];
	for (let i = 0; i < count; i++) {
		const pass = Math.floor(i / base.length);
		const variant = i % base.length;
		const entry = base[variant];
		if (!entry) throw new Error(`the feature ${feature.path} has no scenario`);
		const context = pass === 0 ? NO_CONTEXT : contextOf(tiers, pass, variant);
		const plain = fill(entry.scenario.title, entry.values);
		const title = context
			? `${plain}${context.title ? ` · ${context.title}` : ""}`
			: `${plain} · ${String(i + 1).padStart(5, "0")}`;
		out.push({
			folder: feature.path,
			tags: [
				...new Set([...feature.tags, entry.first && pass === 0 ? "smoke" : "regression", ...(context?.tags ?? [])]),
			],
			title,
			pre: [fill(entry.scenario.pre ?? feature.pre, entry.values), context?.pre].filter((part) => part).join(" "),
			steps: entry.scenario.steps.map(([action, expected], n) => ({
				id: `${String.fromCharCode(97 + n)}${n + 1}`,
				action: fill(action, entry.values),
				expected: expected === null ? null : fill(expected, entry.values),
			})),
			test: pass === 0 ? { key: `${file}::${name}::${title}`, name: title, file } : null,
		});
	}
	return out;
}

/** How many of a demo's cases an automated test reports on: about a third, and few enough that a report stays small. */
export const automatedCount = (cases: number): number => Math.min(cases, Math.max(8, Math.round(cases * 0.3)), 600);

/**
 * The demo's cases, folder by folder, the case the open questions are about first. Automated tests are kept on
 * the first case and on a seeded choice of the cases that are no repetition for a browser or a language.
 */
export function demoCases(seed: number, count: number): DemoCase[] {
	const rng = random(seed);
	const perFeature = shares(count);
	const cases = CATALOG.flatMap((feature, index) => casesOf(feature, perFeature[index] ?? 0, rng));
	const candidates = cases.map((item, index) => ({ item, index })).filter(({ item, index }) => item.test && index > 0);
	const kept = new Set([
		0,
		...shuffled(rng, candidates)
			.slice(0, automatedCount(count) - 1)
			.map(({ index }) => index),
	]);
	return cases.map((item, index) => (kept.has(index) ? item : { ...item, test: null }));
}
