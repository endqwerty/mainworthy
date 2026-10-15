import { afterEach, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { clearChallenges, queueMail, waitMail } from "../src/server/identity/identity.ts";
import type { RegistrationOptions } from "../src/server/identity/webauthn.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { ARCHIVE_VERSION } from "../src/server/kernel/migrate.ts";
import { fakeSmtp } from "./mail-support.ts";
import {
	authenticator,
	bearer,
	cleanUp,
	from,
	holdGate,
	invite,
	joined,
	must,
	OWNER,
	PUBLIC,
	scratch,
	signIn,
	TOKEN,
	type World,
	waitingAtGate,
	world,
} from "./people-support.ts";

afterEach(cleanUp);

const PASSWORD = "a quite long first password";
const NEXT = "a quite different password";
async function mailbox(options: Parameters<typeof fakeSmtp>[0] = {}) {
	const smtp = await fakeSmtp(options);
	const w = world({ proxied: true });
	w.instance.app.config.mail = defaultConfig({
		MAINWORTHY_SMTP_HOST: "127.0.0.1",
		MAINWORTHY_SMTP_PORT: String(smtp.port),
		MAINWORTHY_SMTP_TLS: "none",
		MAINWORTHY_SMTP_USER: "smtp-user",
		MAINWORTHY_SMTP_PASSWORD: "smtp-password-private",
		MAINWORTHY_MAIL_FROM: "mainworthy@example.com",
		MAINWORTHY_PUBLIC_URL: PUBLIC,
	}).mail;
	return { ...smtp, w };
}
const contactInput = (email: string | null) => ({ do: "email.set", actor: "robin", email });
function linkCode(text: string, purpose: "email" | "reset"): string {
	const code = new RegExp(`/${purpose}#([A-Za-z0-9_-]{43})`).exec(text)?.[1];
	if (!code) throw new Error(`No ${purpose} link in mail`);
	return code;
}
async function verified(w: World, messages: { text: string }[]) {
	const cookie = await joined(w, "robin", PASSWORD);
	expect((await w.op("credential", contactInput("robin@example.com"))).status).toBe(200);
	await waitMail(w.instance.app);
	const code = linkCode(messages.at(-1)?.text ?? "", "email");
	expect((await w.post("/api/login", { emailVerification: code })).status).toBe(200);
	return { cookie, code };
}

test("SMTP configuration is process-only, optional, and refuses incomplete settings without repeating values", () => {
	expect(defaultConfig({}).mail).toBeUndefined();
	for (const env of [
		{ MAINWORTHY_SMTP_PASSWORD: "must-not-appear" },
		{ MAINWORTHY_SMTP_HOST: "smtp.example.com", MAINWORTHY_MAIL_FROM: "sender@example.com" },
		{
			MAINWORTHY_SMTP_HOST: "must-not-appear\r\n",
			MAINWORTHY_MAIL_FROM: "sender@example.com",
			MAINWORTHY_PUBLIC_URL: PUBLIC,
		},
	]) {
		let message = "";
		try {
			defaultConfig(env);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("MAINWORTHY_");
		expect(message).not.toContain("must-not-appear");
	}
});

test("an invitation is mailed to one address with its existing single-use link and expiry", async () => {
	const box = await mailbox();
	try {
		const made = await invite(box.w, { name: "mailed", email: "MAILED@example.com", expires: "12h" });
		await waitMail(box.w.instance.app);
		expect(box.messages).toHaveLength(1);
		expect(box.messages[0]?.to).toBe("<mailed@example.com>");
		expect(box.messages[0]?.text).toContain(made.link);
		expect(box.messages[0]?.text).toContain(new Date(made.expiresAt).toISOString());
		expect(made.expiresAt).toBe(box.w.clock.now() + 12 * 3_600_000);
		expect(box.commands.some((line) => line.startsWith("AUTH PLAIN "))).toBe(true);
		expect((await box.w.post("/api/login", { invitation: made.code, password: PASSWORD })).status).toBe(200);
		expect((await box.w.post("/api/login", { invitation: made.code, password: PASSWORD })).status).toBe(401);
		expect(box.w.disk().includes(Buffer.from("smtp-password-private"))).toBe(false);
		expect(box.w.replies.join("\n")).not.toContain("smtp-password-private");
	} finally {
		await box.close();
	}
});

test("reset needs verified ownership, gives the same answer for every address, and ends sessions once", async () => {
	const box = await mailbox();
	const w = box.w;
	try {
		const cookie = await joined(w, "robin", PASSWORD);
		const unknown = await w.post("/api/login", { resetRequest: "unknown@example.com" });
		expect((await w.op("credential", contactInput("robin@example.com"))).status).toBe(200);
		await waitMail(w.instance.app);
		const code = linkCode(box.messages[0]?.text ?? "", "email");
		const unverified = await w.post("/api/login", { resetRequest: "ROBIN@example.com" });
		await waitMail(w.instance.app);
		expect(box.messages).toHaveLength(1);
		expect(unverified.text).toBe(unknown.text);
		expect((await w.post("/api/login", { emailVerification: code })).status).toBe(200);
		expect((await w.post("/api/login", { emailVerification: code })).status).toBe(400);
		expect(
			must(await w.op<{ email: string | null; verified: boolean }>("credential", { do: "email.get", actor: "robin" })),
		).toEqual({
			email: "robin@example.com",
			verified: true,
		});
		const known = await w.post("/api/login", { resetRequest: "robin@example.com" });
		expect(known.text).toBe(unknown.text);
		expect(known.status).toBe(unknown.status);
		expect(known.setCookies).toEqual([]);
		await waitMail(w.instance.app);
		const reset = linkCode(box.messages.at(-1)?.text ?? "", "reset");
		const other = await signIn(w, "robin", PASSWORD);
		const changed = await w.post("/api/login", { reset, password: NEXT });
		expect(changed.status).toBe(200);
		expect(changed.setCookies).toEqual([]);
		expect(await w.status({ cookie })).toBe(401);
		expect(await w.status({ cookie: other.cookie })).toBe(401);
		expect((await w.post("/api/login", { reset, password: PASSWORD })).status).toBe(400);
		expect((await signIn(w, "robin", PASSWORD)).status).toBe(401);
		expect((await signIn(w, "robin", NEXT)).status).toBe(200);
		await waitMail(w.instance.app);
		expect(box.messages.at(-1)?.text).toContain("Your password was reset for robin");
	} finally {
		await box.close();
	}
});

test("reset requests count both recipient and client using the shared attempt limiter", async () => {
	const box = await mailbox();
	try {
		for (let attempt = 0; attempt < 5; attempt++)
			expect(
				(await box.w.post("/api/login", { resetRequest: "same@example.com" }, from(`192.0.2.${attempt + 1}`))).status,
			).toBe(200);
		const recipient = await box.w.post("/api/login", { resetRequest: "SAME@example.com" }, from("192.0.2.9"));
		expect(recipient.status).toBe(429);
		expect(recipient.retryAfter).toBe("1");
		for (let attempt = 0; attempt < 5; attempt++)
			expect(
				(await box.w.post("/api/login", { resetRequest: `person${attempt}@example.com` }, from("192.0.2.10"))).status,
			).toBe(200);
		expect((await box.w.post("/api/login", { resetRequest: "different@example.com" }, from("192.0.2.10"))).status).toBe(
			429,
		);
		expect((await signIn(box.w, "nobody", PASSWORD, from("192.0.2.10"))).status).toBe(429);
		box.w.clock.advance(1001);
		expect((await box.w.post("/api/login", { resetRequest: "same@example.com" }, from("192.0.2.9"))).status).toBe(200);
	} finally {
		await box.close();
	}
});

test("address replacement, password replacement, expiry and import invalidate pending links", async () => {
	const box = await mailbox();
	const w = box.w;
	try {
		const { cookie } = await verified(w, box.messages);
		await w.post("/api/login", { resetRequest: "robin@example.com" });
		await waitMail(w.instance.app);
		const first = linkCode(box.messages.at(-1)?.text ?? "", "reset");
		await w.op("credential", contactInput("new@example.com"));
		await waitMail(w.instance.app);
		expect((await w.post("/api/login", { reset: first, password: NEXT })).status).toBe(400);
		const verify = linkCode(box.messages.at(-1)?.text ?? "", "email");
		await w.post("/api/login", { emailVerification: verify });
		await w.post("/api/login", { resetRequest: "new@example.com" });
		await waitMail(w.instance.app);
		const second = linkCode(box.messages.at(-1)?.text ?? "", "reset");
		await w.post("/api/account/password", { current: PASSWORD, next: NEXT }, { cookie });
		expect((await w.post("/api/login", { reset: second, password: PASSWORD })).status).toBe(400);
		await w.post("/api/login", { resetRequest: "new@example.com" });
		await waitMail(w.instance.app);
		const expired = linkCode(box.messages.at(-1)?.text ?? "", "reset");
		w.clock.advance(15 * 60_000);
		expect((await w.post("/api/login", { reset: expired, password: PASSWORD })).status).toBe(400);
		await w.post("/api/login", { resetRequest: "new@example.com" });
		await waitMail(w.instance.app);
		const imported = linkCode(box.messages.at(-1)?.text ?? "", "reset");
		clearChallenges(w.instance.app);
		expect((await w.post("/api/login", { reset: imported, password: PASSWORD })).status).toBe(400);
	} finally {
		await box.close();
	}
});

function totp(secret: string, now: number): string {
	const binary = [...secret]
		.map((char) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char).toString(2).padStart(5, "0"))
		.join("");
	const key = Buffer.from(binary.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
	const digest = createHmac("sha1", key).update(counter).digest();
	return String((digest.readUInt32BE((digest.at(-1) ?? 0) & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
for (const grant of ["personal", "team"] as const) {
	test(`mail reset cannot give a required admin with a ${grant} grant password-only entry`, async () => {
		const box = await mailbox();
		const w = box.w;
		try {
			const { cookie } = await verified(w, box.messages);
			if (grant === "personal") {
				await w.ok("admin", { do: "grant.set", actor: "robin", project: "scratch", can: ["read", "admin"] });
			} else {
				await w.ok("admin", { do: "team.create", name: "Admins" });
				await w.ok("admin", { do: "team.member.add", team: "Admins", person: "robin" });
				await w.ok("admin", { do: "team.grant.set", team: "Admins", project: "scratch", can: ["admin"] });
			}
			w.instance.app.config.requireAdminMfa =
				defaultConfig({ MAINWORTHY_REQUIRE_ADMIN_MFA: "true" }).requireAdminMfa === true;
			await w.post("/api/login", { resetRequest: "robin@example.com" });
			await waitMail(w.instance.app);
			const reset = linkCode(box.messages.at(-1)?.text ?? "", "reset");
			const changed = await w.post("/api/login", { reset, password: NEXT });
			expect(changed.status).toBe(200);
			expect(must(changed)).toEqual({ changed: true });
			expect(changed.setCookies).toEqual([]);
			expect(await w.status({ cookie })).toBe(401);
			const refused = await signIn(w, "robin", NEXT);
			expect(refused.status).toBe(403);
			expect(refused.cookie).not.toContain("session=");
			expect(await w.status({ cookie: refused.cookie })).toBe(401);
			w.instance.app.config.requireAdminMfa = false;
			const signed = await signIn(w, "robin", NEXT);
			expect(signed.status).toBe(200);
			expect(await w.status({ cookie: signed.cookie })).toBe(200);
		} finally {
			await box.close();
		}
	});
}

test("reset retains TOTP and sign-in method changes notify a verified contact", async () => {
	const box = await mailbox();
	const w = box.w;
	try {
		const { cookie } = await verified(w, box.messages);
		const options = await w.ok<RegistrationOptions>("credential", { do: "passkey.begin" }, { cookie });
		const added = await w.ok<{ id: number }>(
			"credential",
			{ do: "passkey.add", passkey: authenticator().register(options), label: "device" },
			{ cookie },
		);
		await w.op("credential", { do: "remove", id: added.id }, { cookie });
		const enrol = await w.ok<{ secret: string; challenge: string }>("credential", { do: "totp.begin" }, { cookie });
		const confirmed = await w.ok<{ recoveryCodes: string[]; id: number }>(
			"credential",
			{ do: "totp.confirm", challenge: enrol.challenge, code: totp(enrol.secret, w.clock.now()) },
			{ cookie },
		);
		await waitMail(w.instance.app);
		expect(box.messages.map((message) => message.text).join("\n")).toContain("A passkey was added for robin");
		expect(box.messages.map((message) => message.text).join("\n")).toContain("A passkey was removed for robin");
		expect(box.messages.at(-1)?.text).toContain("An authenticator was added for robin");
		await w.post("/api/login", { resetRequest: "robin@example.com" });
		await waitMail(w.instance.app);
		const reset = linkCode(box.messages.at(-1)?.text ?? "", "reset");
		expect((await w.post("/api/login", { reset, password: NEXT })).status).toBe(200);
		const signed = await w.post("/api/login", { name: "robin", password: NEXT });
		expect(must(signed)).toMatchObject({ signedIn: false });
		expect(signed.cookie).not.toContain("session=");
		const second = z.object({ secondFactor: z.object({ challenge: z.string() }) }).parse(must(signed));
		const finished = await w.post(
			"/api/login",
			{ challenge: second.secondFactor.challenge, code: confirmed.recoveryCodes[0] },
			{ cookie: signed.cookie },
		);
		expect(finished.status).toBe(200);
		expect(await w.status({ cookie: finished.cookie })).toBe(200);
		await w.op("credential", { do: "remove", id: confirmed.id }, { cookie: finished.cookie });
		await waitMail(w.instance.app);
		expect(box.messages.at(-1)?.text).toContain("authenticator was removed for robin");
	} finally {
		await box.close();
	}
});

test("mail follows commit, discards rolled back work, and reports SMTP failure without transport text", async () => {
	const box = await mailbox({ reject: true });
	const app = box.w.instance.app;
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(() =>
			app.db.transaction(() => {
				queueMail(app, { to: "nobody@example.com", subject: "rolled back", text: "no" });
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		app.db.transaction(() => {
			try {
				app.db.savepoint(() => {
					queueMail(app, { to: "nobody@example.com", subject: "savepoint", text: "no" });
					throw new Error("rollback");
				});
			} catch {}
		});
		await waitMail(app);
		expect(box.commands).toEqual([]);
		const made = await invite(box.w, { name: "delivery-failure", email: "nobody@example.com" });
		await waitMail(app);
		expect(made.link).toContain("/invite#");
		expect(warning.mock.calls).toEqual([
			["[mainworthy] mail delivery failed; check SMTP configuration and request a new link"],
		]);
		expect((await box.w.post("/api/login", { invitation: made.code, password: PASSWORD })).status).toBe(200);
	} finally {
		warning.mockRestore();
		await box.close();
	}
});

test("STARTTLS is required when selected, and mail-disabled and unrelated callers cannot change a contact", async () => {
	const plain = world();
	expect((await plain.op("invitation", { do: "create", name: "off", email: "off@example.com" })).status).toBe(400);
	expect((await plain.post("/api/login", { resetRequest: "off@example.com" })).status).toBe(400);
	const box = await mailbox();
	const w = box.w;
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const other = await joined(w, "other", PASSWORD);
		await joined(w, "robin", PASSWORD);
		expect((await w.op("credential", contactInput("stolen@example.com"), { cookie: other })).status).toBe(403);
		expect((await w.op("credential", { do: "email.set", email: "owner@example.com" }, bearer(TOKEN))).status).toBe(403);
		const config = w.instance.app.config.mail;
		if (!config) throw new Error("Missing test mail config");
		config.tls = "starttls";
		await invite(w, { name: "tls", email: "tls@example.com" });
		await waitMail(w.instance.app);
		expect(box.commands.some((line) => line.startsWith("AUTH"))).toBe(false);
		expect(box.messages).toEqual([]);
		expect(warning.mock.calls).toHaveLength(1);
	} finally {
		warning.mockRestore();
		await box.close();
	}
});

test("a password reset rechecks its proof after waiting at the write gate", async () => {
	const box = await mailbox();
	const w = box.w;
	try {
		await verified(w, box.messages);
		await w.post("/api/login", { resetRequest: "robin@example.com" });
		await waitMail(w.instance.app);
		const reset = linkCode(box.messages.at(-1)?.text ?? "", "reset");
		const gate = holdGate(w.instance);
		await Promise.resolve();
		const waiting = waitingAtGate(w.instance, 1);
		const resetting = w.post("/api/login", { reset, password: NEXT });
		try {
			await waiting;
			clearChallenges(w.instance.app);
		} finally {
			await gate.release();
		}
		expect((await resetting).status).toBe(400);
		expect((await signIn(w, "robin", PASSWORD)).status).toBe(200);
	} finally {
		await box.close();
	}
});

test("archives preserve verified contacts and import invalidates all mail links", async () => {
	const box = await mailbox();
	const w = box.w;
	try {
		const recovery = await invite(w, { name: OWNER });
		const accepted = await w.post("/api/login", { invitation: recovery.code, password: PASSWORD });
		const cookie = accepted.cookie;
		expect((await w.op("credential", { do: "email.set", email: "owner-mail@example.com" }, { cookie })).status).toBe(
			200,
		);
		await waitMail(w.instance.app);
		const verify = linkCode(box.messages.at(-1)?.text ?? "", "email");
		expect((await w.post("/api/login", { emailVerification: verify })).status).toBe(200);
		await w.post("/api/login", { resetRequest: "owner-mail@example.com" });
		await waitMail(w.instance.app);
		const reset = linkCode(box.messages.at(-1)?.text ?? "", "reset");
		const exported = await (await fetch(`${w.instance.url}/api/export`, { headers: { cookie } })).text();
		expect(JSON.parse(exported.split("\n")[0] ?? "").schema).toBe(ARCHIVE_VERSION);
		expect(exported).toContain("owner-mail@example.com");
		expect(exported).not.toContain(reset);
		expect(exported).not.toContain(verify);
		expect(exported).not.toContain("smtp-password-private");
		expect((await w.op("credential", { do: "email.set", email: "replacement@example.com" }, { cookie })).status).toBe(
			200,
		);
		await waitMail(w.instance.app);
		const pendingVerify = linkCode(box.messages.at(-1)?.text ?? "", "email");
		const imported = await fetch(`${w.instance.url}/api/import`, {
			method: "POST",
			headers: { cookie },
			body: exported,
		});
		expect(imported.status).toBe(200);
		expect((await w.post("/api/login", { reset, password: NEXT })).status).toBe(400);
		expect((await w.post("/api/login", { emailVerification: pendingVerify })).status).toBe(400);
		expect(w.rows("SELECT email, verified_at IS NOT NULL AS verified FROM mail_contacts")).toEqual([
			{ email: "owner-mail@example.com", verified: 1 },
		]);
		await w.post("/api/login", { resetRequest: "owner-mail@example.com" });
		await waitMail(w.instance.app);
		const restoredReset = linkCode(box.messages.at(-1)?.text ?? "", "reset");
		expect((await w.post("/api/login", { reset: restoredReset, password: NEXT })).status).toBe(200);
		expect((await signIn(w, OWNER, NEXT)).status).toBe(200);
	} finally {
		await box.close();
	}
});

test("mail is optional and configured instances advertise password reset", async () => {
	const plain = world();
	expect(must(await plain.get("/api/login/methods"))).toMatchObject({ mail: false });
	const configured = world();
	configured.instance.app.config.mail = defaultConfig({
		MAINWORTHY_SMTP_HOST: "127.0.0.1",
		MAINWORTHY_SMTP_PORT: "2525",
		MAINWORTHY_SMTP_TLS: "none",
		MAINWORTHY_MAIL_FROM: "mainworthy@example.com",
		MAINWORTHY_PUBLIC_URL: "https://mainworthy.example",
	}).mail;
	expect(must(await configured.get("/api/login/methods"))).toMatchObject({ mail: true });
});

test("SMTP sends over STARTTLS and implicit TLS and rejects an untrusted certificate in either mode", async () => {
	const directory = scratch();
	const keyPath = join(directory, "test-key.pem");
	const certificatePath = join(directory, "test-certificate.pem");
	// These local TLS checks need the openssl certificate tool, on macOS and Linux.
	let generated: ReturnType<typeof Bun.spawnSync>;
	try {
		generated = Bun.spawnSync(
			[
				"openssl",
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				keyPath,
				"-out",
				certificatePath,
				"-subj",
				"/CN=localhost",
				"-addext",
				"subjectAltName=DNS:localhost,IP:127.0.0.1",
				"-days",
				"1",
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
	} catch {
		throw new Error("SMTP TLS checks need openssl on PATH");
	}
	if (generated.exitCode !== 0) throw new Error("SMTP TLS checks could not generate a test certificate with openssl");
	const tls = { key: readFileSync(keyPath), cert: readFileSync(certificatePath) };
	const probe = join(directory, "smtp-probe.ts");
	await Bun.write(
		probe,
		`import { openApp, defaultConfig } from ${JSON.stringify(join(process.cwd(), "src/server/kernel/app.ts"))};
import { queueMail, waitMail } from ${JSON.stringify(join(process.cwd(), "src/server/identity/identity.ts"))};
const app = openApp(defaultConfig(process.env), { memory: true });
const warnings: string[] = []; console.warn = (line) => warnings.push(String(line));
queueMail(app, { to: "robin@example.com", subject: "TLS test", text: "Encrypted delivery" });
await waitMail(app); app.close(); console.log(JSON.stringify({ warnings }));`,
	);
	const environment = { PATH: process.env.PATH ?? "", HOME: directory };
	for (const mode of ["starttls", "tls"] as const) {
		const smtp = await fakeSmtp({ tls, implicit: mode === "tls" });
		try {
			for (const trusted of [true, false]) {
				const before = smtp.messages.length;
				const child = Bun.spawn([process.execPath, probe], {
					env: {
						...environment,
						...(trusted ? { NODE_EXTRA_CA_CERTS: certificatePath } : {}),
						MAINWORTHY_SMTP_HOST: "127.0.0.1",
						MAINWORTHY_SMTP_PORT: String(smtp.port),
						MAINWORTHY_SMTP_TLS: mode,
						MAINWORTHY_SMTP_USER: "",
						MAINWORTHY_SMTP_PASSWORD: "",
						MAINWORTHY_MAIL_FROM: "mainworthy@example.com",
						MAINWORTHY_PUBLIC_URL: PUBLIC,
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const output = await new Response(child.stdout).text();
				const errors = await new Response(child.stderr).text();
				expect(await child.exited, errors).toBe(0);
				const result = z.object({ warnings: z.array(z.string()) }).parse(JSON.parse(output));
				expect(result.warnings).toEqual(
					trusted ? [] : ["[mainworthy] mail delivery failed; check SMTP configuration and request a new link"],
				);
				expect(smtp.messages.length - before).toBe(trusted ? 1 : 0);
			}
		} finally {
			await smtp.close();
		}
	}
}, 15_000);

test("only the owner changes another person's recovery address, and forgetting removes the address and pending links", async () => {
	const box = await mailbox();
	const w = box.w;
	try {
		await verified(w, box.messages);
		const admin = await joined(w, "ordinary-admin", PASSWORD, { can: ["admin"] });
		expect((await w.op("credential", contactInput("wrong@example.com"), { cookie: admin })).status).toBe(403);
		await w.post("/api/login", { resetRequest: "robin@example.com" });
		await waitMail(w.instance.app);
		const reset = linkCode(box.messages.at(-1)?.text ?? "", "reset");
		expect((await w.op("admin", { do: "actor.forget", name: "robin" })).status).toBe(200);
		await waitMail(w.instance.app);
		expect(box.messages.at(-1)?.text).toContain("Your sign-in methods were removed because your account was forgotten");
		expect(w.rows("SELECT * FROM mail_contacts")).toEqual([]);
		expect((await w.post("/api/login", { reset, password: NEXT })).status).toBe(400);
	} finally {
		await box.close();
	}
});
