import { afterEach, expect, spyOn, test } from "bun:test";
import { CLI_ENTRY } from "../src/cli/test-support.ts";
import * as identity from "../src/server/identity/identity.ts";
import { waitMail } from "../src/server/identity/identity.ts";
import { totpCode } from "../src/server/identity/totp.ts";
import type { AssertionOptions, RegistrationOptions } from "../src/server/identity/webauthn.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import { exportArchive } from "../src/server/transfer/transfer.ts";
import { pgRun } from "./identity-db.ts";
import { fakeSmtp } from "./mail-support.ts";
import {
	authenticator,
	bearer,
	cleanUp,
	clockAt,
	holdGate,
	invite,
	joined,
	must,
	OWNER,
	signIn,
	TOKEN,
	type World,
	waitingAtGate,
	world,
} from "./people-support.ts";

afterEach(cleanUp);
const PASSWORD = "correct horse battery staple";
const proof = (w: World, cookie: string, password = PASSWORD) => w.post("/api/account/proof", { password }, { cookie });
const stale = (w: World) => w.clock.advance(10 * 60_000 + 1);
const refused = (reply: { status: number; body: unknown }) => {
	expect(reply.status).toBe(403);
	expect(reply.body).toMatchObject({ ok: false, error: { code: "recent_proof_required" } });
};

/** Pause after admission, whether its stored activity required an update or was already current. */
async function admitted<T>(w: World, start: () => Promise<T>) {
	const admit = identity.admit;
	const reached = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const intercept = spyOn(identity, "admit").mockImplementation(async (...args) => {
		if (args[0] !== w.instance.app) return admit(...args);
		intercept.mockRestore();
		const result = await admit(...args);
		reached.resolve();
		await resume.promise;
		return result;
	});
	const pending = start();
	await reached.promise;
	return { pending, release: () => resume.resolve() };
}

for (const email of ["recovery@example.org", null]) {
	test(`a credentialless token-opened owner must add and prove a credential before ${email === null ? "removing" : "setting"} a recovery address`, async () => {
		const smtp = await fakeSmtp();
		const w = await world();
		w.instance.app.config.mail = defaultConfig({
			MAINWORTHY_SMTP_HOST: "127.0.0.1",
			MAINWORTHY_SMTP_PORT: String(smtp.port),
			MAINWORTHY_SMTP_TLS: "none",
			MAINWORTHY_MAIL_FROM: "mainworthy@example.com",
			MAINWORTHY_PUBLIC_URL: "https://mainworthy.example",
		}).mail;
		try {
			const cookie = (await w.post("/api/login", { token: TOKEN })).cookie;
			if (email === null) {
				await pgRun(
					w.instance.app,
					"INSERT INTO mail_contacts (actor, email, verified_at, revision) SELECT id, ?, ?, ? FROM actors WHERE name = ?",
					["existing@example.org", w.clock.now(), "existing-contact", OWNER],
				);
			}
			const before = await w.rows("SELECT * FROM mail_contacts");
			stale(w);
			const change = () => w.op("credential", { do: "email.set", email }, { cookie });
			refused(await change());
			expect(await w.rows("SELECT * FROM mail_contacts")).toEqual(before);
			await waitMail(w.instance.app);
			expect(smtp.messages).toHaveLength(0);
			expect((await w.post("/api/account/password", { next: PASSWORD }, { cookie })).status).toBe(200);
			refused(await change());
			expect(await w.rows("SELECT * FROM mail_contacts")).toEqual(before);
			expect((await proof(w, cookie)).status).toBe(200);
			expect(must(await change())).toEqual({ email, verified: false });
			expect(await w.rows("SELECT email FROM mail_contacts")).toEqual(email === null ? [] : [{ email }]);
		} finally {
			await waitMail(w.instance.app);
			await smtp.close();
		}
	});
}

for (const input of [{ do: "totp.begin" }, { do: "totp.confirm", challenge: "unproved-enrollment", code: "123456" }]) {
	test(`a credentialless token-opened owner has no first-credential exemption for ${input.do}`, async () => {
		const w = await world();
		const cookie = (await w.post("/api/login", { token: TOKEN })).cookie;
		stale(w);
		refused(await w.op("credential", input, { cookie }));
		expect(must(await w.op<unknown[]>("credential", { do: "list" }, { cookie }))).toEqual([]);
	});
}

async function verifiedAdminArchive(): Promise<string> {
	const source = await world();
	const owner = (await source.rows<{ id: number; name: string }>("SELECT id, name FROM actors")).find(
		(row) => row.name === OWNER,
	);
	if (!owner) throw new Error("no owner");
	await pgRun(
		source.instance.app,
		"INSERT INTO mail_contacts (actor, email, verified_at, revision) VALUES (?, ?, ?, ?)",
		[owner.id, "restored@example.org", source.clock.now(), "restored-contact"],
	);
	const chunks: string[] = [];
	await source.instance.app.database.read(
		async (db) =>
			await exportArchive(
				db,
				(chunk) => {
					chunks.push(chunk);
				},
				{ blobs: source.instance.app.blobs },
			),
	);
	return chunks.join("");
}

const importBody = (w: World, body: string, headers: Record<string, string>) =>
	fetch(`${w.instance.url}/api/import`, { method: "POST", headers, body });

async function preparedImport(w: World): Promise<string> {
	const cookie = (await w.post("/api/login", { token: TOKEN })).cookie;
	expect((await w.post("/api/account/password", { next: PASSWORD }, { cookie })).status).toBe(200);
	return cookie;
}

test("stale browser import cannot install a verified address and gain an administrator through mail reset", async () => {
	const body = await verifiedAdminArchive();
	const smtp = await fakeSmtp();
	const w = await world();
	w.instance.app.config.mail = defaultConfig({
		MAINWORTHY_SMTP_HOST: "127.0.0.1",
		MAINWORTHY_SMTP_PORT: String(smtp.port),
		MAINWORTHY_SMTP_TLS: "none",
		MAINWORTHY_MAIL_FROM: "mainworthy@example.com",
		MAINWORTHY_PUBLIC_URL: "https://mainworthy.example",
	}).mail;
	try {
		const cookie = await preparedImport(w);
		stale(w);
		const response = await importBody(w, body, { cookie });
		refused({ status: response.status, body: await response.json() });
		expect(await w.rows("SELECT actor FROM mail_contacts")).toEqual([]);
		expect(await w.status({ cookie })).toBe(200);
		await w.post("/api/login", { resetRequest: "restored@example.org" });
		await waitMail(w.instance.app);
		expect(smtp.messages).toHaveLength(0);
		expect((await signIn(w, OWNER, PASSWORD)).status).toBe(200);
		const otherProof = await importBody(w, body, { cookie });
		refused({ status: otherProof.status, body: await otherProof.json() });
		expect((await proof(w, cookie)).status).toBe(200);
		expect((await importBody(w, body, { cookie })).status).toBe(200);
		expect(await w.status({ cookie })).toBe(401);
		expect(await w.rows("SELECT email FROM mail_contacts WHERE verified_at IS NOT NULL")).toEqual([
			{ email: "restored@example.org" },
		]);
		await w.post("/api/login", { resetRequest: "restored@example.org" });
		await waitMail(w.instance.app);
		const reset = /\/reset#([A-Za-z0-9_-]{43})/.exec(smtp.messages.at(-1)?.text ?? "")?.[1];
		expect(reset).toBeDefined();
		expect((await w.post("/api/login", { reset, password: PASSWORD })).status).toBe(200);
		const restored = await signIn(w, OWNER, PASSWORD);
		expect((await w.op("admin", { do: "actor.list" }, { cookie: restored.cookie })).status).toBe(200);
		expect(
			(await w.op("credential", { do: "token.create", label: "Restored CLI" }, { cookie: restored.cookie })).status,
		).toBe(200);
	} finally {
		await waitMail(w.instance.app);
		await smtp.close();
	}
});

test("browser import rechecks proof after waiting at the write gate", async () => {
	const body = await verifiedAdminArchive();
	const w = await world();
	const cookie = await preparedImport(w);
	expect((await proof(w, cookie)).status).toBe(200);
	w.clock.advance(9 * 60_000 + 59_000);
	const request = await admitted(w, () => importBody(w, body, { cookie }));
	const gate = holdGate(w.instance);
	try {
		const waiting = waitingAtGate(w.instance, 1);
		request.release();
		await waiting;
		w.clock.advance(1_001);
		await gate.release();
		const response = await request.pending;
		refused({ status: response.status, body: await response.json() });
		expect(await w.rows("SELECT actor FROM mail_contacts")).toEqual([]);
	} finally {
		request.release();
		await gate.release();
	}
});

for (const mode of ["server", "local"] as const) {
	test(`${mode} operator import retains verified recovery addresses without browser proof`, async () => {
		const body = await verifiedAdminArchive();
		const w = await world({ mode });
		expect((await importBody(w, body, mode === "server" ? bearer(TOKEN) : {})).status).toBe(200);
		expect(await w.rows("SELECT email FROM mail_contacts WHERE verified_at IS NOT NULL")).toEqual([
			{ email: "restored@example.org" },
		]);
	});
}

for (const can of [undefined, ["read"]]) {
	test(`browser join invitations require own recent proof (${can ? "read-only" : "default admin"})`, async () => {
		const w = await world();
		const cookie = await joined(w, "ada", PASSWORD, { can: ["read", "admin"] });
		stale(w);
		const input = { do: "create", name: "new-person", ...(can ? { can } : {}), cmd: "join-proof" };
		refused(await w.op("invitation", input, { cookie }));
		expect(await w.rows("SELECT id FROM actors WHERE name = 'new-person'")).toEqual([]);
		expect(await w.rows("SELECT id FROM commands WHERE id = 'join-proof'")).toEqual([]);
		await signIn(w, "ada", PASSWORD);
		refused(await w.op("invitation", input, { cookie }));
		expect((await proof(w, cookie)).status).toBe(200);
		expect((await w.op("invitation", input, { cookie })).status).toBe(200);
		expect((await w.op("invitation", { do: "create", name: "token-person" }, bearer(TOKEN))).status).toBe(200);
		const local = await world({ mode: "local" });
		expect((await local.op("invitation", { do: "create", name: "local-person" }, {})).status).toBe(200);
	});
}

for (const via of ["direct", "team-grant", "team-member"] as const) {
	test(`browser admin authority through ${via} requires own recent proof`, async () => {
		const w = await world();
		await joined(w, "controlled", "a controlled person's password", { can: ["read"] });
		const cookie = await joined(w, "ada", PASSWORD, { can: ["read", "admin"] });
		await w.ok("admin", { do: "team.create", name: "Quality" });
		if (via === "team-member")
			await w.ok("admin", { do: "team.grant.set", team: "Quality", can: ["admin"], project: "scratch" });
		else await w.ok("admin", { do: "team.member.add", team: "Quality", person: "controlled" });
		stale(w);
		const input =
			via === "direct"
				? { do: "grant.set", actor: "controlled", can: ["admin"], cmd: "elevate-proof" }
				: via === "team-grant"
					? { do: "team.grant.set", team: "Quality", can: ["admin"], cmd: "elevate-proof" }
					: { do: "team.member.add", team: "Quality", person: "controlled", cmd: "elevate-proof" };
		const before = must(await w.op<unknown[]>("admin", { do: "actor.list" }));
		refused(await w.op("admin", input, { cookie }));
		expect(must(await w.op<unknown[]>("admin", { do: "actor.list" }))).toEqual(before);
		expect(await w.rows("SELECT id FROM commands WHERE id = 'elevate-proof'")).toEqual([]);
		await signIn(w, "ada", PASSWORD);
		refused(await w.op("admin", input, { cookie }));
		expect((await proof(w, cookie)).status).toBe(200);
		expect((await w.op("admin", input, { cookie })).status).toBe(200);
		stale(w);
		const { cmd: _cmd, ...operatorInput } = input;
		expect((await w.op("admin", operatorInput, bearer(TOKEN))).status).toBe(200);
	});
}

test("queued team membership checks the current admin grant inside the writer", async () => {
	const w = await world();
	await joined(w, "controlled", "a controlled person's password");
	const cookie = await joined(w, "ada", PASSWORD, { can: ["read", "admin"] });
	await w.ok("admin", { do: "team.create", name: "Quality" });
	stale(w);
	const grant = await admitted(w, () => w.op("admin", { do: "team.grant.set", team: "Quality", can: ["admin"] }));
	const member = await admitted(w, () =>
		w.op("admin", { do: "team.member.add", team: "Quality", person: "controlled" }, { cookie }),
	);
	const gate = holdGate(w.instance);
	try {
		const grantWaiting = waitingAtGate(w.instance, 1);
		grant.release();
		await grantWaiting;
		const memberWaiting = waitingAtGate(w.instance, 1);
		member.release();
		await memberWaiting;
		await gate.release();
		expect((await grant.pending).status).toBe(200);
		refused(await member.pending);
		expect(must(await w.op("admin", { do: "team.list" }))).toMatchObject([{ name: "Quality", members: [] }]);
	} finally {
		grant.release();
		member.release();
		await gate.release();
	}
});

for (const owner of [false, true]) {
	for (const operation of ["credential", "admin"] as const) {
		test(`a stale ${owner ? "owner" : "non-owner admin"} browser cannot mint a ${operation} token to reach recovery authority`, async () => {
			const w = await world();
			const sam = await joined(w, "sam", "sam's own long password");
			const name = owner ? OWNER : "ada";
			const cookie = await joined(w, name, PASSWORD, owner ? {} : { can: ["read", "admin"] });
			stale(w);
			refused(await w.op("invitation", { do: "create", name: owner ? "sam" : name }, { cookie }));
			const input =
				operation === "credential"
					? { do: "token.create", label: "Recovery CLI", expires: "1d", cmd: "mint-proof" }
					: { do: "token.create", actor: name, kind: "human", cmd: "mint-proof" };
			const before = await w.rows("SELECT id FROM tokens");
			refused(await w.op(operation, input, { cookie }));
			expect(await w.rows("SELECT id FROM tokens")).toEqual(before);
			expect(await w.rows("SELECT id FROM commands WHERE id = 'mint-proof'")).toEqual([]);
			const otherSession = (await signIn(w, name, PASSWORD)).cookie;
			refused(await w.op(operation, input, { cookie }));
			expect((await proof(w, cookie)).status).toBe(200);
			const token = must(await w.op<{ token: string; expiresAt: number | null }>(operation, input, { cookie }));
			if (operation === "admin") expect(token.expiresAt).toBeNull();
			const link = await invite(w, { name: owner ? "sam" : name }, bearer(token.token));
			const recovered = await w.post("/api/login", { invitation: link.code, password: "a new recovery password" });
			expect(recovered.status).toBe(200);
			expect(await w.status({ cookie: owner ? sam : otherSession })).toBe(401);
		});
	}
}
async function passkey(w: World, cookie: string) {
	const device = authenticator();
	const options = await w.ok<RegistrationOptions>("credential", { do: "passkey.begin" }, { cookie });
	const added = await w.ok<{ id: number }>(
		"credential",
		{ do: "passkey.add", passkey: device.register(options), label: "laptop" },
		{ cookie },
	);
	return { device, id: added.id };
}

test("a session older than ten minutes cannot begin changing its sign-in", async () => {
	const w = await world();
	const cookie = await joined(w, "robin", PASSWORD);
	w.clock.advance(10 * 60_000 + 1);
	const reply = await w.op("credential", { do: "passkey.begin" }, { cookie });
	expect(reply.status).toBe(403);
	expect(reply.body).toMatchObject({ ok: false, error: { code: "recent_proof_required" } });
});

test("fresh password sign-in and proof authorize only their own session for ten minutes", async () => {
	const w = await world();
	const first = await joined(w, "robin", PASSWORD);
	const second = (await signIn(w, "robin", PASSWORD)).cookie;
	w.clock.advance(10 * 60_000);
	expect((await w.op("credential", { do: "totp.begin" }, { cookie: first })).status).toBe(200);
	w.clock.advance(1);
	refused(await w.op("credential", { do: "totp.begin" }, { cookie: first }));
	expect((await proof(w, first, "not the password")).status).toBe(403);
	refused(await w.op("credential", { do: "totp.begin" }, { cookie: first }));
	expect((await proof(w, first)).status).toBe(200);
	expect((await w.op("credential", { do: "totp.begin" }, { cookie: first })).status).toBe(200);
	refused(await w.op("credential", { do: "totp.begin" }, { cookie: second }));
	const third = (await signIn(w, "robin", PASSWORD)).cookie;
	expect((await w.op("credential", { do: "totp.begin" }, { cookie: third })).status).toBe(200);
	await w.post("/api/logout", {}, { cookie: first });
	expect((await proof(w, first)).status).toBe(401);
	refused(await w.op("credential", { do: "totp.begin" }, { cookie: second }));
});

test("passkey finalization, password addition, removal and recovery address writes all require proof", async () => {
	const w = await world();
	const cookie = await joined(w, "robin", PASSWORD);
	const { device, id } = await passkey(w, cookie);
	w.clock.advance(9 * 60_000 + 59_000);
	const pending = await w.ok<RegistrationOptions>("credential", { do: "passkey.begin" }, { cookie });
	const answer = authenticator().register(pending);
	w.instance.app.config.mail = defaultConfig({
		MAINWORTHY_SMTP_HOST: "localhost",
		MAINWORTHY_MAIL_FROM: "mainworthy@example.com",
		MAINWORTHY_PUBLIC_URL: "https://mainworthy.example",
	}).mail;
	w.clock.advance(1_001);
	refused(await w.op("credential", { do: "passkey.add", passkey: answer, label: "second" }, { cookie }));
	refused(await w.op("credential", { do: "remove", id }, { cookie }));
	for (const email of [null, "robin@example.com"])
		refused(await w.op("credential", { do: "email.set", email }, { cookie }));
	const options = must(
		await w.post<{ passkey: AssertionOptions }>("/api/account/proof", { begin: true }, { cookie }),
	).passkey;
	const assertion = device.assert(options);
	expect((await w.post("/api/account/proof", { passkey: assertion }, { cookie })).status).toBe(200);
	expect((await w.post("/api/account/proof", { passkey: assertion }, { cookie })).status).toBe(403);
	expect((await w.op("credential", { do: "passkey.add", passkey: answer, label: "second" }, { cookie })).status).toBe(
		200,
	);
	expect((await w.op("credential", { do: "remove", id }, { cookie })).status).toBe(200);
	// The proof remains on this session after removing the passkey that proved it.
	expect((await w.op("credential", { do: "email.set", email: null }, { cookie })).status).toBe(200);
	// A registration challenge expires after five minutes; obtain another with the new proof.
	const other = await passkey(w, cookie);
	const begun = await w.post<{ passkey: AssertionOptions }>("/api/login/challenge", {});
	const login = await w.post(
		"/api/login",
		{ passkey: other.device.assert(must(begun).passkey) },
		{ cookie: begun.cookie },
	);
	expect(login.status).toBe(200);
	stale(w);
	expect((await proof(w, login.cookie)).status).toBe(200);
	const password = (
		await w.rows<{ id: number }>("SELECT id FROM credentials WHERE kind = 'password' AND revoked_at IS NULL")
	)[0];
	await w.ok("credential", { do: "remove", id: password?.id }, { cookie: login.cookie });
	expect((await w.op("credential", { do: "email.set", email: null }, { cookie: login.cookie })).status).toBe(200);
	stale(w);
	refused(await w.post("/api/account/password", { next: PASSWORD }, { cookie: login.cookie }));
	const keyProof = must(
		await w.post<{ passkey: AssertionOptions }>("/api/account/proof", { begin: true }, { cookie: login.cookie }),
	).passkey;
	expect(
		(await w.post("/api/account/proof", { passkey: other.device.assert(keyProof) }, { cookie: login.cookie })).status,
	).toBe(200);
	expect((await w.post("/api/account/password", { next: PASSWORD }, { cookie: login.cookie })).status).toBe(200);
});

test("TOTP confirmation rechecks freshness, TOTP proof consumes the code, and recovery codes are not standalone proof", async () => {
	const w = await world();
	const cookie = await joined(w, "robin", PASSWORD);
	const setup = await w.ok<{ challenge: string; secret: string }>("credential", { do: "totp.begin" }, { cookie });
	stale(w);
	refused(
		await w.op(
			"credential",
			{
				do: "totp.confirm",
				challenge: setup.challenge,
				code: totpCode(setup.secret, Math.floor(w.clock.now() / 30_000)),
			},
			{ cookie },
		),
	);
	await proof(w, cookie);
	const fresh = await w.ok<{ challenge: string; secret: string }>("credential", { do: "totp.begin" }, { cookie });
	const confirmed = await w.ok<{ id: number; recoveryCodes: string[] }>(
		"credential",
		{
			do: "totp.confirm",
			challenge: fresh.challenge,
			code: totpCode(fresh.secret, Math.floor(w.clock.now() / 30_000)),
		},
		{ cookie },
	);
	stale(w);
	expect((await w.post("/api/account/proof", { code: confirmed.recoveryCodes[0] }, { cookie })).status).toBe(403);
	refused(await w.op("credential", { do: "remove", id: confirmed.id }, { cookie }));
	const code = totpCode(fresh.secret, Math.floor(w.clock.now() / 30_000));
	expect((await w.post("/api/account/proof", { code }, { cookie })).status).toBe(200);
	expect((await w.post("/api/account/proof", { code }, { cookie })).status).toBe(403);
	expect((await w.op("credential", { do: "remove", id: confirmed.id }, { cookie })).status).toBe(200);
});

// A secret whose code is the same in two consecutive 30-second steps, found by search. A proof checked in the
// first step and written in the second must keep the step the write accepted, or the code works once more.
test("TOTP proof keeps the replay step that was checked at the write gate", async () => {
	const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
	const step = 60_779_457;
	const code = "566269";
	expect([totpCode(secret, step), totpCode(secret, step + 1)]).toEqual([code, code]);
	const w = await world({ clock: clockAt(step * 30_000 + 29_000) });
	const cookie = await joined(w, "robin", PASSWORD);
	const setup = await w.ok<{ challenge: string; secret: string }>("credential", { do: "totp.begin" }, { cookie });
	await w.ok(
		"credential",
		{ do: "totp.confirm", challenge: setup.challenge, code: totpCode(setup.secret, step) },
		{ cookie },
	);
	await pgRun(
		w.instance.app,
		"UPDATE credentials SET data = jsonb_set(jsonb_set(data::jsonb, '{secret}', to_jsonb(?::text)), '{lastStep}', '-1'::jsonb)::text WHERE kind = 'totp'",
		[secret],
	);
	const request = await admitted(w, () => w.post("/api/account/proof", { code }, { cookie }));
	const gate = holdGate(w.instance);
	try {
		const waiting = waitingAtGate(w.instance, 1);
		request.release();
		await waiting;
		w.clock.advance(1_500);
		await gate.release();
		expect((await request.pending).status).toBe(200);
	} finally {
		request.release();
		await gate.release();
	}
	expect((await w.post("/api/account/proof", { code }, { cookie })).status).toBe(403);
});

test("an admin needs their own session proof when changing another person's credentials or address", async () => {
	const w = await world();
	const person = await joined(w, "sam", "a different quite long password");
	const key = await passkey(w, person);
	refused(await w.op("credential", { do: "email.set", actor: "sam", email: null }, bearer(TOKEN)));
	expect((await w.post("/api/account/proof", { password: PASSWORD }, bearer(TOKEN))).status).toBe(403);
	const admin = await joined(w, OWNER, PASSWORD, {});
	stale(w);
	await proof(w, person, "a different quite long password");
	refused(await w.op("credential", { do: "remove", id: key.id }, { cookie: admin }));
	refused(await w.op("credential", { do: "email.set", actor: "sam", email: null }, { cookie: admin }));
	expect((await proof(w, admin, "a different quite long password")).status).toBe(403);
	await proof(w, admin);
	expect((await w.op("credential", { do: "email.set", actor: "sam", email: null }, { cookie: admin })).status).toBe(
		200,
	);
	expect((await w.op("credential", { do: "remove", id: key.id }, { cookie: admin })).status).toBe(200);
});

test("a passkey proof cannot be moved to another session or person", async () => {
	const w = await world();
	const first = await joined(w, "robin", PASSWORD);
	const second = (await signIn(w, "robin", PASSWORD)).cookie;
	const other = await joined(w, "sam", PASSWORD);
	const key = await passkey(w, first);
	const otherKey = await passkey(w, other);
	stale(w);
	const options = must(
		await w.post<{ passkey: AssertionOptions }>("/api/account/proof", { begin: true }, { cookie: first }),
	).passkey;
	expect(
		(await w.post("/api/account/proof", { passkey: otherKey.device.assert(options) }, { cookie: first })).status,
	).toBe(403);
	const answer = key.device.assert(options, { userHandle: null });
	expect((await w.post("/api/account/proof", { passkey: answer }, { cookie: second })).status).toBe(403);
	expect((await w.post("/api/account/proof", { passkey: answer }, { cookie: first })).status).toBe(200);
	refused(await w.op("credential", { do: "totp.begin" }, { cookie: second }));
});

test("proof rereads credential and session state after waiting for the writer", async () => {
	const w = await world();
	const cookie = await joined(w, "robin", PASSWORD);
	stale(w);
	const request = await admitted(w, () => proof(w, cookie));
	const gate = holdGate(w.instance);
	const waiting = waitingAtGate(w.instance, 1);
	try {
		request.release();
		await waiting;
		await gate.run(async (db) => await pgRun(w.instance.app, "UPDATE sessions SET ended_at = ?", [w.clock.now()], db));
		await gate.release();
		expect((await request.pending).status).toBe(403);
		expect((await w.rows<{ at: number | null }>("SELECT reauthenticated_at AS at FROM sessions"))[0]?.at).not.toBe(
			w.clock.now(),
		);
	} finally {
		request.release();
		await gate.release();
	}
});

test("a password replaced ahead of a queued proof cannot authenticate the still-live passkey session", async () => {
	const w = await world();
	const cookie = await joined(w, "robin", PASSWORD);
	const key = await passkey(w, cookie);
	const begun = await w.post<{ passkey: AssertionOptions }>("/api/login/challenge", {});
	const login = await w.post(
		"/api/login",
		{ passkey: key.device.assert(must(begun).passkey) },
		{ cookie: begun.cookie },
	);
	stale(w);
	const change = await admitted(w, () =>
		w.post("/api/account/password", { current: PASSWORD, next: "a replacement long password" }, { cookie }),
	);
	const checking = await admitted(w, () => proof(w, login.cookie));
	const gate = holdGate(w.instance);
	try {
		const firstWaiting = waitingAtGate(w.instance, 1);
		change.release();
		await firstWaiting;
		const nextWaiting = waitingAtGate(w.instance, 1);
		checking.release();
		await nextWaiting;
		await gate.release();
		expect((await change.pending).status).toBe(200);
		expect((await checking.pending).status).toBe(403);
		expect(await w.status({ cookie: login.cookie })).toBe(200);
		refused(await w.op("credential", { do: "totp.begin" }, { cookie: login.cookie }));
	} finally {
		change.release();
		checking.release();
		await gate.release();
	}
});

test("a future proof fails closed and failed password proofs share sign-in throttling", async () => {
	const w = await world();
	const cookie = await joined(w, "robin", PASSWORD);
	w.clock.advance(-1);
	refused(await w.op("credential", { do: "totp.begin" }, { cookie }));
	w.clock.advance(10 * 60_000 + 2);
	for (let n = 0; n < 5; n++) expect((await proof(w, cookie, "wrong password")).status).toBe(403);
	expect((await proof(w, cookie)).status).toBe(429);
	expect((await signIn(w, "robin", PASSWORD)).status).toBe(429);
});

test("the proof exchange enforces origin and accepts exactly one proof without recording secrets", async () => {
	const w = await world();
	const cookie = await joined(w, "robin", PASSWORD);
	stale(w);
	expect(
		(await w.post("/api/account/proof", { password: PASSWORD }, { cookie, origin: "https://elsewhere.example" }))
			.status,
	).toBe(401);
	expect((await w.post("/api/account/proof", { password: PASSWORD, code: "123456" }, { cookie })).status).toBe(400);
	refused(await w.op("credential", { do: "totp.begin" }, { cookie }));
	expect((await proof(w, cookie)).status).toBe(200);
	expect(await w.rows("SELECT id FROM commands")).toEqual([]);
	expect((await w.written()).includes(Buffer.from(PASSWORD))).toBe(false);
});

test("invitation and recovery acceptance need no prior proof, and the last usable credential stays", async () => {
	const w = await world();
	const cookie = await joined(w, "robin", PASSWORD);
	stale(w);
	const recovered = await invite(w, { name: "robin" });
	const accepted = await w.post("/api/login", { invitation: recovered.code, password: "a new recovery password" });
	expect(accepted.status).toBe(200);
	expect(await w.status({ cookie })).toBe(401);
	const credential = (await w.rows<{ id: number }>("SELECT id FROM credentials WHERE revoked_at IS NULL"))[0];
	expect((await w.op("credential", { do: "remove", id: credential?.id }, { cookie: accepted.cookie })).status).toBe(
		400,
	);
	const ownerLogin = await w.post("/api/login", { token: TOKEN });
	expect((await w.post("/api/account/password", { next: PASSWORD }, { cookie: ownerLogin.cookie })).status).toBe(200);
});

test("a stale browser cannot issue a recovery link; token, CLI and local recovery authority still works", async () => {
	const w = await world();
	await joined(w, "sam", PASSWORD);
	const admin = (await w.post("/api/login", { token: TOKEN })).cookie;
	expect((await w.post("/api/account/password", { next: PASSWORD }, { cookie: admin })).status).toBe(200);
	stale(w);
	const before = await w.rows("SELECT id FROM invitations");
	refused(await w.op("invitation", { do: "create", name: "sam", cmd: "stale-recovery" }, { cookie: admin }));
	expect(await w.rows("SELECT id FROM invitations")).toEqual(before);
	expect(await w.rows("SELECT id FROM commands WHERE id = 'stale-recovery'")).toEqual([]);
	const tokenLink = await invite(w, { name: "sam" });
	expect(tokenLink.purpose).toBe("recover");
	const cli = Bun.spawn([process.execPath, CLI_ENTRY, "invite", "new", "sam"], {
		env: { ...process.env, MAINWORTHY_URL: w.instance.url, MAINWORTHY_TOKEN: TOKEN },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, rc] = await Promise.all([
		new Response(cli.stdout).text(),
		new Response(cli.stderr).text(),
		cli.exited,
	]);
	expect([rc, stderr]).toEqual([0, ""]);
	expect(stdout).toContain("/invite#");
	expect((await proof(w, admin)).status).toBe(200);
	expect((await w.op("invitation", { do: "create", name: "sam" }, { cookie: admin })).status).toBe(200);
	const local = await world({ mode: "local" });
	await invite(local, { name: "local-person", can: ["read"], project: "scratch" }, {});
	expect((await invite(local, { name: "local-person" }, {})).purpose).toBe("recover");
});
