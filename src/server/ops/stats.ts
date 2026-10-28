// The reports (decision 0095): one read, `stats`, with one answer for each kind named by `of`.

import { localDays } from "../../core/days.ts";
import { REPLIES } from "../../core/replies.ts";
import { StatsInput, type StatsOf, type StatsReply } from "../../core/stats.ts";
import { testById, testRef } from "../evidence/evidence.ts";
import { effectiveQuarantine, quarantineEntry } from "../evidence/quarantine.ts";
import {
	automatedCases,
	caseOutcomes,
	flakyTests,
	outcomesByDay,
	rerunsByTest,
	runsByHand,
	testsReporting,
	totalOf,
} from "../evidence/stats.ts";
import type { Ctx } from "../kernel/ctx.ts";
import type { ReadDb } from "../kernel/db.ts";
import { automationOfCases, requirementCases } from "../suite/read.ts";
import { caseById, caseRef } from "../suite/suite.ts";
import { defineOp } from "./registry.ts";

const DAY = 86_400_000;

/** A test as a report lists it: its ref, name, file and case. */
async function testRow(ctx: Ctx<ReadDb>, id: number) {
	const test = await testById(ctx.db, id);
	if (!test) throw new Error(`a result names test ${id}, which does not exist`);
	const linked = test.case_id === null ? null : await caseById(ctx.db, test.case_id);
	return { test: testRef(test), name: test.name, file: test.file, case: linked ? caseRef(linked) : null };
}

async function passRate(
	ctx: Ctx<ReadDb>,
	input: Extract<StatsInput, { of: "pass-rate" }>,
): Promise<StatsOf<"pass-rate">> {
	const days = localDays(ctx.now, input.days, input.zone);
	const method = input.method ?? null;
	const counts = await outcomesByDay(ctx.db, { project: ctx.project.id, days, method });
	return {
		of: "pass-rate",
		zone: input.zone,
		method,
		days: days.map((day, i) => ({ day: day.day, ...(counts[i] ?? totalOf([])) })),
		total: totalOf(counts),
	};
}

function page(total: number, input: { cursor: number; limit: number }) {
	const next = input.cursor + input.limit;
	return { total, cursor: next < total ? next : null };
}

async function flaky(ctx: Ctx<ReadDb>, input: Extract<StatsInput, { of: "flaky" }>): Promise<StatsOf<"flaky">> {
	const since = ctx.now - input.days * DAY;
	const rows = await flakyTests(ctx.db, ctx.project.id, since);
	return {
		of: "flaky",
		tests: await testsReporting(ctx.db, ctx.project.id, since),
		flaky: rows.length,
		...page(rows.length, input),
		items: await Array.fromAsync(rows.slice(input.cursor, input.cursor + input.limit), async (row) => {
			const entry = await quarantineEntry(ctx.db, ctx.project.id, row.test);
			return {
				...(await testRow(ctx, row.test)),
				flips: row.flips,
				lastAt: row.last_at,
				quarantined: entry ? await effectiveQuarantine(ctx.db, entry, ctx.now) : false,
			};
		}),
	};
}

async function reruns(ctx: Ctx<ReadDb>, input: Extract<StatsInput, { of: "reruns" }>): Promise<StatsOf<"reruns">> {
	const rows = (await rerunsByTest(ctx.db, ctx.project.id, ctx.now - input.days * DAY)).sort(
		(a, b) => b.lost - a.lost || b.reruns - a.reruns || a.test - b.test,
	);
	return {
		of: "reruns",
		...page(rows.length, input),
		reruns: rows.reduce((sum, row) => sum + row.reruns, 0),
		lostMs: Math.max(
			0,
			Math.min(
				Number.MAX_SAFE_INTEGER,
				rows.reduce((sum, row) => sum + row.lost, 0),
			),
		),
		unknown: rows.reduce((sum, row) => sum + row.unknown, 0),
		items: await Array.fromAsync(rows.slice(input.cursor, input.cursor + input.limit), async (row) => ({
			...(await testRow(ctx, row.test)),
			reruns: row.reruns,
			lostMs: row.lost,
		})),
	};
}

async function automation(
	ctx: Ctx<ReadDb>,
	input: Extract<StatsInput, { of: "automation" }>,
): Promise<StatsOf<"automation">> {
	const project = ctx.project.id;
	const cases = await automationOfCases(ctx.db, project);
	const automated = await automatedCases(ctx.db, project);
	const byHand = new Map(
		(await runsByHand(ctx.db, project, ctx.now - input.days * DAY)).map((row) => [row.case_id, row]),
	);
	const manual = { wanted: 0, none: 0, notApplicable: 0 };
	const backlog: StatsOf<"automation">["backlog"] = [];
	let count = 0;
	for (const row of cases) {
		if (automated.has(row.id)) {
			count += 1;
			continue;
		}
		if (row.automate === "not-applicable") {
			manual.notApplicable += 1;
			continue;
		}
		manual[row.automate] += 1;
		const runs = byHand.get(row.id);
		backlog.push({
			case: caseRef(row),
			title: row.title,
			automate: row.automate,
			runs: runs?.runs ?? 0,
			timeMs: runs?.time ?? null,
		});
	}
	backlog.sort(
		(a, b) =>
			b.runs - a.runs ||
			(b.timeMs ?? -1) - (a.timeMs ?? -1) ||
			Number(b.automate === "wanted") - Number(a.automate === "wanted"),
	);
	const automatable = cases.length - manual.notApplicable;
	return {
		of: "automation",
		cases: cases.length,
		automated: count,
		manual,
		rate: automatable === 0 ? null : count / automatable,
		...page(backlog.length, input),
		backlog: backlog.slice(input.cursor, input.cursor + input.limit),
	};
}

async function manualEffort(
	ctx: Ctx<ReadDb>,
	input: Extract<StatsInput, { of: "manual-effort" }>,
): Promise<StatsOf<"manual-effort">> {
	const from = ctx.now - input.days * DAY;
	const cases = new Map((await automationOfCases(ctx.db, ctx.project.id)).map((row) => [row.id, row]));
	const automated = await automatedCases(ctx.db, ctx.project.id);
	const rows = (await runsByHand(ctx.db, ctx.project.id, from, ctx.now))
		.filter((row) => cases.has(row.case_id))
		.sort((a, b) => (b.time ?? -1) - (a.time ?? -1) || b.runs - a.runs || a.case_id - b.case_id);
	return {
		of: "manual-effort",
		from,
		to: ctx.now,
		...page(rows.length, input),
		items: rows.slice(input.cursor, input.cursor + input.limit).map((row) => {
			const c = cases.get(row.case_id);
			if (!c) throw new Error("manual effort case disappeared");
			return {
				case: caseRef(c),
				title: c.title,
				automated: automated.has(c.id),
				runs: row.runs,
				timed: row.timed,
				untimed: row.runs - row.timed,
				timeMs: row.time,
				averageMs: row.average,
			};
		}),
	};
}

async function coverage(
	ctx: Ctx<ReadDb>,
	input: Extract<StatsInput, { of: "coverage" }>,
): Promise<StatsOf<"coverage">> {
	const requirements = await requirementCases(ctx.db, ctx.project.id);
	const listed = requirements.slice(input.cursor, input.cursor + input.limit);
	const outcomes = await caseOutcomes(
		ctx.db,
		ctx.project.id,
		[...new Set(listed.flatMap((requirement) => requirement.cases))],
		ctx.now - input.days * DAY,
	);
	return {
		of: "coverage",
		requirements: requirements.length,
		...page(requirements.length, input),
		covered: requirements.filter((requirement) => requirement.cases.length > 0).length,
		items: listed.map((requirement) => {
			const counts = { passed: 0, failed: 0, other: 0, notRun: 0 };
			for (const id of requirement.cases) counts[outcomes.get(id) ?? "notRun"] += 1;
			return { key: requirement.key, title: requirement.title, cases: requirement.cases.length, ...counts };
		}),
	};
}

export async function stats(ctx: Ctx<ReadDb>, input: StatsInput): Promise<StatsReply> {
	switch (input.of) {
		case "manual-effort":
			return await manualEffort(ctx, input);
		case "pass-rate":
			return await passRate(ctx, input);
		case "flaky":
			return await flaky(ctx, input);
		case "reruns":
			return await reruns(ctx, input);
		case "automation":
			return await automation(ctx, input);
		case "coverage":
			return await coverage(ctx, input);
	}
}

export const statsOp = defineOp({
	name: "stats",
	output: REPLIES.stats,
	summary:
		"Reports over the last days: pass rate per day, flaky tests, time lost to reruns, automation and its backlog, manual effort, coverage by requirement.",
	input: StatsInput,
	needs: "read",
	scope: "project",
	effect: "read",
	// The agent tools are at their token budget (decision 0101); an agent reads these over HTTP or the CLI.
	mcp: null,
	run: stats,
});
