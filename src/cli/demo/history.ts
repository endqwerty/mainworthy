// What happened in the demo shop's project before today: a pipeline that reported every night and on every pull
// request, failures that were answered, runs a person worked through, cases that were edited and an agent's
// reviews. Pure: the same seed, cases and days give the same events, each with the time it happened at, so a
// seed sent again asks for what the first one asked for.

import { type DemoCase, pick, random, shuffled } from "./cases.ts";
import { CATALOG } from "./catalog.ts";

export const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The repository the demo's pipeline reports on. */
export const REPO = "demo/shop";

/** Today's trunk failure landed through this recorded pull request. No random stream is consumed. */
export const LANDED_CHANGE = { pr: 481, branch: "coupon-rounding", title: "Round coupon totals consistently" };

export const REVIEW_CHANGE = {
	pr: 482,
	branch: "coupon-total",
	title: "Apply a percentage coupon",
	files: [
		"src/checkout.ts",
		"src/shipping.ts",
		"tests/checkout/coupons.spec.ts",
		"tests/checkout/cart.spec.ts",
		"tests/checkout/payment.spec.ts",
		"tests/checkout/shipping.spec.ts",
		"tests/checkout/tax.spec.ts",
	],
};

export const AGENT_MODEL = "claude-opus-5-5";

/**
 * When the shop pipeline's runner started and ended the tests of a report it uploads at `at` (issue #722): it ends a
 * minute before the upload, on four workers, so it took a quarter of the results' summed durations. Drawn from
 * nothing, so every random stream stays as it was.
 */
export function pipelineSpan(at: number, results: readonly { durationMs?: number | undefined }[]) {
	const endedAt = at - MINUTE;
	const summed = results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0);
	return { startedAt: endedAt - Math.ceil(summed / 4), endedAt };
}

/**
 * How a person answered a failure or a finding. None of these ends by the clock (`flaky` does, after a week), so
 * nothing in the history comes back open while somebody looks at the demo.
 */
export type Answer =
	| { is: "defect"; ref?: string }
	| { is: "test" }
	| { is: "infra" }
	| { is: "accept" }
	| { is: "reject" };

export type Failure = { case: number; message: string };

type Base = {
	/** When it happened, in milliseconds. The events are in this order. */
	at: number;
	/** A name of its own, short enough for a command id. */
	step: string;
};

export type HistoryEvent = Base &
	(
		| {
				kind: "pipeline";
				target: {
					commit: string;
					branch: string;
					pr?: number;
					base?: string;
					title?: string;
					files?: string[];
				};
				/** The automated cases that failed. Every other one passed. */
				failures: Failure[];
				/** A rerun: the attempt, and the cases it ran again. Absent: the first attempt, of every automated case. */
				rerun?: { attempt: number; cases: number[] };
				/** Cases the test runner tried again inside this run: each failed once, then passed (decision 0129). */
				retried?: Failure[];
				/** Varies the durations of this report's results. */
				jitter: number;
		  }
		/** A person links every test the pipeline has reported to the case it covers: once, after the first report. */
		| { kind: "link" }
		/** A person's answer to every question the event named `of` opened. */
		| { kind: "answer"; of: string; answer: Answer; reason: string }
		| { kind: "plan"; name: string; cases: number[] }
		| {
				kind: "execute";
				run: string;
				results: { case: number; durationMs?: number; failed?: { message: string; note: string } }[];
		  }
		/** A step added to the end of a case. */
		| { kind: "edit"; case: number; add: { action: string; expected: string }; reason: string }
		/** The pipeline says a pull request merged: it ended, and is not asked about any more (decision 0022). */
		| { kind: "end"; pr: number }
		/** Cases a person archived, because something else covers them now. */
		| { kind: "archive"; cases: number[]; reason: string }
		| { kind: "quarantine"; case: number; active: boolean; reason: string }
		/** The agent's review of a pull request, with one finding. */
		| {
				kind: "review";
				about: number;
				finding: { case: number; category: "ambiguous" | "missing-expected" | "uncovered-path"; note: string };
		  }
	);

/** A change to the shop, as a pull request names it, and the folder whose tests it is most likely to break. */
const CHANGES: readonly (readonly [title: string, branch: string, folder: string])[] = [
	["Round tax per line, not per order", "tax-rounding", "Checkout/Tax"],
	["Keep the cart when a session is renewed", "cart-session", "Checkout/Cart"],
	["Show the delivery date for in-store pickup", "pickup-date", "Checkout/Shipping"],
	["Retry a declined wallet payment once", "wallet-retry", "Checkout/Payment"],
	["Lock sign-in after five wrong passwords", "signin-lock", "Accounts/Sign-in"],
	["End the other sessions on a password reset", "reset-sessions", "Accounts/Password reset"],
	["Validate postal codes per country", "postal-codes", "Accounts/Addresses"],
	["Page the order history", "order-paging", "Orders/History"],
	["Let a guest track an order", "guest-tracking", "Orders/Tracking"],
	["Refund the tax of a returned item", "refund-tax", "Orders/Returns"],
	["Add credit notes to invoices", "credit-notes", "Orders/Invoices"],
	["Suggest a spelling when a search finds nothing", "search-spelling", "Catalog/Search"],
	["Keep the filters when going back from a product", "filters-back", "Catalog/Filters"],
	["Show stock per size on the product page", "stock-per-size", "Catalog/Product page"],
	["Approve reviews in the back office", "review-approval", "Catalog/Reviews"],
	["Announce wishlist items that are back in stock", "wishlist-stock", "Catalog/Wishlist"],
	["Refuse a stock file with a bad row", "stock-import", "Back office/Inventory"],
	["Plan a sale with a start and an end", "sale-dates", "Back office/Pricing"],
	["Limit a coupon to one category", "coupon-category", "Back office/Promotions"],
	["Write staff changes to the audit log", "staff-audit", "Back office/Staff"],
	["Send one email per status change", "status-email", "Notifications/Email"],
	["Stop push messages after sign-out", "push-signout", "Notifications/Push"],
	["Pick the currency from the device region", "region-currency", "Mobile app/Onboarding"],
	["Make POST /orders idempotent", "orders-idempotency", "API/Orders"],
	["Retry failed webhook deliveries", "webhook-retry", "API/Webhooks"],
];

const ASSERTIONS = [
	"expected 200, got 500",
	'expected "Order placed", got "Something went wrong"',
	"expected 1 line item, got 2",
	"expected total 108.00, got 100.00",
	"expected status Shipped, got Processing",
	"expected the confirmation email, got none",
];
/** What the flaky test says when it fails; the job runs it again and it passes. */
const FLAKE = "socket hang up while waiting for the payment widget";
/** What a night without its services looks like: one cause in several tests. */
const OUTAGES: readonly (readonly [message: string, reason: string])[] = [
	["connect ECONNREFUSED payments-sandbox.internal:443", "The payment sandbox was down for the night."],
	["503 Service Unavailable from the staging mail server", "Staging mail was being moved; the next run passed."],
];

/** The runs a person works through, one after another, oldest first. `{v}` is the release being tested. */
const RUNS: readonly { name: string; areas: readonly string[]; size: number }[] = [
	{ name: "Release {v} regression: checkout", areas: ["Checkout"], size: 24 },
	{ name: "Release {v} regression: accounts", areas: ["Accounts"], size: 20 },
	{ name: "Mobile app smoke for {v}", areas: ["Mobile app", "Notifications"], size: 12 },
	{ name: "Release {v} regression: orders", areas: ["Orders"], size: 20 },
	{ name: "Release {v} regression: catalog", areas: ["Catalog"], size: 30 },
	{ name: "Back office walkthrough for {v}", areas: ["Back office"], size: 16 },
	{ name: "API and webhooks check for {v}", areas: ["API"], size: 12 },
];
/** How a run ended: all passed, a failure a person excused, a defect that keeps it open, or not finished yet. */
type Ending = "passed" | "excused" | "defect" | "unfinished";

const EDITS: readonly (readonly [action: string, expected: string, reason: string])[] = [
	["Reload the page", "Nothing has changed", "Check that the result survives a reload."],
	["Open the same page in a second tab", "Both tabs show the same state", "Two tabs disagreed in production."],
	["Repeat the last step with the keyboard only", "The result is the same", "Add the keyboard path."],
	["Sign out and sign in again", "The result is still there", "Check that it is saved, not only shown."],
	["Open the audit log", "The action is listed with who did it", "The audit log is part of the feature."],
	["Switch to the mobile layout", "Nothing is cut off", "The mobile layout was never checked here."],
];

const REVIEWS: readonly (readonly ["ambiguous" | "missing-expected" | "uncovered-path", string])[] = [
	["ambiguous", "The expected result does not say what the customer sees when it fails."],
	["missing-expected", "The first step has no expected result, so a wrong start goes unnoticed."],
	["uncovered-path", "Nothing checks the same action from the mobile layout."],
];

/** A commit hash drawn from the stream. */
export const hex = (rng: () => number, length = 40): string =>
	Array.from({ length }, () => Math.floor(rng() * 16).toString(16)).join("");
const between = (rng: () => number, from: number, to: number): number => from + Math.floor(rng() * (to - from));
const areaOf = (folder: string): string => folder.split("/")[0] ?? folder;
const fileOf = (folder: string): string => `src/${folder.toLowerCase().replace(/[^a-z0-9/]+/g, "-")}.ts`;

/** The start of the UTC day `ago` days before the day `since` falls on. */
export const dayStart = (since: number, ago: number): number => Math.floor(since / DAY) * DAY - ago * DAY;

/** How far before `since` today's earliest write is (`seed.ts`), when today has had that long. */
const TODAY_REACH = 4.5 * HOUR + MINUTE;
/**
 * The moment `ago` before `since` on the day `since` falls on. A demo made in the first hours of a UTC day has had
 * less of today than today's writes reach back: their moments are drawn closer together, in the same order, so
 * that none of them falls on yesterday beside yesterday's history.
 */
export const todayAt = (since: number, ago: number): number =>
	since - Math.round(ago * Math.min(1, (since - dayStart(since, 0)) / TODAY_REACH));

/**
 * The history of a demo that became one at `since`, over the `days` days before that day. Every time is before
 * the start of that day, and no day's last event is later than 18:00, so what the seed writes for today (in the
 * hours before `since`) always comes after it.
 */
export function demoHistory(options: {
	seed: number;
	cases: readonly DemoCase[];
	days: number;
	since: number;
}): HistoryEvent[] {
	const { cases, days, since } = options;
	// Its own stream, so the history of a seed does not move when the catalog gains a scenario.
	const rng = random(options.seed ^ 0x9e3779b9);
	const events: HistoryEvent[] = [];
	if (days <= 0) return events;

	// The first case is the one today's failure is about. It never fails in the history: a failure answered
	// there would answer today's.
	const automated = cases.flatMap((item, index) => (item.test && index > 0 ? [index] : []));
	const inFolder = (folder: string) => automated.filter((index) => cases[index]?.folder === folder);
	const failing = (folder: string, count: number): number[] => {
		const near = inFolder(folder);
		return shuffled(rng, near.length > 0 ? near : automated).slice(0, count);
	};

	// ── The runs, and the cases they pin: an edit stays away from those. One every other day; yesterday's is not
	// finished, the one before it found a defect, and one in the middle met an outage a person excused. ──
	const agos = [...new Set([...Array.from({ length: Math.ceil(days / 2) }, (_, k) => days - 1 - 2 * k), 2, 1])]
		.filter((ago) => ago >= 1 && ago <= days)
		.sort((a, b) => b - a);
	const runs = agos.flatMap((ago, k) => {
		const run = RUNS[k % RUNS.length];
		if (!run) return [];
		const selected = cases
			.flatMap((item, index) => (run.areas.includes(areaOf(item.folder)) ? [index] : []))
			.slice(0, run.size);
		const ends: Ending =
			ago === 1 ? "unfinished" : ago === 2 ? "defect" : k === Math.floor(agos.length / 2) - 1 ? "excused" : "passed";
		const name = run.name.replace("{v}", `4.${10 + Math.floor(k / 2)}`);
		return selected.length > 0 ? [{ name, ago, selected, ends }] : [];
	});
	const pinned = new Set(runs.flatMap((run) => run.selected));
	const editable = shuffled(
		rng,
		cases.flatMap((item, index) => (!item.test && !pinned.has(index) ? [index] : [])),
	);

	// ── The nights that went wrong: two defects on `main`, a few days apart, and one night without its services. ──
	const nights = shuffled(
		rng,
		Array.from({ length: Math.max(0, days - 3) }, (_, n) => n + 3),
	);
	const defectNights = new Map(
		nights.slice(0, 2).map((ago, n) => [ago, `SHOP-${1180 + n * 37 + between(rng, 0, 20)}`]),
	);
	const outageNight = nights[2];

	// ── Tests that sometimes fail on `main` and pass when the job runs again (decision 0095). The first
	// also demonstrates runner retries; up to 24 more make the reports page. No extra random draws.
	// Its own stream leaves the rest of the history unchanged. The first automated test is quarantined. ──
	const flakyRng = random(options.seed ^ 0x3c6ef372);
	const flaky = automated.length > 1 ? automated[1 + Math.floor(flakyRng() * (automated.length - 1))] : undefined;
	// Some pull requests' runs see the same test fail once and pass when the runner tries it again (decision 0129).
	// Their own stream too.
	const retryRng = random(options.seed ^ 0x27d4eb2f);
	const flakyCases =
		flaky === undefined
			? []
			: [flaky, ...automated.filter((index) => index !== flaky && index !== automated[0]).slice(0, 24)];

	// ── The pull requests, numbered up to the one before today's. ──
	// Draw the quieter days from their own stream, so the real weekday only changes dates.
	const firstWeekday = between(random(options.seed ^ 0x85ebca6b), 0, 7);
	const perDay = Array.from({ length: days }, (_, n) => {
		const weekday = (firstWeekday + n) % 7;
		return weekday === 0 || weekday === 6 ? (rng() < 0.3 ? 1 : 0) : between(rng, 1, 4);
	});
	let pr = 482 - perDay.reduce((sum, n) => sum + n, 0);
	const changes = shuffled(rng, CHANGES);
	let change = 0;
	let edit = 0;
	const merged: number[] = [];

	for (let n = 0; n < days; n++) {
		const ago = days - n;
		const start = dayStart(since, ago);

		// The night's run on `main`. The suite arrives on the first morning, so that day's run follows it.
		const main = hex(rng);
		const nightAt = n === 0 ? start + 8 * HOUR + 40 * MINUTE : start + 3 * HOUR + between(rng, 0, 20) * MINUTE;
		const defect = defectNights.get(ago);
		const outage = ago === outageNight ? pick(rng, OUTAGES) : null;
		const [outageMessage, outageReason] = outage ?? ["", ""];
		const failures: Failure[] = defect
			? failing(pick(rng, CATALOG).path, 1).map((index) => ({ case: index, message: pick(rng, ASSERTIONS) }))
			: outage
				? failing("Checkout/Payment", 4).map((index) => ({ case: index, message: outageMessage }))
				: [];
		const flakes = flakyRng() < 0.4 && failures.length === 0 && flaky !== undefined;
		events.push({
			kind: "pipeline",
			at: nightAt,
			step: `n${ago}`,
			target: { commit: main, branch: "main" },
			failures: flakes ? flakyCases.map((index) => ({ case: index, message: FLAKE })) : failures,
			jitter: rng(),
		});
		if (flakes)
			events.push({
				kind: "pipeline",
				at: nightAt + 9 * MINUTE,
				step: `n${ago}r`,
				target: { commit: main, branch: "main" },
				failures: [],
				rerun: { attempt: 2, cases: flakyCases },
				jitter: 0.5,
			});
		if (n === 0) events.push({ kind: "link", at: nightAt + 12 * MINUTE, step: "link" });
		if (failures.length > 0)
			events.push({
				kind: "answer",
				at: Math.max(nightAt, start + 8 * HOUR) + between(rng, 20, 50) * MINUTE,
				step: `n${ago}a`,
				of: `n${ago}`,
				answer: defect ? { is: "defect", ref: defect } : { is: "infra" },
				reason: defect ? `Broke with last night's merge. Tracked as ${defect}.` : outageReason,
			});

		// The day's pull requests, one after another from mid-morning. One in four fails first and is fixed.
		let at = start + 9 * HOUR + between(rng, 0, 30) * MINUTE;
		for (let k = 0; k < (perDay[n] ?? 0); k++) {
			const [title, branch, folder] = changes[change++ % changes.length] ?? ["Tidy up", "tidy-up", ""];
			const number = pr++;
			const target = { branch, pr: number, base: main, title, files: [fileOf(folder), fileOf(`${folder} test`)] };
			const broke = rng() < 0.25 ? failing(folder, between(rng, 1, 3)) : [];
			const message = pick(rng, ASSERTIONS);
			const retried =
				flaky !== undefined && !broke.includes(flaky) && retryRng() < 0.3 ? [{ case: flaky, message: FLAKE }] : [];
			events.push({
				kind: "pipeline",
				at,
				step: `p${number}c1`,
				target: { ...target, commit: hex(rng) },
				failures: broke.map((index) => ({ case: index, message })),
				jitter: rng(),
				...(retried.length > 0 ? { retried } : {}),
			});
			let last = at;
			if (broke.length > 0) {
				const testWasWrong = rng() < 0.35;
				events.push({
					kind: "answer",
					at: at + between(rng, 12, 25) * MINUTE,
					step: `p${number}c1a`,
					of: `p${number}c1`,
					answer: testWasWrong ? { is: "test" } : { is: "defect" },
					reason: testWasWrong
						? "The test still expected the old behaviour. Updated in the next commit."
						: "The change broke this. Fixed in the next commit.",
				});
				last = at + between(rng, 30, 55) * MINUTE;
				events.push({
					kind: "pipeline",
					at: last,
					step: `p${number}c2`,
					target: { ...target, commit: hex(rng) },
					failures: [],
					jitter: rng(),
				});
			}
			// It merges a quarter of an hour after its last report. Drawn from nothing, so the rest stays as it was.
			events.push({ kind: "end", at: last + 15 * MINUTE, step: `p${number}m`, pr: number });
			merged.push(number);
			at += between(rng, 65, 110) * MINUTE;
		}

		// A case reworded or extended, most days, after the pull requests.
		const target = editable[edit];
		if (target !== undefined && rng() < 0.6) {
			const [action, expected, reason] = EDITS[edit % EDITS.length] ?? ["Reload the page", "Nothing has changed", ""];
			events.push({
				kind: "edit",
				at: start + 17 * HOUR + between(rng, 0, 40) * MINUTE,
				step: `e${edit}`,
				case: target,
				add: { action, expected },
				reason,
			});
			edit++;
		}
	}

	// ── Two cases archived halfway through, from the end of the cases no edit reaches. Drawn from nothing. ──
	const retired = editable.slice(Math.max(edit, editable.length - 2));
	if (retired.length > 0)
		events.push({
			kind: "archive",
			at: dayStart(since, Math.max(1, Math.ceil(days / 2))) + 17 * HOUR + 50 * MINUTE,
			step: "retire",
			cases: retired,
			reason: "The API checks cover these now.",
		});

	// ── The runs: planned in the morning and worked through in three sittings that day. ──
	runs.forEach((run, index) => {
		const start = dayStart(since, run.ago);
		const step = `r${index}`;
		events.push({
			kind: "plan",
			at: start + 8 * HOUR + (10 + index) * MINUTE,
			step,
			name: run.name,
			cases: run.selected,
		});
		const done = run.ends === "unfinished" ? Math.ceil(run.selected.length * 0.55) : run.selected.length;
		const worked = run.selected.slice(0, done);
		const sittings = [10 * HOUR + 5 * MINUTE, 13 * HOUR + 40 * MINUTE, 16 * HOUR + 15 * MINUTE];
		const size = Math.ceil(worked.length / sittings.length);
		const bad = run.ends === "excused" || run.ends === "defect" ? worked.at(-2) : undefined;
		sittings.forEach((offset, sitting) => {
			const batch = worked.slice(sitting * size, (sitting + 1) * size);
			if (batch.length === 0) return;
			const failed =
				run.ends === "defect"
					? {
							message: "The page shows the old value until it is reloaded",
							note: "Every time in Safari; Chrome is fine.",
						}
					: { message: "No email arrived within five minutes", note: "Staging mail looked down. Tried twice." };
			events.push({
				kind: "execute",
				at: start + offset + index * MINUTE,
				step: `${step}x${sitting}`,
				run: run.name,
				results: batch.map((item, index) => ({
					case: item,
					...(item === bad ? { failed } : {}),
					...((item + index) % 4 === 0 ? {} : { durationMs: (1 + (item % 12)) * MINUTE }),
				})),
			});
			if (batch.includes(bad ?? -1))
				events.push({
					kind: "answer",
					at: start + offset + (25 + index) * MINUTE,
					step: `${step}x${sitting}a`,
					of: `${step}x${sitting}`,
					answer: run.ends === "defect" ? { is: "defect", ref: "SHOP-1262" } : { is: "infra" },
					reason:
						run.ends === "defect"
							? "A real defect. The release waits for SHOP-1262."
							: "Staging mail was down that afternoon. Checked by hand the next morning.",
				});
		});
	});

	// ── Two reviews by the agent of pull requests that merged, each with one finding a person answered. ──
	const reviewable = shuffled(
		rng,
		cases.flatMap((item, index) => (index > 0 && item.steps.length > 0 ? [index] : [])),
	);
	shuffled(rng, merged)
		.slice(0, Math.min(2, reviewable.length))
		.forEach((number, index) => {
			const first = events.find((event) => event.step === `p${number}c1`);
			const about = reviewable[index];
			const [category, note] = REVIEWS[index % REVIEWS.length] ?? ["ambiguous", ""];
			if (!first || about === undefined) return;
			events.push({
				kind: "review",
				at: first.at + 9 * MINUTE,
				step: `k${index}`,
				about: number,
				finding: { case: about, category, note },
			});
			events.push({
				kind: "answer",
				at: first.at + 31 * MINUTE,
				step: `k${index}a`,
				of: `k${index}`,
				answer: index === 0 ? { is: "accept" } : { is: "reject" },
				reason: index === 0 ? "Right. The case is reworded." : "The mobile layout has its own cases.",
			});
		});

	const quarantined = automated[0];
	if (quarantined !== undefined) {
		const at = dayStart(since, days) + 17 * HOUR + 40 * MINUTE;
		const commit = hex(random(options.seed ^ 0x6a09e667));
		events.push(
			{
				kind: "quarantine",
				at,
				step: "qenter",
				case: quarantined,
				active: true,
				reason: "Keep an intermittent failure visible during its repair",
			},
			{
				kind: "pipeline",
				at: at + MINUTE,
				step: "qreport",
				target: { commit, branch: "main" },
				failures: [{ case: quarantined, message: "Intermittent response during quarantine example" }],
				jitter: 0,
			},
			{
				kind: "answer",
				at: at + 2 * MINUTE,
				step: "qanswer",
				of: "qreport",
				answer: { is: "infra" },
				reason: "The isolated example runner lost its connection",
			},
			{
				kind: "quarantine",
				at: at + 3 * MINUTE,
				step: "qexit",
				case: quarantined,
				active: false,
				reason: "The repair is checked; the earlier covered result stays excused",
			},
		);
	}

	// A stable order: by time, and at the same time the order they were made in.
	return events
		.map((event, order) => ({ event, order }))
		.sort((a, b) => a.event.at - b.event.at || a.order - b.order)
		.map(({ event }) => event);
}
