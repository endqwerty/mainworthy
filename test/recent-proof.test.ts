import { afterEach, expect, test } from "bun:test";
import { CLI_ENTRY } from "../src/cli/test-support.ts";
import { totpCode } from "../src/server/identity/totp.ts";
import type { AssertionOptions, RegistrationOptions } from "../src/server/identity/webauthn.ts";
import { defaultConfig } from "../src/server/kernel/app.ts";
import {
	authenticator,
	bearer,
	cleanUp,
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

for (const owner of [false, true]) {
	for (const operation of ["credential", "admin"] as const) {
		test(`a stale ${owner ? "owner" : "non-owner admin"} browser cannot mint a ${operation} token to reach recovery authority`, async () => {
			const w = world();
			const sam = await joined(w, "sam", "sam's own long password");
			const name = owner ? OWNER : "ada";
			const cookie = await joined(w, name, PASSWORD, owner ? {} : { can: ["read", "admin"] });
			stale(w);
			refused(await w.op("invitation", { do: "create", name: owner ? "sam" : name }, { cookie }));
			const input =
				operation === "credential"
					? { do: "token.create", label: "Recovery CLI", expires: "1d", cmd: "mint-proof" }
					: { do: "token.create", actor: name, kind: "human", cmd: "mint-proof" };
			const before = w.rows("SELECT id FROM tokens");
			refused(await w.op(operation, input, { cookie }));
			expect(w.rows("SELECT id FROM tokens")).toEqual(before);
			expect(w.rows("SELECT id FROM commands WHERE id = 'mint-proof'")).toEqual([]);
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
	const w = world();
	const cookie = await joined(w, "robin", PASSWORD);
	w.clock.advance(10 * 60_000 + 1);
	const reply = await w.op("credential", { do: "passkey.begin" }, { cookie });
	expect(reply.status).toBe(403);
	expect(reply.body).toMatchObject({ ok: false, error: { code: "recent_proof_required" } });
});

test("fresh password sign-in and proof authorize only their own session for ten minutes", async () => {
	const w = world();
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
	const w = world();
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
	const password = w.rows<{ id: number }>(
		"SELECT id FROM credentials WHERE kind = 'password' AND revoked_at IS NULL",
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
	const w = world();
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

test("an admin needs their own session proof when changing another person's credentials or address", async () => {
	const w = world();
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
	const w = world();
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
	const w = world();
	const cookie = await joined(w, "robin", PASSWORD);
	stale(w);
	const gate = holdGate(w.instance);
	const waiting = waitingAtGate(w.instance, 1);
	const pending = proof(w, cookie);
	await waiting;
	w.instance.app.db.raw.query("UPDATE sessions SET ended_at = ?").run(w.clock.now());
	await gate.release();
	expect((await pending).status).toBe(403);
	expect(w.rows<{ at: number | null }>("SELECT reauthenticated_at AS at FROM sessions")[0]?.at).not.toBe(w.clock.now());
});

test("a password replaced ahead of a queued proof cannot authenticate the still-live passkey session", async () => {
	const w = world();
	const cookie = await joined(w, "robin", PASSWORD);
	const key = await passkey(w, cookie);
	const begun = await w.post<{ passkey: AssertionOptions }>("/api/login/challenge", {});
	const login = await w.post(
		"/api/login",
		{ passkey: key.device.assert(must(begun).passkey) },
		{ cookie: begun.cookie },
	);
	stale(w);
	const gate = holdGate(w.instance);
	const firstWaiting = waitingAtGate(w.instance, 1);
	const change = w.post(
		"/api/account/password",
		{ current: PASSWORD, next: "a replacement long password" },
		{ cookie },
	);
	await firstWaiting;
	const nextWaiting = waitingAtGate(w.instance, 1);
	const checking = proof(w, login.cookie);
	await nextWaiting;
	await gate.release();
	expect((await change).status).toBe(200);
	expect((await checking).status).toBe(403);
	expect(await w.status({ cookie: login.cookie })).toBe(200);
	refused(await w.op("credential", { do: "totp.begin" }, { cookie: login.cookie }));
});

test("a future proof fails closed and failed password proofs share sign-in throttling", async () => {
	const w = world();
	const cookie = await joined(w, "robin", PASSWORD);
	w.clock.advance(-1);
	refused(await w.op("credential", { do: "totp.begin" }, { cookie }));
	w.clock.advance(10 * 60_000 + 2);
	for (let n = 0; n < 5; n++) expect((await proof(w, cookie, "wrong password")).status).toBe(403);
	expect((await proof(w, cookie)).status).toBe(429);
	expect((await signIn(w, "robin", PASSWORD)).status).toBe(429);
});

test("the proof exchange enforces origin and accepts exactly one proof without recording secrets", async () => {
	const w = world();
	const cookie = await joined(w, "robin", PASSWORD);
	stale(w);
	expect(
		(await w.post("/api/account/proof", { password: PASSWORD }, { cookie, origin: "https://elsewhere.example" }))
			.status,
	).toBe(401);
	expect((await w.post("/api/account/proof", { password: PASSWORD, code: "123456" }, { cookie })).status).toBe(400);
	refused(await w.op("credential", { do: "totp.begin" }, { cookie }));
	expect((await proof(w, cookie)).status).toBe(200);
	expect(w.rows("SELECT id FROM commands")).toEqual([]);
	expect(w.written().includes(Buffer.from(PASSWORD))).toBe(false);
});

test("invitation and recovery acceptance need no prior proof, and the last usable credential stays", async () => {
	const w = world();
	const cookie = await joined(w, "robin", PASSWORD);
	stale(w);
	const recovered = await invite(w, { name: "robin" });
	const accepted = await w.post("/api/login", { invitation: recovered.code, password: "a new recovery password" });
	expect(accepted.status).toBe(200);
	expect(await w.status({ cookie })).toBe(401);
	const credential = w.rows<{ id: number }>("SELECT id FROM credentials WHERE revoked_at IS NULL")[0];
	expect((await w.op("credential", { do: "remove", id: credential?.id }, { cookie: accepted.cookie })).status).toBe(
		400,
	);
	const ownerLogin = await w.post("/api/login", { token: TOKEN });
	expect((await w.post("/api/account/password", { next: PASSWORD }, { cookie: ownerLogin.cookie })).status).toBe(200);
});

test("a stale browser cannot issue a recovery link; token, CLI and local recovery authority still works", async () => {
	const w = world();
	await joined(w, "sam", PASSWORD);
	const admin = (await w.post("/api/login", { token: TOKEN })).cookie;
	expect((await w.post("/api/account/password", { next: PASSWORD }, { cookie: admin })).status).toBe(200);
	stale(w);
	const before = w.rows("SELECT id FROM invitations");
	refused(await w.op("invitation", { do: "create", name: "sam", cmd: "stale-recovery" }, { cookie: admin }));
	expect(w.rows("SELECT id FROM invitations")).toEqual(before);
	expect(w.rows("SELECT id FROM commands WHERE id = 'stale-recovery'")).toEqual([]);
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
	const local = world({ mode: "local" });
	await invite(local, { name: "local-person", can: ["read"], project: "scratch" }, {});
	expect((await invite(local, { name: "local-person" }, {})).purpose).toBe("recover");
});
