import { afterEach, expect, spyOn, test } from "bun:test";
import { queueMail, requestReset, resetPassword, waitMail } from "../src/server/identity/identity.ts";
import { type App, defaultConfig, openApp } from "../src/server/kernel/app.ts";
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
	h.app.config.jobKey = Buffer.alloc(32, 7).toString("base64");
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
		db.allDynamic<Job>("SELECT * FROM background_jobs WHERE kind='mail' ORDER BY queue_order DESC"),
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

test.each(["statement failure", "connection loss"])(
	"a %s between reset issuance and mail enqueue rolls both back and preserves the prior link",
	async (fault) => {
		await setup();
		h.app.config.publicUrl = "https://example.com";
		await h.app.database.write((db) =>
			db.transaction(() =>
				db.runDynamic(
					"INSERT INTO mail_contacts(actor,email,verified_at,revision) VALUES ($1,'robin@example.com',$2,'verified-contact')",
					[h.owner.id, h.app.now()],
				),
			),
		);
		await requestReset(h.app, "robin@example.com", null);
		await waitMail(h.app);
		const previous = /\/reset#([A-Za-z0-9_-]{43})/.exec(smtp.messages[0]?.text ?? "")?.[1];
		if (!previous) throw new Error("missing previous reset link");
		const before = await h.app.database.read((db) =>
			db.allDynamic("SELECT key,payload FROM identity_ceremonies WHERE kind='mail' ORDER BY key"),
		);
		await h.app.database.write((db) =>
			db.transaction(() =>
				db.exec(`
		CREATE FUNCTION fail_reset_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NEW.kind = 'mail' THEN ${fault === "connection loss" ? "PERFORM pg_terminate_backend(pg_backend_pid());" : "RAISE EXCEPTION 'simulated mail enqueue crash';"} END IF;
		RETURN NEW; END $$;
		CREATE TRIGGER fail_reset_mail BEFORE INSERT ON background_jobs FOR EACH ROW EXECUTE FUNCTION fail_reset_mail();
	`),
			),
		);
		try {
			await expect(requestReset(h.app, "robin@example.com", null)).rejects.toThrow();
			await waitMail(h.app);
			expect(smtp.messages).toHaveLength(1);
			expect(
				await h.app.database.read((db) =>
					db.allDynamic("SELECT key,payload FROM identity_ceremonies WHERE kind='mail' ORDER BY key"),
				),
			).toEqual(before);
			expect(
				await h.app.database.read((db) => db.allDynamic("SELECT state FROM background_jobs WHERE kind='mail'")),
			).toEqual([{ state: "succeeded" }]);
		} finally {
			await h.app.database.write((db) =>
				db.transaction(() =>
					db.exec("DROP TRIGGER fail_reset_mail ON background_jobs; DROP FUNCTION fail_reset_mail()"),
				),
			);
		}
		peer = await openApp(h.app.config, { memory: true, now: h.app.now });
		expect(
			await resetPassword(peer, {
				code: previous,
				password: "a sufficiently long replacement password",
				address: null,
			}),
		).toBe("changed");
		await waitMail(peer);
		const sent = smtp.messages.length;
		await requestReset(h.app, "robin@example.com", null);
		expect(
			await h.app.database.read((db) =>
				db.allDynamic("SELECT state FROM background_jobs WHERE kind='mail' AND state='ready'"),
			),
		).toEqual([{ state: "ready" }]);
		await waitMail(peer);
		expect(smtp.messages).toHaveLength(sent + 1);
		const retry = /\/reset#([A-Za-z0-9_-]{43})/.exec(smtp.messages.at(-1)?.text ?? "")?.[1];
		if (!retry) throw new Error("missing retried reset link");
		expect(
			await resetPassword(peer, {
				code: retry,
				password: "another sufficiently long replacement password",
				address: null,
			}),
		).toBe("changed");
	},
);

test("anonymous reset issuance completes while an identity writer holds its lock", async () => {
	await setup();
	h.app.config.publicUrl = "https://example.com";
	await h.app.database.write((db) =>
		db.transaction(() =>
			db.runDynamic(
				"INSERT INTO mail_contacts(actor,email,verified_at,revision) VALUES ($1,'robin@example.com',$2,'verified-contact')",
				[h.owner.id, h.app.now()],
			),
		),
	);
	const { lockIdentity } = await import("../src/server/identity/identity.ts");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const holding = h.app.database.write((db) =>
		db.transaction(async () => {
			await lockIdentity(db);
			entered.resolve();
			await release.promise;
		}),
	);
	await entered.promise;
	const reset = requestReset(h.app, "robin@example.com", null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		expect(
			await Promise.race([
				reset,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("reset waited for an identity writer")), 1000);
				}),
			]),
		).toBeNull();
	} finally {
		clearTimeout(timer);
		release.resolve();
		await Promise.all([holding, reset]);
	}
	await waitMail(h.app);
	expect(smtp.messages).toHaveLength(1);
});

test("a queued reset job never stores the usable link token", async () => {
	await setup();
	h.app.config.publicUrl = "https://example.com";
	await h.app.database.write((db) =>
		db.transaction(() =>
			db.runDynamic(
				"INSERT INTO mail_contacts(actor,email,verified_at,revision) VALUES ($1,'robin@example.com',$2,'verified-contact')",
				[h.owner.id, h.app.now()],
			),
		),
	);
	await requestReset(h.app, "robin@example.com", null);
	const queued = await h.app.database.read((db) =>
		db.allDynamic<Job>("SELECT * FROM background_jobs WHERE kind='mail'"),
	);
	expect(queued).toHaveLength(1);
	peer = await openApp(h.app.config, { memory: true, now: h.app.now });
	await waitMail(peer);
	const token = /\/reset#([A-Za-z0-9_-]{43})/.exec(smtp.messages[0]?.text ?? "")?.[1];
	if (!token) throw new Error("missing reset link");
	expect(JSON.stringify(queued)).not.toContain(token);
	expect(
		await resetPassword(peer, { code: token, password: "a sufficiently long replacement password", address: null }),
	).toBe("changed");
});

test("private mail without a key rolls reset issuance back", async () => {
	await setup();
	h.app.config.publicUrl = "https://example.com";
	await h.app.database.write((db) =>
		db.transaction(() =>
			db.runDynamic(
				"INSERT INTO mail_contacts(actor,email,verified_at,revision) VALUES ($1,'robin@example.com',$2,'verified-contact')",
				[h.owner.id, h.app.now()],
			),
		),
	);
	await requestReset(h.app, "robin@example.com", null);
	const before = await h.app.database.read((db) =>
		db.allDynamic("SELECT * FROM identity_ceremonies WHERE kind='mail'"),
	);
	h.app.config.jobKey = undefined;
	await expect(requestReset(h.app, "robin@example.com", null)).rejects.toThrow("MAINWORTHY_JOB_KEY is required");
	expect(
		await h.app.database.read((db) => db.allDynamic("SELECT * FROM identity_ceremonies WHERE kind='mail'")),
	).toEqual(before);
	expect(
		await h.app.database.read((db) => db.allDynamic("SELECT id FROM background_jobs WHERE kind='mail'")),
	).toHaveLength(1);
	expect(smtp.commands).toEqual([]);
});

test("job key configuration rejects malformed values without repeating them", () => {
	for (const key of [
		"private-invalid-value",
		Buffer.alloc(31).toString("base64"),
		Buffer.alloc(33).toString("base64"),
		"!".repeat(44),
	]) {
		let error: unknown;
		try {
			defaultConfig({ MAINWORTHY_JOB_KEY: key });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain("MAINWORTHY_JOB_KEY");
		expect(String(error)).not.toContain(key);
	}
	expect(defaultConfig({ MAINWORTHY_JOB_KEY: "" }).jobKey).toBeUndefined();
});

test("each private job gets a fresh nonce and retry rows keep no usable token", async () => {
	await setup(true);
	const first = await queue();
	const second = await queue();
	const rows = await h.app.database.read((db) => db.allDynamic<Job>("SELECT * FROM background_jobs WHERE kind='mail'"));
	expect(rows[0]?.input).not.toBe(rows[1]?.input);
	expect(JSON.stringify(rows)).not.toContain("one-use-secret");
	const warning = spyOn(console, "warn").mockImplementation(() => undefined);
	const error = spyOn(console, "error").mockImplementation(() => undefined);
	try {
		await run(h.app, first);
		expect(await h.app.database.read((db) => jobById(db, first))).toMatchObject({ state: "ready", attempts: 1 });
		expect(JSON.stringify(await h.app.database.read((db) => jobById(db, first)))).not.toContain("one-use-secret");
		expect(await h.app.database.read((db) => jobById(db, second))).toMatchObject({ state: "ready", attempts: 0 });
	} finally {
		warning.mockRestore();
		error.mockRestore();
	}
});

test.each(["key", "missing key", "ciphertext", "nonce", "id", "kind", "plaintext"])(
	"private job authentication rejects changed %s before SMTP",
	async (fault) => {
		await setup();
		let id = await queue();
		const originalKey = h.app.config.jobKey;
		if (fault === "key") h.app.config.jobKey = Buffer.alloc(32, 8).toString("base64");
		if (fault === "missing key") h.app.config.jobKey = undefined;
		if (fault === "ciphertext" || fault === "nonce" || fault === "plaintext") {
			const row = await h.app.database.read((db) => jobById(db, id));
			if (!row) throw new Error("missing job");
			const input =
				fault === "plaintext"
					? JSON.stringify({ to: "robin@example.com", subject: "unsafe", text: "one-use-secret" })
					: row.input.replace(
							fault === "nonce" ? /("nonce":")[A-Za-z0-9+/]/ : /("ciphertext":")[A-Za-z0-9+/]/,
							(match, prefix: string) => `${prefix}${match.endsWith("A") ? "B" : "A"}`,
						);
			await h.app.database.write((db) =>
				db.transaction(() => db.runDynamic("UPDATE background_jobs SET input=$1 WHERE id=$2", [input, id])),
			);
		}
		if (fault === "id") {
			await h.app.database.write((db) =>
				db.transaction(() => db.runDynamic("UPDATE background_jobs SET id=$1 WHERE id=$2", ["substituted", id])),
			);
			id = "substituted";
		}
		if (fault === "kind")
			await h.app.database.write((db) =>
				db.transaction(() => db.runDynamic("UPDATE background_jobs SET kind='substituted' WHERE id=$1", [id])),
			);
		const error = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await runJob(h.app, "authentication-probe", (claim, input) => executeMail(h.app, claim, input), id);
			expect(smtp.commands).toEqual([]);
			const row = await h.app.database.read((db) => jobById(db, id));
			expect(row).toMatchObject({ state: "ready", attempts: 1 });
			expect(row?.error).toContain("Private job input could not be decrypted; check MAINWORTHY_JOB_KEY");
			if (fault === "key" || fault === "missing key") {
				h.app.config.jobKey = originalKey;
				h.advance(jobBackoff(1));
				await run(h.app, id);
				expect(smtp.messages).toHaveLength(1);
				expect((await h.app.database.read((db) => jobById(db, id)))?.input).toBe("null");
			}
		} finally {
			error.mockRestore();
		}
	},
);
