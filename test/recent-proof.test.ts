// Recent proof (decision 0145): a change to how somebody signs in, or to who holds authority, made from a browser
// needs that browser's session to have proven who it is in the last ten minutes. A session opened with a token has
// it from its sign-in; one opened through the provider gets it only by signing in at the provider again (the
// ceremony of proof). A token sent as a bearer, and the local owner, need none.
import { afterEach, expect, spyOn, test } from "bun:test";
import { CLI_ENTRY } from "../src/cli/test-support.ts";
import * as identity from "../src/server/identity/identity.ts";
import { exportArchive } from "../src/server/transfer/transfer.ts";
import { pgRun } from "./identity-db.ts";
import {
	authorize,
	bearer,
	begin,
	cleanUp,
	finish,
	holdGate,
	invite,
	jar,
	joined,
	must,
	OWNER,
	prove,
	type Sent,
	said,
	sessionOf,
	signIn,
	subjectOf,
	TOKEN,
	viaProvider,
	type World,
	waitingAtGate,
	world,
} from "./people-support.ts";

afterEach(cleanUp);
const PROOF_MS = 10 * 60_000;
const stale = (w: World) => w.clock.advance(PROOF_MS + 1);
const refused = (reply: { status: number; body: unknown }) => {
	expect(reply.status).toBe(403);
	expect(reply.body).toMatchObject({ ok: false, error: { code: "recent_proof_required" } });
};
/** A browser that signs in with the owner's token: the cookie of its session. */
const tokenSession = async (w: World): Promise<string> => sessionOf(await w.post("/api/login", { token: TOKEN }));
/** A guarded change a person makes for themselves from a browser: a personal token. */
const personalToken = (w: World, cookie: string) =>
	w.op("credential", { do: "token.create", label: "CLI" }, jar(cookie));
/** A guarded change an admin makes from a browser: an invitation. */
const invitation = (w: World, cookie: string, name = "sam") => w.op("invitation", { do: "create", name }, jar(cookie));
/** Begins a ceremony of proof without following it, for a reply that refuses at the start. */
const proofBegin = (w: World, headers: Sent) => w.post("/api/login/oidc", { proof: true }, headers);
const seconds = (ms: number) => Math.floor(ms / 1000);

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

// ── What gives proof ───────────────────────────────────────────────────────────────────────────────────────

test("a token's sign-in in a browser proves that session for ten minutes; signing in with it again renews proof", async () => {
	const w = await world();
	const first = await tokenSession(w);
	// Nothing is linked to the owner, so there is nothing to confirm at the provider: the token is the way.
	expect(said(await proofBegin(w, jar(first)))).toBe("403 forbidden");
	w.clock.advance(PROOF_MS);
	expect((await invitation(w, first)).status).toBe(200);
	w.clock.advance(1);
	refused(await invitation(w, first));
	const second = await tokenSession(w);
	expect((await invitation(w, second)).status).toBe(200);
	refused(await invitation(w, first));
});

test("a provider session has no proof until its person signs in at the provider again, and the proof is its own", async () => {
	const w = await world();
	const first = await joined(w, "robin");
	const second = sessionOf(await signIn(w, "robin"));
	refused(await personalToken(w, first));
	refused(await personalToken(w, second));
	expect(must(await prove(w, first, "robin"))).toEqual({ proven: true });
	// The provider is asked to sign the person in again, whatever session it holds.
	expect(w.idp?.asked.at(-1)?.get("max_age")).toBe("0");
	expect((await personalToken(w, first)).status).toBe(200);
	refused(await personalToken(w, second));
	// A new sign-in through the provider is no proof either.
	refused(await personalToken(w, sessionOf(await signIn(w, "robin"))));
	w.clock.advance(PROOF_MS);
	expect((await personalToken(w, first)).status).toBe(200);
	w.clock.advance(1);
	refused(await personalToken(w, first));
	await w.post("/api/logout", {}, jar(first));
	expect(said(await proofBegin(w, jar(first)))).toBe("401 unauthenticated");
});

test("the provider's word is proof only when it signed the person in within the last ten minutes", async () => {
	const w = await world();
	const cookie = await joined(w, "robin");
	const old = await prove(w, cookie, "robin", seconds(w.clock.now() - PROOF_MS) - 1);
	expect(said(old)).toBe("403 forbidden");
	refused(await personalToken(w, cookie));
	expect(must(await prove(w, cookie, "robin", seconds(w.clock.now() - PROOF_MS)))).toEqual({ proven: true });
	expect((await personalToken(w, cookie)).status).toBe(200);
});

test("an answer that does not say when the person signed in, or says a time to come, proves nothing", async () => {
	const w = await world();
	const cookie = await joined(w, "robin");
	expect(said(await prove(w, cookie, "robin", null))).toBe("403 forbidden");
	refused(await personalToken(w, cookie));
	expect(said(await prove(w, cookie, "robin", seconds(w.clock.now()) + 31))).toBe("403 forbidden");
	refused(await personalToken(w, cookie));
	expect(w.idp?.asked.at(-1)?.get("claims")).toBe(JSON.stringify({ id_token: { auth_time: { essential: true } } }));
	expect(must(await prove(w, cookie, "robin"))).toEqual({ proven: true });
	expect((await personalToken(w, cookie)).status).toBe(200);
});

test("proof is of the person's own identity: another person's, or one nobody linked, proves nothing", async () => {
	const w = await world();
	const robin = await joined(w, "robin");
	await joined(w, "sam");
	expect(said(await prove(w, robin, "sam"))).toBe("403 forbidden");
	expect(said(await viaProvider(w, { subject: "sub-nobody" }, { proof: true }, robin))).toBe("403 forbidden");
	refused(await personalToken(w, robin));
});

test("a ceremony of proof finishes only in the session that began it, and signs no browser in", async () => {
	const w = await world();
	const first = await joined(w, "robin");
	const second = sessionOf(await signIn(w, "robin"));
	const begun = await begin(w, { proof: true }, jar(first));
	const query = await authorize(w, begun, { subject: subjectOf("robin") });
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(said(await finish(w, query, jar(second, begun.ceremony)))).toBe("401 unauthenticated");
		const again = await begin(w, { proof: true }, jar(first));
		const answer = await authorize(w, again, { subject: subjectOf("robin") });
		const bare = await finish(w, answer, jar(again.ceremony));
		expect(said(bare)).toBe("401 unauthenticated");
		expect(sessionOf(bare)).toBe("");
	} finally {
		warning.mockRestore();
	}
	refused(await personalToken(w, first));
	refused(await personalToken(w, second));
});

test("an identity unlinked while its proof was under way proves nothing", async () => {
	const w = await world();
	const robin = await joined(w, "robin");
	expect(must(await prove(w, robin, "robin"))).toEqual({ proven: true });
	expect(must(await viaProvider(w, { subject: "alt-robin" }, { link: true }, robin))).toEqual({ linked: true });
	const other = sessionOf(await signIn(w, "robin"));
	const begun = await begin(w, { proof: true }, jar(other));
	const query = await authorize(w, begun, { subject: "alt-robin" });
	const alt = must(await w.op<{ id: number; label: string }[]>("credential", { do: "list" }, jar(robin))).at(-1);
	expect((await w.op("credential", { do: "remove", id: alt?.id }, jar(robin))).status).toBe(200);
	expect(said(await finish(w, query, jar(other, begun.ceremony)))).toBe("403 forbidden");
	refused(await personalToken(w, other));
});

test("a proof dated in the future fails closed", async () => {
	const w = await world();
	const cookie = await tokenSession(w);
	w.clock.advance(-1);
	refused(await invitation(w, cookie));
});

test("the ceremony of proof is begun from this server's page, for one purpose, and records no command", async () => {
	const w = await world();
	const cookie = await joined(w, "robin");
	expect(said(await proofBegin(w, { ...jar(cookie), origin: "https://elsewhere.example" }))).toBe(
		"401 unauthenticated",
	);
	expect(said(await w.post("/api/login/oidc", { proof: true, link: true }, jar(cookie)))).toBe("400 invalid");
	expect(said(await proofBegin(w, bearer(TOKEN)))).toBe("403 forbidden");
	expect(must(await prove(w, cookie, "robin"))).toEqual({ proven: true });
	expect(await w.rows("SELECT id FROM commands")).toEqual([]);
});

// ── Linking and unlinking ──────────────────────────────────────────────────────────────────────────────────

test("the first identity is linked without proof; a second needs it", async () => {
	const w = await world();
	const cookie = await tokenSession(w);
	stale(w);
	expect(must(await viaProvider(w, { subject: subjectOf(OWNER) }, { link: true }, cookie))).toEqual({ linked: true });
	refused(await w.post("/api/login/oidc", { link: true }, jar(cookie)));
	// Now that an identity is linked, the token's session proves with it like any other.
	expect(must(await prove(w, cookie, OWNER))).toEqual({ proven: true });
	expect(must(await viaProvider(w, { subject: "alt-kim" }, { link: true }, cookie))).toEqual({ linked: true });
});

test("unlinking needs the caller's own proof in a browser, an admin's for another person too, and a bearer token cannot", async () => {
	const w = await world();
	const sam = await joined(w, "sam");
	expect(must(await prove(w, sam, "sam"))).toEqual({ proven: true });
	expect(must(await viaProvider(w, { subject: "alt-sam" }, { link: true }, sam))).toEqual({ linked: true });
	const [, alt] = await w.rows<{ id: number }>("SELECT id FROM credentials WHERE revoked_at IS NULL ORDER BY id");
	refused(await w.op("credential", { do: "remove", id: alt?.id }, bearer(TOKEN)));
	const admin = await tokenSession(w);
	stale(w);
	// Sam's own proof says nothing about the admin's session.
	expect(must(await prove(w, sam, "sam"))).toEqual({ proven: true });
	refused(await w.op("credential", { do: "remove", id: alt?.id }, jar(admin)));
	expect((await w.op("credential", { do: "remove", id: alt?.id }, jar(await tokenSession(w)))).status).toBe(200);
});

// ── Recovery and invitations ───────────────────────────────────────────────────────────────────────────────

test("invitation and recovery acceptance need no prior proof, and the last identity stays", async () => {
	const w = await world();
	const cookie = await joined(w, "robin");
	stale(w);
	const recovered = await invite(w, { name: "robin" });
	const accepted = await viaProvider(w, { subject: "new-robin" }, { invitation: recovered.code });
	expect(accepted.status).toBe(200);
	const session = sessionOf(accepted);
	expect(await w.status(jar(cookie))).toBe(401);
	const credential = (await w.rows<{ id: number }>("SELECT id FROM credentials WHERE revoked_at IS NULL"))[0];
	refused(await w.op("credential", { do: "remove", id: credential?.id }, jar(session)));
	expect(must(await viaProvider(w, { subject: "new-robin" }, { proof: true }, session))).toEqual({ proven: true });
	expect((await w.op("credential", { do: "remove", id: credential?.id }, jar(session))).status).toBe(400);
});

for (const can of [undefined, ["read"]]) {
	test(`browser join invitations require own recent proof (${can ? "read-only" : "default admin"})`, async () => {
		const w = await world();
		const cookie = await joined(w, "ada", { can: ["read", "admin"] });
		const input = { do: "create", name: "new-person", ...(can ? { can } : {}), cmd: "join-proof" };
		refused(await w.op("invitation", input, jar(cookie)));
		expect(await w.rows("SELECT id FROM actors WHERE name = 'new-person'")).toEqual([]);
		expect(await w.rows("SELECT id FROM commands WHERE id = 'join-proof'")).toEqual([]);
		await signIn(w, "ada");
		refused(await w.op("invitation", input, jar(cookie)));
		expect(must(await prove(w, cookie, "ada"))).toEqual({ proven: true });
		expect((await w.op("invitation", input, jar(cookie))).status).toBe(200);
		expect((await w.op("invitation", { do: "create", name: "token-person" }, bearer(TOKEN))).status).toBe(200);
		const local = await world({ mode: "local" });
		expect((await local.op("invitation", { do: "create", name: "local-person" }, {})).status).toBe(200);
	});
}

test("a stale browser cannot issue a recovery link; token, CLI and local recovery authority still works", async () => {
	const w = await world();
	await joined(w, "sam");
	const admin = await tokenSession(w);
	stale(w);
	const before = await w.rows("SELECT id FROM invitations");
	refused(await w.op("invitation", { do: "create", name: "sam", cmd: "stale-recovery" }, jar(admin)));
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
	expect((await invitation(w, await tokenSession(w))).status).toBe(200);
	const local = await world({ mode: "local" });
	await invite(local, { name: "local-person", can: ["read"], project: "scratch" }, {});
	expect((await invite(local, { name: "local-person" }, {})).purpose).toBe("recover");
});

// ── Authority ──────────────────────────────────────────────────────────────────────────────────────────────

for (const via of ["direct", "team-grant", "team-member"] as const) {
	test(`browser admin authority through ${via} requires own recent proof`, async () => {
		const w = await world();
		await joined(w, "controlled", { can: ["read"] });
		const cookie = await joined(w, "ada", { can: ["read", "admin"] });
		await w.ok("admin", { do: "team.create", name: "Quality" });
		if (via === "team-member")
			await w.ok("admin", { do: "team.grant.set", team: "Quality", can: ["admin"], project: "scratch" });
		else await w.ok("admin", { do: "team.member.add", team: "Quality", person: "controlled" });
		const input =
			via === "direct"
				? { do: "grant.set", actor: "controlled", can: ["admin"], cmd: "elevate-proof" }
				: via === "team-grant"
					? { do: "team.grant.set", team: "Quality", can: ["admin"], cmd: "elevate-proof" }
					: { do: "team.member.add", team: "Quality", person: "controlled", cmd: "elevate-proof" };
		const before = must(await w.op<unknown[]>("admin", { do: "actor.list" }));
		refused(await w.op("admin", input, jar(cookie)));
		expect(must(await w.op<unknown[]>("admin", { do: "actor.list" }))).toEqual(before);
		expect(await w.rows("SELECT id FROM commands WHERE id = 'elevate-proof'")).toEqual([]);
		await signIn(w, "ada");
		refused(await w.op("admin", input, jar(cookie)));
		expect(must(await prove(w, cookie, "ada"))).toEqual({ proven: true });
		expect((await w.op("admin", input, jar(cookie))).status).toBe(200);
		stale(w);
		const { cmd: _cmd, ...operatorInput } = input;
		expect((await w.op("admin", operatorInput, bearer(TOKEN))).status).toBe(200);
	});
}

test("queued team membership checks the current admin grant inside the writer", async () => {
	const w = await world();
	await joined(w, "controlled");
	const cookie = await joined(w, "ada", { can: ["read", "admin"] });
	await w.ok("admin", { do: "team.create", name: "Quality" });
	const grant = await admitted(w, () => w.op("admin", { do: "team.grant.set", team: "Quality", can: ["admin"] }));
	const member = await admitted(w, () =>
		w.op("admin", { do: "team.member.add", team: "Quality", person: "controlled" }, jar(cookie)),
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
		test(`a ${owner ? "owner" : "non-owner admin"} browser without proof cannot mint a ${operation} token to reach recovery authority`, async () => {
			const w = await world();
			const sam = await joined(w, "sam");
			const name = owner ? OWNER : "ada";
			const cookie = await joined(w, name, owner ? {} : { can: ["read", "admin"] });
			refused(await w.op("invitation", { do: "create", name: owner ? "sam" : name }, jar(cookie)));
			const input =
				operation === "credential"
					? { do: "token.create", label: "Recovery CLI", expires: "1d", cmd: "mint-proof" }
					: { do: "token.create", actor: name, kind: "human", cmd: "mint-proof" };
			const before = await w.rows("SELECT id FROM tokens");
			refused(await w.op(operation, input, jar(cookie)));
			expect(await w.rows("SELECT id FROM tokens")).toEqual(before);
			expect(await w.rows("SELECT id FROM commands WHERE id = 'mint-proof'")).toEqual([]);
			const otherSession = sessionOf(await signIn(w, name));
			refused(await w.op(operation, input, jar(cookie)));
			expect(must(await prove(w, cookie, name))).toEqual({ proven: true });
			const token = must(await w.op<{ token: string; expiresAt: number | null }>(operation, input, jar(cookie)));
			if (operation === "admin") expect(token.expiresAt).toBeNull();
			const link = await invite(w, { name: owner ? "sam" : name }, bearer(token.token));
			const recovered = await viaProvider(w, { subject: `new-${owner ? "sam" : name}` }, { invitation: link.code });
			expect(recovered.status).toBe(200);
			expect(await w.status(jar(owner ? sam : otherSession))).toBe(401);
		});
	}
}

// ── An archive import ──────────────────────────────────────────────────────────────────────────────────────

/** An archive of another instance, with a project this one does not have. */
async function archive(): Promise<string> {
	const source = await world();
	await source.ok("admin", { do: "project.create", key: "restored" });
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
const restored = (w: World) => w.rows("SELECT key FROM projects WHERE key = 'restored'");

const importBody = (w: World, body: string, headers: Record<string, string>) =>
	fetch(`${w.instance.url}/api/import`, { method: "POST", headers, body });

test("a browser imports an archive only with recent proof", async () => {
	const body = await archive();
	const w = await world();
	const cookie = await tokenSession(w);
	stale(w);
	const response = await importBody(w, body, jar(cookie));
	refused({ status: response.status, body: await response.json() });
	expect(await restored(w)).toEqual([]);
	expect(await w.status(jar(cookie))).toBe(200);
	const fresh = await tokenSession(w);
	expect((await importBody(w, body, jar(fresh))).status).toBe(200);
	expect(await restored(w)).toEqual([{ key: "restored" }]);
	// The import replaced the sessions with the archive's.
	expect(await w.status(jar(fresh))).toBe(401);
});

test("browser import rechecks proof after waiting at the write gate", async () => {
	const body = await archive();
	const w = await world();
	const cookie = await tokenSession(w);
	w.clock.advance(9 * 60_000 + 59_000);
	const request = await admitted(w, () => importBody(w, body, jar(cookie)));
	const gate = holdGate(w.instance);
	try {
		const waiting = waitingAtGate(w.instance, 1);
		request.release();
		await waiting;
		w.clock.advance(1_001);
		await gate.release();
		const response = await request.pending;
		refused({ status: response.status, body: await response.json() });
		expect(await restored(w)).toEqual([]);
	} finally {
		request.release();
		await gate.release();
	}
});

for (const mode of ["server", "local"] as const) {
	test(`${mode} operator import needs no browser proof`, async () => {
		const body = await archive();
		const w = await world({ mode });
		expect((await importBody(w, body, mode === "server" ? bearer(TOKEN) : {})).status).toBe(200);
		expect(await restored(w)).toEqual([{ key: "restored" }]);
	});
}

test("a proof rereads the session after waiting for the writer", async () => {
	const w = await world();
	const cookie = await joined(w, "robin");
	const begun = await begin(w, { proof: true }, jar(cookie));
	const query = await authorize(w, begun, { subject: subjectOf("robin") });
	const gate = holdGate(w.instance);
	const warning = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const waiting = waitingAtGate(w.instance, 1);
		const pending = finish(w, query, jar(cookie, begun.ceremony));
		await waiting;
		await gate.run(async (db) => await pgRun(w.instance.app, "UPDATE sessions SET ended_at = ?", [w.clock.now()], db));
		await gate.release();
		expect(said(await pending)).toBe("401 unauthenticated");
		expect(await w.rows<{ at: number | null }>("SELECT reauthenticated_at AS at FROM sessions")).toEqual([
			{ at: null },
		]);
	} finally {
		warning.mockRestore();
		await gate.release();
	}
});
