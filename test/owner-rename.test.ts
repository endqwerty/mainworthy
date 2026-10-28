// What a start does when `MAINWORTHY_OWNER_WAS` names the owner's former name: the same person under the new
// name, with everything they sign in with, or a refusal that names the variable. On a real listener.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Instance, start } from "../src/app/start.ts";
import type { Envelope, SessionInfo } from "../src/core/api.ts";
import { type Config, defaultConfig } from "../src/server/kernel/app.ts";
import { closeIdentityDatabases, identityDatabaseUrl, pgRows } from "./identity-db.ts";
import { type Provider, provider, stopProviders } from "./oidc-support.ts";

/** 36 characters: long enough that the start has nothing to say about it. */
const TOKEN = "owner-secret-0123456789abcdef-012345";
/** Where people open the instance, and where the provider sends them back to. */
const PUBLIC = "https://mainworthy.example";
const DAY = 24 * 3_600_000;
const UNCHANGED =
	"; no actor and no token was changed (the database may have been brought to this build's schema first)";

const dirs: string[] = [];
const running: Instance[] = [];
afterEach(async () => {
	for (const instance of running.splice(0)) await instance.stop();
	stopProviders();
	await closeIdentityDatabases();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "mainworthy-owner-rename-"));
	dirs.push(dir);
	return dir;
}

type Boot = { dataDir: string; owner: string; ownerWas?: string; mode?: Config["mode"]; idp?: Provider };
async function boot(options: Boot): Promise<Instance> {
	const mode = options.mode ?? "server";
	const instance = await start(
		{
			databaseUrl: await identityDatabaseUrl(options.dataDir),
			dataDir: options.dataDir,
			host: "127.0.0.1",
			port: 0,
			mode,
			owner: options.owner,
			...(options.ownerWas === undefined ? {} : { ownerWas: options.ownerWas }),
			ownerToken: mode === "server" ? TOKEN : null,
			commit: null,
			proxy: null,
			sessionIdleMs: 14 * DAY,
			sessionMaxMs: 90 * DAY,
			...(options.idp ? { publicUrl: PUBLIC, oidc: options.idp.config() } : {}),
		},
		() => ({ ui: null }),
		{},
	);
	running.push(instance);
	return instance;
}

/** What a start said, without the line every server that names no proxy says. */
const said = (instance: { warnings: string[] }): string[] =>
	instance.warnings.filter((line) => !line.startsWith("MAINWORTHY_TRUSTED_PROXY"));

type Sent = Record<string, string>;
const bearer: Sent = { authorization: `Bearer ${TOKEN}` };

async function post<T>(instance: Instance, path: string, body: unknown, headers: Sent = {}) {
	const response = await fetch(`${instance.url}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	const cookie = response.headers.getSetCookie()[0]?.split(";")[0] ?? "";
	return { status: response.status, body: (await response.json()) as Envelope<T>, cookie };
}

async function me(instance: Instance, headers: Sent): Promise<SessionInfo | number> {
	const response = await fetch(`${instance.url}/api/session`, { headers });
	const body = (await response.json()) as Envelope<SessionInfo>;
	return body.ok ? body.result : response.status;
}

const names = async (instance: Instance): Promise<string[]> =>
	(await pgRows<{ name: string }>(instance.app, "SELECT name FROM actors ORDER BY id", [])).map((row) => row.name);

/**
 * One round through the provider as `subject`: `body` begins it (`{}` to sign in, `{ link: true }` to link), from a
 * browser holding `cookie`. The reply to the provider's answer.
 */
async function viaProvider(instance: Instance, idp: Provider, subject: string, body: unknown, cookie = "") {
	const begun = await post<{ url: string }>(instance, "/api/login/oidc", body, cookie ? { cookie } : {});
	if (!begun.body.ok) throw new Error(`the ceremony did not begin: ${begun.status}`);
	idp.next({ subject });
	const answer = await fetch(begun.body.result.url, { redirect: "manual" });
	const query = new URL(answer.headers.get("location") ?? "").search;
	return await post(
		instance,
		"/api/login",
		{ oidc: query },
		{ cookie: [cookie, begun.cookie].filter(Boolean).join("; ") },
	);
}

/**
 * An instance whose owner `robin` has a browser session, an identity at the provider and a token they made for
 * `sam`, stopped.
 */
async function asRobin(dataDir: string, idp?: Provider): Promise<{ cookie: string }> {
	const first = await boot({ dataDir, owner: "robin", ...(idp ? { idp } : {}) });
	const { cookie } = await post(first, "/api/login", { token: TOKEN });
	// The first identity is linked without a proof: there is nothing yet to prove it with but the token.
	if (idp) expect((await viaProvider(first, idp, "sub-robin", { link: true }, cookie)).status).toBe(200);
	const made = await post(
		first,
		"/api/admin",
		{ do: "token.create", actor: "sam", kind: "human", can: ["read"] },
		bearer,
	);
	expect(made.status).toBe(200);
	await first.stop();
	return { cookie };
}

test("a start that names the owner's former name renames that person: their token, session, identity and history go with them", async () => {
	const dataDir = scratch();
	const idp = await provider();
	const { cookie } = await asRobin(dataDir, idp);

	const second = await boot({ dataDir, owner: "rowan", ownerWas: "robin", idp });
	expect(said(second)).toEqual([
		"MAINWORTHY_OWNER_WAS: robin is now rowan, with the tokens, identities, sessions and history robin had. rowan signs in under the new name. Unset MAINWORTHY_OWNER_WAS.",
	]);
	expect(await names(second)).toEqual(["policy", "rowan", "sam"]);
	// The token from the variable and the session opened before the rename are the same person's, and that
	// person owns the instance.
	for (const headers of [bearer, { cookie }]) {
		expect(await me(second, headers)).toMatchObject({
			actor: "rowan",
			owner: true,
			credentials: { identities: 1 },
			can: ["read", "record", "produce", "answer", "plan", "admin"],
		});
	}
	// The identity robin linked signs in rowan.
	const again = await viaProvider(second, idp, "sub-robin", {});
	expect(again.status).toBe(200);
	expect(await me(second, { cookie: again.cookie })).toMatchObject({ actor: "rowan", owner: true });
	// What the person did before says the new name.
	const tokens = await post<{ actor: string; createdBy: string | null }[]>(
		second,
		"/api/admin",
		{ do: "token.list" },
		bearer,
	);
	expect(tokens.body.ok && tokens.body.result.map((row) => [row.actor, row.createdBy])).toEqual([
		["rowan", null],
		["sam", "rowan"],
	]);
	await second.stop();

	// The variable left in place renames nobody and makes nobody, and the start says to take it out.
	const third = await boot({ dataDir, owner: "rowan", ownerWas: "robin", idp });
	expect(said(third)).toEqual([
		"MAINWORTHY_OWNER_WAS names robin and renamed nobody: rowan is on this instance already. Unset MAINWORTHY_OWNER_WAS.",
	]);
	expect(await names(third)).toEqual(["policy", "rowan", "sam"]);
	expect(await me(third, bearer)).toMatchObject({ actor: "rowan", owner: true });
});

test("the former name must be a person who is there to rename, or the start is refused and nothing changes", async () => {
	const dataDir = scratch();
	await asRobin(dataDir);
	const refused = (ownerWas: string, why: string): void => {
		expect(async () => await boot({ dataDir, owner: "rowan", ownerWas })).toThrow(
			`MAINWORTHY_OWNER_WAS names ${ownerWas}, ${why}. Set it to the name the owner has now, or unset it to make rowan a new person who owns this instance, and start again${UNCHANGED}`,
		);
	};
	// A name that was mistyped would otherwise make a second owner, and the rename could not be done after it.
	refused("robn", "and nobody on this instance has that name");
	refused("policy", "which is the policy's own actor on this instance and not a person");
	// Somebody else's name: sam would be renamed, and made the owner beside robin. The owner is told apart by
	// what every start gives them.
	refused("sam", "who does not own this instance: the owner holds every capability on every project");
	// The new name is one a person can be given, as it is for anybody else.
	for (const owner of ["ro wan", "rowan\nextra", "r".repeat(65), "-rowan"]) {
		expect(async () => await boot({ dataDir, owner, ownerWas: "robin" })).toThrow(
			`MAINWORTHY_OWNER is ${JSON.stringify(owner)}, which is not a name a person can be given: letters, digits and . _ @ -, starting with a letter or a digit, 64 characters at most. Set MAINWORTHY_OWNER to the owner's new name and start again${UNCHANGED}`,
		);
	}

	const again = await boot({ dataDir, owner: "robin" });
	expect(
		(await post(again, "/api/admin", { do: "token.create", actor: "builder", kind: "agent" }, bearer)).status,
	).toBe(200);
	expect((await post(again, "/api/admin", { do: "actor.forget", name: "sam" }, bearer)).status).toBe(200);
	await again.stop();
	refused("builder", "which is an agent on this instance and not a person");
	refused("forgotten-3", "who was forgotten");

	// Every refusal left the instance as it was: the owner is robin, by the same token.
	const last = await boot({ dataDir, owner: "robin" });
	expect(await names(last)).toEqual(["policy", "robin", "forgotten-3", "builder"]);
	expect([said(last), await me(last, bearer)]).toMatchObject([[], { actor: "robin", owner: true }]);
});

test("a former name beside a new name that somebody holds renames nobody, and an empty one is one that was not set", async () => {
	const dataDir = scratch();
	await asRobin(dataDir);
	// sam exists: the start makes sam the owner as it does without the variable, and robin stays robin.
	const second = await boot({ dataDir, owner: "sam", ownerWas: "robin" });
	expect(said(second)).toContain(
		"MAINWORTHY_OWNER_WAS names robin and renamed nobody: sam is on this instance already. Unset MAINWORTHY_OWNER_WAS.",
	);
	expect(await names(second)).toEqual(["policy", "robin", "sam"]);
	await second.stop();

	// A compose file passes on a variable that is set and empty.
	expect(defaultConfig({ MAINWORTHY_OWNER_WAS: "" })).not.toHaveProperty("ownerWas");
	expect(defaultConfig({ MAINWORTHY_OWNER_WAS: "robin" }).ownerWas).toBe("robin");
	// The same name twice asks for nothing.
	const fourth = await boot({ dataDir, owner: "robin", ownerWas: "robin" });
	expect(said(fourth)).toEqual([
		"MAINWORTHY_OWNER_WAS names robin and renamed nobody: robin is on this instance already. Unset MAINWORTHY_OWNER_WAS.",
	]);
});

test("in local mode the owner of the machine is renamed the same way", async () => {
	const dataDir = scratch();
	const first = await boot({ dataDir, owner: "robin", mode: "local" });
	expect(await me(first, {})).toMatchObject({ actor: "robin" });
	await first.stop();
	const second = await boot({ dataDir, owner: "rowan", ownerWas: "robin", mode: "local" });
	expect(said(second)).toEqual([expect.stringContaining("robin is now rowan")]);
	expect([await names(second), await me(second, {})]).toMatchObject([
		["policy", "rowan"],
		{ actor: "rowan", owner: true },
	]);
});
