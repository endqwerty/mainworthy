import { z } from "zod";
import { TrackerItem } from "../core/tracker.ts";
import { endDefectHold } from "./decisions/decisions.ts";
import { liveDefectDecisions, questionById, questionRef, refsOf } from "./decisions/questions.ts";
import { ruleActor } from "./identity/identity.ts";
import type { App } from "./kernel/app.ts";
import { allProjects, makeCtx, projectById, stampSeq } from "./kernel/ctx.ts";
import { json } from "./kernel/db.ts";
import { configuredTrackers } from "./trackers/config.ts";
import { finishTrackerPoll, trackerPoll, trackerPollError } from "./trackers/polls.ts";
import { TrackerError, type TrackerPort, type TrackerReadFailure } from "./trackers/port.ts";

const Defect = z.object({ is: z.literal("defect"), ref: z.string() });
const active = new WeakMap<App, Promise<number>>();
const stopping = new WeakSet<App>();

export function pollDefectHolds(app: App, supplied?: TrackerPort): Promise<number> {
	const running = active.get(app);
	if (running) return running;
	if (stopping.has(app)) return Promise.resolve(0);
	const work = poll(app, supplied).finally(() => active.delete(app));
	active.set(app, work);
	return work;
}

export function stopTrackerPolls(app: App): void {
	stopping.add(app);
}

export async function waitTrackerPolls(app: App): Promise<void> {
	await active.get(app)?.catch(() => undefined);
}

async function poll(app: App, supplied?: TrackerPort): Promise<number> {
	const failedIssues = new Map<string, Set<number>>();
	const candidates = await app.gate.run(() => {
		if (stopping.has(app)) return [];
		return allProjects(app.db)
			.flatMap((project) => {
				const trackers = configuredTrackers(app.config, project.key);
				if (trackers.length === 0) return [];
				return liveDefectDecisions(app.db, project.id).flatMap((decision) => {
					const answer = Defect.safeParse(json<unknown>(decision.answer));
					if (!answer.success) return [];
					for (const tracker of trackers) {
						const key = tracker.keyOf(answer.data.ref);
						if (!key) continue;
						const schedule = trackerPoll(app.db, decision.id);
						const identity = JSON.stringify([project.id, tracker.destination, key]);
						const failures = failedIssues.get(identity) ?? new Set<number>();
						if (schedule.diagnosed) failures.add(decision.id);
						failedIssues.set(identity, failures);
						return [{ decision, ref: answer.data.ref, project, tracker, key, schedule, failures }];
					}
					return [];
				});
			})
			.filter((candidate) => candidate.schedule.next_at <= app.now())
			.sort((a, b) => a.schedule.next_at - b.schedule.next_at || a.decision.id - b.decision.id)
			.slice(0, 20);
	});
	let ended = 0;
	for (const candidate of candidates) {
		const { decision, ref, project, tracker, key, schedule, failures } = candidate;
		const currentTracker = await app.gate.run(() => {
			if (stopping.has(app)) return null;
			const current = liveDefectDecisions(app.db, project.id).find((row) => row.id === decision.id);
			if (!current || current.answer !== decision.answer) return null;
			return configuredTrackers(app.config, project.key).find((row) => row.destination === tracker.destination) ?? null;
		});
		if (!currentTracker) continue;
		let issue: TrackerItem | null = null;
		let failure: TrackerReadFailure | null = null;
		try {
			issue = TrackerItem.parse(await (supplied ?? currentTracker.port()).getItem(key));
			if (tracker.keyOf(issue.ref) !== key || tracker.keyOf(issue.url) !== key) {
				issue = null;
				failure = "moved";
			}
		} catch (error) {
			issue = null;
			failure = error instanceof TrackerError ? error.readFailure : "unreadable";
		}
		const closed = issue?.state === "closed";
		const completion = await app.gate.run(() =>
			app.db.transaction(() => {
				const currentProject = projectById(app.db, project.id);
				if (!currentProject || currentProject.key !== project.key) return null;
				if (!configuredTrackers(app.config, project.key).some((row) => row.destination === tracker.destination))
					return null;
				const current = liveDefectDecisions(app.db, project.id).find((row) => row.id === decision.id);
				if (!current || current.answer !== decision.answer) return null;
				const before = trackerPollError(app.db, decision.id);
				if (!finishTrackerPoll(app.db, schedule, app.now(), failure)) return null;
				const diagnostic = trackerPollError(app.db, decision.id);
				const warning = diagnostic && failures.size === 0 ? diagnostic : null;
				if (diagnostic === before && !closed) return { warning, event: null, ended: false };
				const ctx = makeCtx(app, currentProject, ruleActor(app.db), true);
				const ended = closed && endDefectHold(ctx, decision, ref);
				const question = questionById(app.db, decision.question);
				if (question) {
					ctx.touched.add(questionRef(question));
					for (const about of refsOf(app.db, question.id)) ctx.touched.add(about);
				}
				stampSeq(ctx);
				return {
					warning,
					ended,
					event: {
						project: project.key,
						seq: ctx.seq,
						op: ended ? "tracker-closed" : "tracker-poll",
						actor: ctx.actor.name,
						touched: [...ctx.touched],
					},
				};
			}),
		);
		if (completion) {
			if (failure === null) failures.delete(decision.id);
			else failures.add(decision.id);
			if (completion.warning)
				console.warn("[mainworthy] tracker issue could not be read:", {
					project: project.key,
					issue: key,
					diagnostic: completion.warning,
				});
			if (completion.event) app.publish(completion.event);
			if (completion.ended) ended++;
		}
	}
	return ended;
}
