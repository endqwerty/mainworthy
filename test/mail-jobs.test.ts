import { afterEach, expect, spyOn, test } from "bun:test";
import { queueMail, waitMail } from "../src/server/identity/identity.ts";
import { type App, openApp } from "../src/server/kernel/app.ts";
import { JOB_LEASE_MS, type Job, jobBackoff, jobById, runJob } from "../src/server/kernel/jobs.ts";
import { executeMail } from "../src/server/kernel/smtp.ts";
import { jobOp } from "../src/server/ops/jobs.ts";
import { invokeService } from "../src/server/ops/registry.ts";
import { exportArchive } from "../src/server/transfer/transfer.ts";
import { type Harness, harness } from "./helpers.ts";
import { fakeSmtp } from "./mail-support.ts";

let h: Harness;
let peer: App | undefined;
let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
afterEach(async () => {
	await peer?.close();
	peer = undefined;
	await h?.close();
	await smtp?.close();
});
async function setup(reject = false) {
	h = await harness();
	smtp = await fakeSmtp({ reject });
	h.app.config.mail = { host: "127.0.0.1", port: smtp.port, tls: "none", from: "mainworthy@example.com" };
}
async function queue(subject = "private subject") {
	await h.app.database.write((db) =>
		db.transaction(async () => {
			queueMail(h.app, db, {
				to: "robin@example.com",
				subject,
				text: "private link: https://example.com/reset#one-use-secret",
			});
		}),
	);
	const [row] = await h.app.database.read((db) =>
		db.allDynamic<Job>("SELECT * FROM background_jobs WHERE kind='mail' ORDER BY accepted_at,id DESC"),
	);
	if (!row) throw new Error("missing queued mail job");
	return row.id;
}
const run = (app: App, id: string) => invokeService(app, jobOp, { do: "run", id });
test("two runners on one database deliver a transactional message once", async () => {
	await setup();
	const id = await queue();
	expect(smtp.commands).toEqual([]);
	peer = await openApp(h.app.config, { memory: true, now: h.app.now });
	const replies = await Promise.all([run(h.app, id), run(peer, id)]);
	expect(replies).toContainEqual({ ok: true, result: { ran: 1 }, seq: null });
	expect(replies).toContainEqual({ ok: true, result: { ran: 0 }, seq: null });
	expect(smtp.messages).toHaveLength(1);
	expect(smtp.messages[0]?.text).toContain("one-use-secret");
	const job = await h.app.database.read((db) => jobById(db, id));
	expect(job).toMatchObject({ state: "succeeded", attempts: 1, input: "null" });
	const archive: string[] = [];
	await h.app.database.read((db) => exportArchive(db, (line) => archive.push(line)));
	expect(archive.join("")).not.toContain("one-use-secret");
	expect(archive.join("")).not.toContain("private subject");
});
test("rollback, savepoint rollback and a failed before-commit write send nothing", async () => {
	await setup();
	const message = { to: "robin@example.com", subject: "discarded", text: "must not send" };
	await expect(
		h.app.database.write((db) =>
			db.transaction(async () => {
				queueMail(h.app, db, message);
				throw new Error("rollback");
			}),
		),
	).rejects.toThrow("rollback");
	await h.app.database.write((db) =>
		db.transaction(async () => {
			await expect(
				db.savepoint(async () => {
					queueMail(h.app, db, message);
					throw new Error("savepoint");
				}),
			).rejects.toThrow("savepoint");
		}),
	);
	await expect(
		h.app.database.write((db) =>
			db.transaction(async () => {
				queueMail(h.app, db, message);
				db.beforeCommit(() => {
					throw new Error("before commit failed");
				});
			}),
		),
	).rejects.toThrow("before commit failed");
	await waitMail(h.app);
	expect(smtp.commands).toEqual([]);
	expect(await h.app.database.read((db) => db.allDynamic("SELECT id FROM background_jobs WHERE kind='mail'"))).toEqual(
		[],
	);
});
test("a failed SMTP attempt backs off, retries within its bound and then drops the private payload", async () => {
	await setup(true);
	const id = await queue();
	const warning = spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		const initial = await h.app.database.read((db) => jobById(db, id));
		if (!initial) throw new Error("missing mail");
		for (let attempt = 1; attempt <= initial.max_attempts; attempt++) {
			expect(await run(h.app, id)).toMatchObject({ ok: true, result: { ran: 1 } });
			const job = await h.app.database.read((db) => jobById(db, id));
			expect(job?.attempts).toBe(attempt);
			expect(job?.state).toBe(attempt === initial.max_attempts ? "failed" : "ready");
			expect(await run(h.app, id)).toMatchObject({ ok: true, result: { ran: 0 } });
			h.advance(jobBackoff(attempt));
		}
		expect(smtp.commands.filter((line) => line.startsWith("MAIL FROM"))).toHaveLength(initial.max_attempts);
		expect(smtp.messages).toEqual([]);
		expect((await h.app.database.read((db) => jobById(db, id)))?.input).toBe("null");
		h.advance(365 * 86_400_000);
		expect(await run(h.app, id)).toMatchObject({ ok: true, result: { ran: 0 } });
	} finally {
		warning.mockRestore();
	}
});
test("a lost completion retries mail at least once with the same Message-ID", async () => {
	await setup();
	const id = await queue();
	await runJob(
		h.app,
		"lost-response",
		async (claim, input) => {
			await executeMail(h.app, claim, input);
			h.advance(JOB_LEASE_MS);
		},
		id,
	);
	expect(smtp.messages).toHaveLength(1);
	expect(await run(h.app, id)).toMatchObject({ ok: true, result: { ran: 1 } });
	expect(smtp.messages).toHaveLength(2);
	const ids = smtp.messages.map((message) => /^Message-ID: (.+)$/m.exec(message.raw)?.[1]);
	expect(ids[0]).toBeTruthy();
	expect(ids[1]).toBe(ids[0]);
	expect((await h.app.database.read((db) => jobById(db, id)))?.input).toBe("null");
});
test("concurrent deliveries have separate SMTP reply buffers and recipients", async () => {
	await setup();
	await h.app.database.write((db) =>
		db.transaction(async () => {
			queueMail(h.app, db, { to: "first@example.com", subject: "one", text: "first body" });
			queueMail(h.app, db, { to: "second@example.com", subject: "two", text: "second body" });
		}),
	);
	const rows = await h.app.database.read((db) =>
		db.allDynamic<{ id: string }>("SELECT id FROM background_jobs WHERE kind='mail'"),
	);
	peer = await openApp(h.app.config, { memory: true, now: h.app.now });
	await Promise.all(rows.map((row, i) => run(i === 0 ? h.app : (peer ?? h.app), row.id)));
	expect(smtp.messages.map((message) => [message.to, message.text]).sort()).toEqual([
		["<first@example.com>", "first body"],
		["<second@example.com>", "second body"],
	]);
});
