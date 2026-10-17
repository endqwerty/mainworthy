// The reports (decision 0094): one read, `stats`, with one answer for each kind named by `of`.

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
import { automationOfCases, requirementCases } from "../suite/read.ts";
import { caseById, caseRef } from "../suite/suite.ts";
import { defineOp } from "./registry.ts";

const DAY = 86_400_000;

/** A test as a report lists it: its ref, name, file and case. */
function testRow(ctx: Ctx, id: number) {
	const test = testById(ctx.db, id);
	if (!test) throw new Error(`a result names test ${id}, which does not exist`);
	const linked = test.case_id === null ? null : caseById(ctx.db, test.case_id);
	return { test: testRef(test), name: test.name, file: test.file, case: linked ? caseRef(linked) : null };
}

function passRate(ctx: Ctx, input: Extract<StatsInput, { of: "pass-rate" }>): StatsOf<"pass-rate"> {
	const days = localDays(ctx.now, input.days, input.zone);
	const method = input.method ?? null;
	const counts = outcomesByDay(ctx.db, { project: ctx.project.id, days, method });
	return {
		of: "pass-rate",
		zone: input.zone,
		method,
		days: days.map((day, i) => ({ day: day.day, ...(counts[i] ?? totalOf([])) })),
		total: totalOf(counts),
	};
}

function flaky(ctx: Ctx, input: Extract<StatsInput, { of: "flaky" }>): StatsOf<"flaky"> {
	const since = ctx.now - input.days * DAY;
	const rows = flakyTests(ctx.db, ctx.project.id, since);
	return {
		of: "flaky",
		tests: testsReporting(ctx.db, ctx.project.id, since),
		flaky: rows.length,
		items: rows.slice(0, input.limit).map((row) => {
			const entry = quarantineEntry(ctx.db, ctx.project.id, row.test);
			return {
				...testRow(ctx, row.test),
				flips: row.flips,
				lastAt: row.last_at,
				quarantined: entry ? effectiveQuarantine(ctx.db, entry, ctx.now) : false,
			};
		}),
	};
}

function reruns(ctx: Ctx, input: Extract<StatsInput, { of: "reruns" }>): StatsOf<"reruns"> {
	const rows = rerunsByTest(ctx.db, ctx.project.id, ctx.now - input.days * DAY).sort(
		(a, b) => b.lost - a.lost || b.reruns - a.reruns || a.test - b.test,
	);
	return {
		of: "reruns",
		reruns: rows.reduce((sum, row) => sum + row.reruns, 0),
		lostMs: rows.reduce((sum, row) => sum + row.lost, 0),
		unknown: rows.reduce((sum, row) => sum + row.unknown, 0),
		items: rows
			.slice(0, input.limit)
			.map((row) => ({ ...testRow(ctx, row.test), reruns: row.reruns, lostMs: row.lost })),
	};
}

function automation(ctx: Ctx, input: Extract<StatsInput, { of: "automation" }>): StatsOf<"automation"> {
	const project = ctx.project.id;
	const cases = automationOfCases(ctx.db, project);
	const automated = automatedCases(ctx.db, project);
	const byHand = new Map(runsByHand(ctx.db, project, ctx.now - input.days * DAY).map((row) => [row.case_id, row]));
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
		backlog: backlog.slice(0, input.limit),
	};
}

function coverage(ctx: Ctx, input: Extract<StatsInput, { of: "coverage" }>): StatsOf<"coverage"> {
	const requirements = requirementCases(ctx.db, ctx.project.id);
	const listed = requirements.slice(0, input.limit);
	const outcomes = caseOutcomes(
		ctx.db,
		ctx.project.id,
		[...new Set(listed.flatMap((requirement) => requirement.cases))],
		ctx.now - input.days * DAY,
	);
	return {
		of: "coverage",
		requirements: requirements.length,
		covered: requirements.filter((requirement) => requirement.cases.length > 0).length,
		items: listed.map((requirement) => {
			const counts = { passed: 0, failed: 0, other: 0, notRun: 0 };
			for (const id of requirement.cases) counts[outcomes.get(id) ?? "notRun"] += 1;
			return { key: requirement.key, title: requirement.title, cases: requirement.cases.length, ...counts };
		}),
	};
}

export function stats(ctx: Ctx, input: StatsInput): StatsReply {
	switch (input.of) {
		case "pass-rate":
			return passRate(ctx, input);
		case "flaky":
			return flaky(ctx, input);
		case "reruns":
			return reruns(ctx, input);
		case "automation":
			return automation(ctx, input);
		case "coverage":
			return coverage(ctx, input);
	}
}

export const statsOp = defineOp({
	name: "stats",
	output: REPLIES.stats,
	summary:
		"Reports over the last days: pass rate per day, flaky tests, time lost to reruns, automation and its backlog, coverage by requirement.",
	input: StatsInput,
	needs: "read",
	scope: "project",
	effect: "read",
	// The agent tools are at their token budget (decision 0087); an agent reads these over HTTP or the CLI.
	mcp: null,
	run: stats,
});
