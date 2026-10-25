import { randomUUID } from "node:crypto";
import type { App } from "../kernel/app.ts";
import type { WriteDb } from "../kernel/db.ts";
import { invalid } from "../kernel/errors.ts";
import { enqueueJob, jobsPending, kindJobsStopped, runKindJobs, stopKindJobs, waitKindJobs } from "../kernel/jobs.ts";
import { executeMail, type MailMessage } from "../kernel/smtp.ts";
import { publicAddress } from "./people.ts";

type Message = MailMessage;
const enqueues = new WeakMap<App, Set<Promise<void>>>();
function track(app: App, work: Promise<void>): void {
	const pending = enqueues.get(app) ?? new Set<Promise<void>>();
	enqueues.set(app, pending);
	pending.add(work);
	void work.finally(() => pending.delete(work)).catch(() => undefined);
}
export function requireMail(app: App): string {
	const url = publicAddress(app.config)?.url;
	if (!app.config.mail || !url) throw invalid("mail is off on this instance");
	return url;
}
async function enqueue(app: App, db: WriteDb, message: Message, key: string): Promise<void> {
	await enqueueJob(db, { kind: "mail", key, input: message, actor: null, acceptedAt: app.now(), privateInput: true });
}
/** The synchronous caller registers a write that COMMIT awaits on this very transaction. */
export function queueMail(app: App, db: WriteDb, message: Message): void {
	if (!app.config.mail) return;
	const key = randomUUID();
	db.beforeCommit(() => enqueue(app, db, message, key));
}
/** Anonymous reset requests have no domain writer. Their enqueue is an independent job transaction. */
export function deliverMail(app: App, message: Message): void {
	if (!app.config.mail) return;
	const work = app.database
		.jobWrite((db) => db.transaction(() => enqueue(app, db, message, randomUUID())))
		.catch(() => {
			console.warn("[mainworthy] mail enqueue failed; check database connectivity and request a new link");
		});
	track(app, work);
}
export function deliverQueuedMail(app: App): Promise<number> {
	return runKindJobs(app, "mail", (claim, input) => executeMail(app, claim, input));
}
export async function waitMail(app: App): Promise<void> {
	await Promise.allSettled(enqueues.get(app) ?? []);
	while (!kindJobsStopped(app, "mail")) {
		await deliverQueuedMail(app);
		if (!(await app.database.read((db) => jobsPending(db, "mail", app.now())))) break;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	await waitKindJobs(app, "mail");
}
export function stopMail(app: App): void {
	stopKindJobs(app, "mail");
}
