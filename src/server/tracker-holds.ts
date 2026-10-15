import { z } from "zod";
import { TrackerItem } from "../core/tracker.ts";
import { endDefectHold } from "./decisions/decisions.ts";
import { liveDefectDecisions } from "./decisions/questions.ts";
import { ruleActor } from "./identity/identity.ts";
import type { App } from "./kernel/app.ts";
import { allProjects, makeCtx, projectById, stampSeq } from "./kernel/ctx.ts";
import { json } from "./kernel/db.ts";
import { configuredTrackers } from "./trackers/config.ts";
import { finishTrackerPoll, trackerPoll } from "./trackers/polls.ts";
import type { TrackerPort } from "./trackers/port.ts";

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
						return [{ decision, ref: answer.data.ref, project, tracker, key, schedule }];
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
		const { decision, ref, project, tracker, key, schedule } = candidate;
		const currentTracker = await app.gate.run(() => {
			if (stopping.has(app)) return null;
			const current = liveDefectDecisions(app.db, project.id).find((row) => row.id === decision.id);
			if (!current || current.answer !== decision.answer) return null;
			return configuredTrackers(app.config, project.key).find((row) => row.destination === tracker.destination) ?? null;
		});
		if (!currentTracker) continue;
		let issue: TrackerItem | null = null;
		try {
			issue = TrackerItem.parse(await (supplied ?? currentTracker.port()).getItem(key));
			if (tracker.keyOf(issue.ref) !== key || tracker.keyOf(issue.url) !== key) issue = null;
		} catch {
			issue = null;
		}
		const closed = issue?.state === "closed";
		const event = await app.gate.run(() =>
			app.db.transaction(() => {
				const currentProject = projectById(app.db, project.id);
				if (!currentProject || currentProject.key !== project.key) return null;
				if (!configuredTrackers(app.config, project.key).some((row) => row.destination === tracker.destination))
					return null;
				if (!finishTrackerPoll(app.db, schedule, app.now(), issue === null) || !closed) return null;
				const ctx = makeCtx(app, currentProject, ruleActor(app.db), true);
				if (!endDefectHold(ctx, decision, ref)) return null;
				stampSeq(ctx);
				return {
					project: project.key,
					seq: ctx.seq,
					op: "tracker-closed",
					actor: ctx.actor.name,
					touched: [...ctx.touched],
				};
			}),
		);
		if (event) {
			app.publish(event);
			ended++;
		}
	}
	return ended;
}
