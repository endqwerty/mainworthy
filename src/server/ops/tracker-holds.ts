import { z } from "zod";
import { TrackerItem } from "../../core/tracker.ts";
import { endDefectHold } from "../decisions/decisions.ts";
import { liveDefectDecisions, questionById, questionRef, refsOf } from "../decisions/questions.ts";
import { lockActors, ruleActor } from "../identity/identity.ts";
import type { App } from "../kernel/app.ts";
import { allProjects, lockProject, makeCtx, stampSeq } from "../kernel/ctx.ts";
import { json } from "../kernel/db.ts";
import { configuredTrackers } from "../trackers/config.ts";
import { finishTrackerPoll, trackerPoll, trackerPollError } from "../trackers/polls.ts";
import { TrackerError, type TrackerPort, type TrackerReadFailure } from "../trackers/port.ts";

const Defect = z.object({ is: z.literal("defect"), ref: z.string() });
const active = new WeakMap<App, Promise<number>>();
const stopping = new WeakSet<App>();

export function pollDefectHolds(app: App, supplied?: TrackerPort): Promise<number> {
	const running = active.get(app);
	if (running !== undefined) return running;
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
	const candidates = (
		await Array.fromAsync(await app.database.read((db) => allProjects(db)), async (project) =>
			app.database.write((db) =>
				db.transaction(async () => {
					await lockProject(db, project.id);
					if (stopping.has(app)) return [];
					const candidates = [];
					const trackers = configuredTrackers(app.config, project.key);
					if (trackers.length === 0) return [];
					for (const decision of await liveDefectDecisions(db, project.id)) {
						const answer = Defect.safeParse(json<unknown>(decision.answer));
						if (!answer.success) continue;
						for (const tracker of trackers) {
							const key = tracker.keyOf(answer.data.ref);
							if (!key) continue;
							const schedule = await trackerPoll(db, decision.id);
							const identity = JSON.stringify([project.id, tracker.destination, key]);
							const failures = failedIssues.get(identity) ?? new Set<number>();
							if (schedule.diagnosed) failures.add(decision.id);
							failedIssues.set(identity, failures);
							candidates.push({ decision, ref: answer.data.ref, project, tracker, key, schedule, failures });
							break;
						}
					}
					return candidates;
				}),
			),
		)
	)
		.flat()
		.filter((candidate) => candidate.schedule.next_at <= app.now())
		.sort((a, b) => a.schedule.next_at - b.schedule.next_at || a.decision.id - b.decision.id)
		.slice(0, 20);
	let ended = 0;
	for (const candidate of candidates) {
		const { decision, ref, project, tracker, key, schedule, failures } = candidate;
		const currentTracker = await app.database.read(async (db) => {
			if (stopping.has(app)) return null;
			const current = (await liveDefectDecisions(db, project.id)).find((row) => row.id === decision.id);
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
		const completion = await app.database.write(
			async (db) =>
				await db.transaction(async () => {
					await lockActors(db, [(await ruleActor(db)).id]);
					const currentProject = await lockProject(db, project.id);
					if (!currentProject || currentProject.key !== project.key) return null;
					if (!configuredTrackers(app.config, project.key).some((row) => row.destination === tracker.destination))
						return null;
					const current = (await liveDefectDecisions(db, project.id)).find((row) => row.id === decision.id);
					if (!current || current.answer !== decision.answer) return null;
					const before = await trackerPollError(db, decision.id);
					if (!(await finishTrackerPoll(db, schedule, app.now(), failure))) return null;
					const diagnostic = await trackerPollError(db, decision.id);
					const warning = diagnostic && failures.size === 0 ? diagnostic : null;
					if (diagnostic === before && !closed) return { warning, ended: false };
					const ctx = makeCtx(app, db, currentProject, await ruleActor(db), true);
					const ended = closed && (await endDefectHold(ctx, decision, ref));
					const question = await questionById(db, decision.question);
					if (question) {
						ctx.touched.add(questionRef(question));
						for (const about of await refsOf(db, question.id)) ctx.touched.add(about);
					}
					await stampSeq(ctx);
					await app.recordChange(db, {
						project: project.key,
						seq: ctx.seq,
						op: ended ? "tracker-closed" : "tracker-poll",
						actor: ctx.actor.name,
						touched: [...ctx.touched],
					});
					return { warning, ended };
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
			if (completion.ended) ended++;
		}
	}
	return ended;
}
