// The demo's history: every day has something, in order, before today, and nothing in it comes back open.
import { describe, expect, test } from "bun:test";
import { demoCases } from "./cases.ts";
import { DAY, dayStart, demoHistory, type HistoryEvent, REVIEW_CHANGE, todayAt } from "./history.ts";

// A Tuesday afternoon, so the fortnight before it holds two weekends.
const SINCE = Date.UTC(2026, 9, 13, 15, 30);
const suite = demoCases(1, 2000);
const history = (days = 14, seed = 1, cases = suite): HistoryEvent[] =>
	demoHistory({ seed, cases, days, since: SINCE });
const of = <K extends HistoryEvent["kind"]>(events: HistoryEvent[], kind: K) =>
	events.filter((event): event is Extract<HistoryEvent, { kind: K }> => event.kind === kind);

describe("the demo's history", () => {
	test("today's review change selects enough existing checkout cases to show impact continuation", () => {
		const checkout = suite.flatMap((item) => (item.folder.startsWith("Checkout") && item.test ? [item.test] : []));
		expect(checkout.length).toBeGreaterThan(200);
		for (const test of checkout) expect(REVIEW_CHANGE.files).toContain(test.file);
	});

	test("the same seed gives the same history, and another seed gives another", () => {
		expect(history()).toEqual(history());
		expect(history(14, 2)).not.toEqual(history());
	});

	test("the same seed on different weekdays gives the same demo, with its dates shifted", () => {
		const relative = (since: number) =>
			demoHistory({ seed: 1, cases: suite, days: 14, since }).map((event) => ({
				...event,
				at: event.at - dayStart(since, 0),
			}));
		const tuesday = relative(SINCE);
		for (const later of [1, 4, 7]) expect(relative(SINCE + later * DAY)).toEqual(tuesday);
	});

	test("no history is asked for with no days", () => {
		expect(history(0)).toEqual([]);
	});

	test("every day of it has a pipeline's report on main, and the days reach back as far as was asked", () => {
		for (const days of [1, 10, 14, 30]) {
			const nights = of(history(days), "pipeline").filter(
				(event) => event.target.branch === "main" && event.step !== "qreport" && !event.rerun,
			);
			const dates = nights.map((event) => Math.floor(event.at / DAY));
			expect(dates).toEqual(Array.from({ length: days }, (_, n) => Math.floor(SINCE / DAY) - days + n));
		}
	});

	test("the events are in the order they happened, each before 18:00 of a day before today", () => {
		const events = history(30);
		expect(events.map((event) => event.at)).toEqual(events.map((event) => event.at).toSorted((a, b) => a - b));
		for (const event of events) {
			expect(event.at).toBeGreaterThanOrEqual(dayStart(SINCE, 30));
			expect(event.at).toBeLessThan(dayStart(SINCE, 0));
			expect(event.at % DAY).toBeLessThanOrEqual(18 * 3_600_000);
		}
	});

	test("every event has a name of its own, short enough for a command id", () => {
		const steps = history(90).map((event) => event.step);
		expect(new Set(steps).size).toBe(steps.length);
		// `demo-<project>-<step>-v2` is at most 64 characters, and a project's key at most 40.
		expect(Math.max(...steps.map((step) => step.length))).toBeLessThanOrEqual(15);
	});

	test("a failure is answered or passed by a rerun after it was reported, and the case of today's failure never fails before today", () => {
		const events = history(30);
		const failed = events.filter(
			(event) =>
				(event.kind === "pipeline" && event.failures.length > 0) ||
				(event.kind === "execute" && event.results.some((result) => result.failed)),
		);
		expect(failed.length).toBeGreaterThan(5);
		for (const event of failed) {
			const answer = of(events, "answer").find((candidate) => candidate.of === event.step);
			const rerun = of(events, "pipeline").find((candidate) => candidate.rerun && candidate.step === `${event.step}r`);
			expect((answer ?? rerun)?.at).toBeGreaterThan(event.at);
		}
		for (const event of of(events, "pipeline")) {
			expect(event.failures.map((failure) => failure.case)).not.toContain(0);
			for (const failure of event.failures) expect(suite[failure.case]?.test).not.toBeNull();
		}
	});

	test("the pull requests are numbered one after another, up to the one before today's", () => {
		const numbers = [...new Set(of(history(), "pipeline").flatMap((event) => event.target.pr ?? []))];
		expect(numbers.length).toBeGreaterThan(10);
		expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, n) => 482 - numbers.length + n));
	});

	test("a run is planned every other day and worked through after it was planned: closed ones, a failed one, one not finished", () => {
		const events = history();
		const plans = of(events, "plan");
		expect(plans.length).toBeGreaterThanOrEqual(7);
		expect(new Set(plans.map((plan) => plan.name)).size).toBe(plans.length);
		for (const plan of plans) {
			const sittings = of(events, "execute").filter((event) => event.run === plan.name);
			expect(sittings.length).toBeGreaterThan(0);
			for (const sitting of sittings) {
				expect(sitting.at).toBeGreaterThan(plan.at);
				for (const result of sitting.results) expect(plan.cases).toContain(result.case);
			}
		}
		const worked = (name: string) =>
			of(events, "execute")
				.filter((event) => event.run === name)
				.flatMap((event) => event.results);
		const last = plans.at(-1);
		expect(worked(last?.name ?? "").length).toBeLessThan(last?.cases.length ?? 0);
		for (const plan of plans.slice(0, -1)) expect(worked(plan.name).length).toBe(plan.cases.length);
	});

	test("an edit touches a case once, and never one a test reports on or a run has pinned", () => {
		const events = history(30);
		const edited = of(events, "edit").map((event) => event.case);
		expect(edited.length).toBeGreaterThan(5);
		expect(new Set(edited).size).toBe(edited.length);
		const pinned = new Set(of(events, "plan").flatMap((event) => event.cases));
		for (const index of edited) {
			expect(suite[index]?.test).toBeNull();
			expect(pinned.has(index)).toBe(false);
		}
	});

	test("every pull request but today's merges after its last report, and two cases nothing else uses are archived", () => {
		const events = history();
		const ends = of(events, "end");
		const numbers = [...new Set(of(events, "pipeline").flatMap((event) => event.target.pr ?? []))];
		expect(ends.map((event) => event.pr).sort()).toEqual(numbers.sort());
		for (const end of ends) {
			const last = of(events, "pipeline")
				.filter((event) => event.target.pr === end.pr)
				.at(-1);
			expect(end.at).toBeGreaterThan(last?.at ?? Number.POSITIVE_INFINITY);
		}
		const [archive, ...more] = of(events, "archive");
		expect(more).toEqual([]);
		expect(archive?.cases).toHaveLength(2);
		const used = new Set([
			...of(events, "edit").map((event) => event.case),
			...of(events, "plan").flatMap((event) => event.cases),
		]);
		for (const index of archive?.cases ?? []) {
			expect(suite[index]?.test).toBeNull();
			expect(used.has(index)).toBe(false);
		}
	});

	test("a demo of one case has a history too", () => {
		const tiny = demoCases(1, 1);
		const events = history(14, 1, tiny);
		expect(of(events, "pipeline").length).toBeGreaterThanOrEqual(14);
		for (const event of of(events, "pipeline")) expect(event.failures).toEqual([]);
	});
	test("25 flaky tests fill more than one report page and pass when the job runs again", () => {
		const events = of(history(), "pipeline");
		const reruns = events.filter((event) => event.rerun);
		expect(reruns.length).toBeGreaterThanOrEqual(2);
		const flaky = reruns[0]?.rerun?.cases;
		expect(flaky).toHaveLength(25);
		for (const rerun of reruns) {
			expect(rerun.rerun).toEqual({ attempt: 2, cases: flaky ?? [] });
			expect(rerun.failures).toEqual([]);
			// The repeated night failed exactly the tests in the rerun.
			const night = events.find((event) => event.step === rerun.step.slice(0, -1));
			expect(night?.target.commit).toBe(rerun.target.commit);
			expect(night?.failures.map((failure) => failure.case)).toEqual(flaky ?? []);
			expect(night?.at).toBeLessThan(rerun.at);
		}
	});
	test("the runner tries the flaky test again inside some pull requests' runs, and it passes there", () => {
		const events = of(history(), "pipeline");
		const flaky = events.find((event) => event.rerun)?.rerun?.cases[0];
		const retried = events.filter((event) => event.retried);
		expect(retried.length).toBeGreaterThanOrEqual(2);
		for (const event of retried) {
			expect(event.target.pr).toBeDefined();
			expect(event.retried?.map((item) => item.case)).toEqual([flaky ?? -1]);
			expect(event.failures.map((failure) => failure.case)).not.toContain(flaky);
		}
	});

	test("a quarantine covers a report before a person ends it", () => {
		const events = history();
		const [entry, exit] = of(events, "quarantine");
		const covered = of(events, "pipeline").find((event) => event.step === "qreport");
		expect(entry).toMatchObject({ active: true, step: "qenter" });
		expect(exit).toMatchObject({ active: false, case: entry?.case });
		expect(covered).toMatchObject({
			failures: [{ case: entry?.case, message: "Intermittent response during quarantine example" }],
		});
		expect(entry?.at).toBeLessThan(covered?.at ?? 0);
		expect(exit?.at).toBeGreaterThan(covered?.at ?? Number.POSITIVE_INFINITY);
	});
});

test("today's moments stay on today, in their order, however early in the UTC day the demo is made", () => {
	const afternoon = Date.parse("2026-10-21T15:00:00Z");
	expect(new Date(todayAt(afternoon, 90 * 60_000)).toISOString()).toBe("2026-10-21T13:30:00.000Z");
	const early = Date.parse("2026-10-21T01:20:00Z");
	const moments = [4.5, 3, 1.5, 0.5].map((hours) => todayAt(early, hours * 3_600_000));
	expect(moments.map((at) => new Date(at).toISOString())).toEqual([
		"2026-10-21T00:00:17.712Z",
		"2026-10-21T00:26:51.808Z",
		"2026-10-21T00:53:25.904Z",
		"2026-10-21T01:11:08.635Z",
	]);
});
