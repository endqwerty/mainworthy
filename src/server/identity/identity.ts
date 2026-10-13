// Actors, grants and tokens, and who a request is. Owns the tables `orgs`, `actors`, `grants` and `tokens`.
// There is no seat here: an actor is a free row with capabilities (principle P8).
//
// This file is the interface of the module. `sessions.ts` (the table `sessions`) and `uses.ts` (when a token or a
// session was last used) are its other files, and nothing outside this directory imports them: a surface asks
// `admit` who a request is, and signs a browser in and out through `signInWithToken` and `signOut`.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type ActorKind, Capability, heldCapabilities, whyNotGrantable } from "../../core/kinds.ts";
import type { App } from "../kernel/app.ts";
import type { Actor } from "../kernel/ctx.ts";
import { type Db, json, sql } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";
import { endSession, endSessionsOf, findSession, hasUnendedSession, openSession, sweepSessions } from "./sessions.ts";
import { clearUses, flushUses, notedUse, noteUse } from "./uses.ts";

// What the server's start and the archive need of the module's other files.
export { clearUses, flushUses, sweepSessions };

type ActorRow = { id: number; org: number; kind: ActorKind; name: string; disabled_at: number | null };

const Q = {
	org: sql<readonly [], { id: number }>("SELECT id FROM orgs ORDER BY id LIMIT 1"),
	insertOrg: sql<{ name: string; at: number }>("INSERT INTO orgs (name, created_at) VALUES ($name, $at)"),
	actorByName: sql<{ org: number; name: string }, ActorRow>("SELECT * FROM actors WHERE org = $org AND name = $name"),
	actorById: sql<{ id: number }, ActorRow>("SELECT * FROM actors WHERE id = $id"),
	insertActor: sql<{ org: number; kind: string; name: string; behalf: number | null; at: number }>(
		"INSERT INTO actors (org, kind, name, on_behalf_of, created_at) VALUES ($org, $kind, $name, $behalf, $at)",
	),
	actors: sql<{ org: number }, ActorRow & { created_at: number }>("SELECT * FROM actors WHERE org = $org ORDER BY id"),
	grants: sql<{ actor: number }, { project: number; can: string }>(
		"SELECT project, can FROM grants WHERE actor = $actor ORDER BY project",
	),
	dropGrant: sql<{ actor: number; project: number }>("DELETE FROM grants WHERE actor = $actor AND project = $project"),
	setGrant: sql<{ actor: number; project: number; can: string }>(
		`INSERT INTO grants (actor, project, can) VALUES ($actor, $project, $can)
		 ON CONFLICT (actor, project) DO UPDATE SET can = excluded.can`,
	),
	tokenByHash: sql<{ hash: string }, { id: number; actor: number; revoked_at: number | null }>(
		"SELECT id, actor, revoked_at FROM tokens WHERE hash = $hash",
	),
	insertToken: sql<{ actor: number; hash: string; label: string; at: number }>(
		"INSERT INTO tokens (actor, hash, label, created_at) VALUES ($actor, $hash, $label, $at)",
	),
	tokenById: sql<{ id: number }, { actor: number; revoked_at: number | null }>(
		"SELECT actor, revoked_at FROM tokens WHERE id = $id",
	),
	activeTokens: sql<{ actor: number }, { n: number }>(
		"SELECT count(*) AS n FROM tokens WHERE actor = $actor AND revoked_at IS NULL",
	),
	tokens: sql<
		{ org: number },
		{
			id: number;
			actor: string;
			kind: string;
			label: string;
			created_at: number;
			last_used_at: number | null;
			revoked_at: number | null;
		}
	>(
		`SELECT t.id, a.name AS actor, a.kind, t.label, t.created_at, t.last_used_at, t.revoked_at
		 FROM tokens t JOIN actors a ON a.id = t.actor WHERE a.org = $org ORDER BY t.id`,
	),
	revokeToken: sql<{ id: number; at: number }>(
		"UPDATE tokens SET revoked_at = $at WHERE id = $id AND revoked_at IS NULL",
	),
	revokeTokensOf: sql<{ actor: number; at: number }>(
		"UPDATE tokens SET revoked_at = $at WHERE actor = $actor AND revoked_at IS NULL",
	),
	forget: sql<{ id: number; name: string; at: number }>(
		"UPDATE actors SET name = $name, disabled_at = $at WHERE id = $id",
	),
};

export const ALL_CAPABILITIES: readonly Capability[] = Capability.options;
/** The actor that stands for the project's own policy when a rule clause answers a question. */
export const RULE_ACTOR = "policy";

/** What an actor of each kind is called in a sentence written for a person. */
export const KIND_NOUN: Record<ActorKind, string> = {
	human: "a person",
	agent: "an agent",
	ci: "a pipeline",
	rule: "the policy's own actor",
};

/**
 * `forgotten-<id>` is what history calls an actor that was forgotten. Nobody is given such a name, by a token or
 * as the owner at start-up: every view would read them as somebody who is gone, and the actor with that id could
 * then not be forgotten.
 */
const isForgottenName = (name: string): boolean => /^forgotten-/i.test(name);

export const hashToken = (secret: string): string => bytesToHex(sha256(new TextEncoder().encode(secret)));

function newSecret(): string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
	let out = "cb_";
	for (const byte of randomBytes(32)) out += alphabet[byte % alphabet.length];
	return out;
}

export function orgId(db: Db): number {
	const row = db.get(Q.org);
	if (!row) throw new Error("no organisation; the instance was not bootstrapped");
	return row.id;
}

/**
 * Every start: one organisation, the rule actor and the owner, with every capability and, in server mode, a way
 * in. Idempotent.
 *
 * The owner is the actor the configuration names, and it is a person: a name that is an agent's, a pipeline's or
 * the policy's on this instance is refused, and nothing is granted. (The name comes from a variable; one that was
 * lost or renamed must not turn a token that reads one project into the administrator of the instance.)
 *
 * `generatedToken` is the owner's token when this call made one: in server mode, with none configured, whenever
 * the owner holds no token that works, which is the first start and the start after an import. `warnings` are
 * for the operator, one line each: a configured token that signs the owner in no more is said, not revived.
 */
export function bootstrap(app: App): { owner: Actor; generatedToken: string | null; warnings: string[] } {
	return app.db.transaction(() => {
		const at = app.now();
		if (!app.db.get(Q.org)) app.db.run(Q.insertOrg, { name: "default", at });
		const org = orgId(app.db);
		ensureActor(app.db, { org, kind: "rule", name: RULE_ACTOR, at });
		if (isForgottenName(app.config.owner)) {
			throw invalid(
				`MAINWORTHY_OWNER names ${app.config.owner}, and a name that starts with forgotten- is what a forgotten actor is called. Set MAINWORTHY_OWNER to the owner's name and start again; nothing was changed`,
			);
		}
		const existing = app.db.get(Q.actorByName, { org, name: app.config.owner });
		if (existing && existing.kind !== "human") {
			throw invalid(
				`MAINWORTHY_OWNER names ${existing.name}, which is ${KIND_NOUN[existing.kind]} on this instance and not a person. Set MAINWORTHY_OWNER to the owner's name and start again; nothing was changed`,
			);
		}
		const owner = existing ?? ensureActor(app.db, { org, kind: "human", name: app.config.owner, at });
		// Written on every start, so the owner of the instance is never left without the means to repair it.
		app.db.run(Q.setGrant, { actor: owner.id, project: 0, can: JSON.stringify(ALL_CAPABILITIES) });
		const server = app.config.mode === "server";
		const warnings: string[] = [];
		let generatedToken: string | null = null;
		if (app.config.ownerToken) {
			const row = app.db.get(Q.tokenByHash, { hash: hashToken(app.config.ownerToken) });
			if (!row) {
				app.db.run(Q.insertToken, {
					actor: owner.id,
					hash: hashToken(app.config.ownerToken),
					label: "owner (from MAINWORTHY_OWNER_TOKEN)",
					at,
				});
			} else if (server && (row.revoked_at !== null || row.actor !== owner.id)) {
				// A token that was revoked stays revoked, and one that is somebody else's stays theirs: bringing it
				// back, or handing it to the owner, would undo a decision somebody made. The operator is told, because
				// the start otherwise looks like any other and the owner is left outside.
				const why =
					row.actor !== owner.id
						? `is the token of ${app.db.get(Q.actorById, { id: row.actor })?.name ?? "another actor"}, not of the owner ${owner.name}`
						: "was revoked";
				warnings.push(
					`MAINWORTHY_OWNER_TOKEN ${why}: it does not sign ${owner.name} in, and it was left as it is. Set MAINWORTHY_OWNER_TOKEN to a new value and start again.`,
				);
			}
		} else if (server && (app.db.get(Q.activeTokens, { actor: owner.id })?.n ?? 0) === 0) {
			generatedToken = newSecret();
			app.db.run(Q.insertToken, { actor: owner.id, hash: hashToken(generatedToken), label: "owner (generated)", at });
		}
		return { owner: toActor(app.db, owner, 0), generatedToken, warnings };
	});
}

function ensureActor(db: Db, input: { org: number; kind: ActorKind; name: string; at: number }): ActorRow {
	const found = db.get(Q.actorByName, { org: input.org, name: input.name });
	if (found) return found;
	const { lastId } = db.run(Q.insertActor, {
		org: input.org,
		kind: input.kind,
		name: input.name,
		behalf: null,
		at: input.at,
	});
	return { id: lastId, org: input.org, kind: input.kind, name: input.name, disabled_at: null };
}

function toActor(db: Db, row: ActorRow, project: number): Actor {
	const granted: Capability[] = [];
	for (const grant of db.all(Q.grants, { actor: row.id })) {
		if (grant.project !== 0 && grant.project !== project) continue;
		granted.push(...json<Capability[]>(grant.can));
	}
	return { id: row.id, kind: row.kind, name: row.name, can: heldCapabilities(row.kind, granted) };
}

/**
 * The token with this hash and its actor's row, when the token works and the actor stands. On the reader: a
 * request is admitted before it queues at the write gate, and must not touch the writing connection while another
 * command's transaction is open on it.
 */
function standingToken(db: Db, hash: string): { id: number; actor: ActorRow } | null {
	const token = db.get(Q.tokenByHash, { hash });
	if (!token || token.revoked_at !== null) return null;
	const actor = db.get(Q.actorById, { id: token.actor });
	if (!actor || actor.disabled_at !== null) return null;
	return { id: token.id, actor };
}

/**
 * The actor behind a token, with its capabilities on `project` (0 for an operation that is not about a project).
 * For the tests' harness and for code that holds a token and no request; a surface asks `admit`.
 */
export function authenticate(app: App, secret: string, project: number): Actor | null {
	const token = standingToken(app.reader, hashToken(secret));
	return token ? toActor(app.reader, token.actor, project) : null;
}

/**
 * A caller that was let in. It holds no secret. `actor` asks again each time it is called, so an operation that
 * waited at the gate, and a change stream opened an hour ago, stop when the token was revoked, the session ended
 * or the actor was forgotten. Asking is not a use: only `admit` notes one.
 */
export type Session = {
	/** How the caller proved itself. `cookie` is a browser's session; `local` is the owner of this machine. */
	via: "token" | "cookie" | "local";
	/** The caller on a project (0: the instance) as it stands now, or null once it stands no more. */
	actor: (project: number) => Actor | null;
};

/**
 * What a surface read from a request, as plain values: no header names and no cookie syntax. The surface says
 * what the request carried; what that is worth is decided here.
 */
export type Facts = {
	/** The secret the request presented as a token, or null when it presented none. */
	bearer: string | null;
	/** The value of this server's session cookie, or null when the request carries none it could read. */
	cookie: string | null;
	/**
	 * Whether the request may use what a browser attaches by itself: it comes from this server's own page, or
	 * from no page at all. A cookie and the loopback rule count only then; a token is not held to it.
	 */
	sameOrigin: boolean;
	/** The owner of this machine when the request started on it, else null. Counts in local mode only. */
	localOwner: Actor | null;
};

export type Admission = { kind: "admitted"; session: Session } | { kind: "refused" };
const REFUSED: Admission = { kind: "refused" };

/**
 * Who a request is: the one question every surface asks, once for each request. It reads committed rows on the
 * reader and writes nothing, so it never waits for a writer.
 *
 * A token, when one is presented, and nothing else then: a wrong token is not rescued by a cookie. Else, for a
 * request from this server's own page, the session its cookie names. Else, in local mode, the owner of the
 * machine the request started on.
 *
 * The use is noted only after the caller passed, against the newest use known until then. A cookie that is past
 * its idle time is refused however often it is sent: it cannot renew itself.
 */
export function admit(app: App, facts: Facts): Admission {
	if (facts.bearer !== null) {
		const hash = hashToken(facts.bearer);
		const token = standingToken(app.reader, hash);
		if (!token) return REFUSED;
		noteUse(app, "token", token.id, app.now());
		return {
			kind: "admitted",
			session: {
				via: "token",
				actor: (project) => {
					const standing = standingToken(app.reader, hash);
					return standing ? toActor(app.reader, standing.actor, project) : null;
				},
			},
		};
	}
	if (!facts.sameOrigin) return REFUSED;
	if (facts.cookie !== null) {
		const hash = hashToken(facts.cookie);
		const found = findSession(app, hash);
		if (found) {
			noteUse(app, "session", found.id, app.now());
			return {
				kind: "admitted",
				session: {
					via: "cookie",
					actor: (project) => {
						const standing = findSession(app, hash);
						return standing ? toActor(app.reader, standing.actor, project) : null;
					},
				},
			};
		}
	}
	const owner = app.config.mode === "local" ? facts.localOwner : null;
	return owner ? { kind: "admitted", session: { via: "local", actor: () => owner } } : REFUSED;
}

/** What a browser is given at sign-in: the cookie's value, and when the session it names ends at the latest. */
export type SignedIn = { cookie: string; expiresAt: number };

/** 32 random bytes as a cookie can carry them: 43 characters of base64url, with no padding. */
const newSessionSecret = (): string => Buffer.from(randomBytes(32)).toString("base64url");

/**
 * Signs a browser in with a token: opens a session whose secret is new and is not the token. The browser never
 * holds the token again, and only the SHA-256 of what it does hold is stored.
 *
 * Null, at once, when the token does not work: the caller answers without waiting. Otherwise a promise, because
 * the session is written at the gate. That write looks the token up again by its hash (`openSession`), and the
 * promise is null when the token stopped working while the request waited: it was revoked, or an import
 * replaced every token. Nothing read before the wait is trusted after it. The token's id, in particular, is
 * not carried across: after an import a new token holds it.
 */
export function signInWithToken(
	app: App,
	secret: string,
	about: { userAgent: string | null },
): Promise<SignedIn | null> | null {
	const tokenHash = hashToken(secret);
	const token = standingToken(app.reader, tokenHash);
	if (!token) return null;
	// The use is of the token as it stands now, noted before any wait. An import clears the notes when it commits.
	noteUse(app, "token", token.id, app.now());
	const cookie = newSessionSecret();
	return app.gate.run(() => {
		const opened = openSession(app, {
			tokenHash,
			sessionHash: hashToken(cookie),
			// What the client calls itself, for a person looking at their own sessions. Never trusted, and cut:
			// the header is as long as its sender likes.
			userAgent: about.userAgent?.slice(0, 256) ?? null,
		});
		return opened ? { cookie, expiresAt: opened.expiresAt } : null;
	});
}

/**
 * Ends the session a cookie names. Null when it names none that is still open: nothing is written and the caller
 * answers at once, which makes signing out twice the same as signing out once. Otherwise the promise settles when
 * the end is committed, so the caller's reply leaves after it: a copy of the cookie is refused from then on.
 */
export function signOut(app: App, cookie: string): Promise<void> | null {
	const hash = hashToken(cookie);
	if (!hasUnendedSession(app.reader, hash)) return null;
	return app.gate.run(() => {
		endSession(app, hash, "signed-out");
	});
}

export function actorByName(db: Db, name: string, project: number): Actor | null {
	const row = db.get(Q.actorByName, { org: orgId(db), name });
	return row ? toActor(db, row, project) : null;
}

export function actorById(db: Db, id: number, project: number): Actor {
	const row = db.get(Q.actorById, { id });
	if (!row) throw notFound(`actor ${id}`);
	return toActor(db, row, project);
}

export function ruleActor(db: Db): Actor {
	const actor = actorByName(db, RULE_ACTOR, 0);
	if (!actor) throw new Error("the rule actor is missing; the instance was not bootstrapped");
	return actor;
}

// Names are kept per connection, and a server has more than one (it writes on one and reads on another). The
// one thing that changes a name is forgetting a person: that raises `forgottenCount`, and every connection's names
// read before it are thrown away, so no read on any connection shows a forgotten name again.
let forgottenCount = 0;
const labels = new WeakMap<Db, { since: number; names: Map<number, { name: string; kind: ActorKind }> }>();
/** An actor's name and kind for display. Cached per connection until a person is forgotten. */
export function actorLabel(db: Db, id: number): { name: string; kind: ActorKind } {
	let kept = labels.get(db);
	if (!kept || kept.since !== forgottenCount) {
		kept = { since: forgottenCount, names: new Map() };
		labels.set(db, kept);
	}
	const names = kept.names;
	const cached = names.get(id);
	if (cached) return cached;
	const row = db.get(Q.actorById, { id });
	if (!row) return { name: `actor ${id}`, kind: "human" };
	const label = { name: row.name, kind: row.kind };
	names.set(id, label);
	return label;
}

/**
 * Creates a token, and the actor it names if that actor does not exist. The secret is returned once and never
 * stored. A token carries its actor's grants: `can` on `project` is what a new actor starts with. An actor that
 * exists keeps what it has: naming the grant it already holds there is accepted, anything else is refused, and
 * `setGrant` is the one way to change it. An actor that was forgotten gets none.
 */
export function createToken(
	app: App,
	input: { actor: string; kind: ActorKind; can: readonly Capability[]; project: number; label: string },
): { secret: string; actor: string } {
	if (input.kind === "rule") throw invalid("a rule does not hold a token");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,63}$/.test(input.actor)) throw invalid("actor name: letters, digits, . _ @ -");
	if (isForgottenName(input.actor))
		throw invalid("actor name: a name that starts with forgotten- is what a forgotten actor is called; choose another");
	const db = app.db;
	const org = orgId(db);
	const at = app.now();
	const existing = db.get(Q.actorByName, { org, name: input.actor });
	if (existing && existing.kind !== input.kind) {
		throw conflict(`actor ${input.actor} exists and is a ${existing.kind}, not a ${input.kind}`);
	}
	if (existing && existing.disabled_at !== null) throw invalid(`actor ${input.actor} was forgotten and holds no token`);
	if (existing && input.can.length > 0 && !sameGrant(db, existing.id, input.project, input.can)) {
		throw invalid(
			`actor ${input.actor} exists: a new token carries what it may already do. Change that with grant.set (mainworthy actor grant)`,
		);
	}
	refuseGrant(input.kind, input.can);
	const actor = existing ?? ensureActor(db, { org, kind: input.kind, name: input.actor, at });
	if (!existing && input.can.length > 0)
		db.run(Q.setGrant, { actor: actor.id, project: input.project, can: JSON.stringify(input.can) });
	const secret = newSecret();
	db.run(Q.insertToken, { actor: actor.id, hash: hashToken(secret), label: input.label, at });
	return { secret, actor: actor.name };
}

/** Whether the actor's grant on exactly this project lists exactly these capabilities. */
function sameGrant(db: Db, actor: number, project: number, can: readonly Capability[]): boolean {
	const held = db.all(Q.grants, { actor }).find((grant) => grant.project === project);
	const stored = new Set(held ? json<Capability[]>(held.can) : []);
	return stored.size === new Set(can).size && can.every((capability) => stored.has(capability));
}

function refuseGrant(kind: ActorKind, can: readonly Capability[]): void {
	const why = whyNotGrantable(kind, can);
	if (why) throw invalid(why);
}

function mustActor(db: Db, name: string): ActorRow {
	const row = db.get(Q.actorByName, { org: orgId(db), name });
	if (!row || row.disabled_at !== null) throw notFound(`actor ${name}`);
	return row;
}

/** Replaces what an actor may do on one project (0: on every project). The one way to change a grant. */
export function setGrant(app: App, input: { actor: string; project: number; can: readonly Capability[] }): void {
	const row = mustActor(app.db, input.actor);
	refuseGrant(row.kind, input.can);
	app.db.run(Q.setGrant, { actor: row.id, project: input.project, can: JSON.stringify(input.can) });
}

/** Takes away an actor's grant on one project (0: its grant on every project). False when it held none there. */
export function removeGrant(app: App, input: { actor: string; project: number }): boolean {
	const row = mustActor(app.db, input.actor);
	return app.db.run(Q.dropGrant, { actor: row.id, project: input.project }).changes > 0;
}

/**
 * Every token of the instance. `last_used_at` is the newer of the row and what is noted and not yet written
 * (`uses.ts`), so a use shows in the list at once and not a minute later.
 */
export function listTokens(app: App) {
	const db = app.reader;
	return db.all(Q.tokens, { org: orgId(db) }).map((row) => {
		const noted = notedUse(app, "token", row.id);
		return noted === null ? row : { ...row, last_used_at: Math.max(row.last_used_at ?? 0, noted) };
	});
}

/**
 * The name of the actor that this token is the last way in for: the token works, and its actor holds no other
 * that does. Null for any other token, and for an id that names none.
 */
export function lastTokenOf(db: Db, id: number): string | null {
	const token = db.get(Q.tokenById, { id });
	if (!token || token.revoked_at !== null) return null;
	if ((db.get(Q.activeTokens, { actor: token.actor })?.n ?? 0) > 1) return null;
	return db.get(Q.actorById, { id: token.actor })?.name ?? null;
}

export function revokeToken(app: App, id: number): boolean {
	return app.db.run(Q.revokeToken, { id, at: app.now() }).changes > 0;
}

/**
 * Removes an actor's identity and keeps the record true: the name becomes a pseudonym, the actor is disabled, its
 * tokens are revoked and its sessions are ended. Every fact still points at the same actor row, so history says
 * the same actor did each thing; it no longer says who that was. Text the person typed elsewhere is not touched
 * (docs/compliance.md).
 */
export function forgetActor(app: App, name: string): { forgotten: string; tokensRevoked: number } {
	const db = app.db;
	const row = db.get(Q.actorByName, { org: orgId(db), name });
	if (!row) throw notFound(`actor ${name}`);
	if (row.kind === "rule") throw invalid("the policy's own actor cannot be forgotten");
	const pseudonym = `forgotten-${row.id}`;
	const at = app.now();
	db.run(Q.forget, { id: row.id, name: pseudonym, at });
	const revoked = db.run(Q.revokeTokensOf, { actor: row.id, at }).changes;
	// A disabled actor's sessions are refused anyway. Ending them says why in each row, and keeps them ended if
	// the row of the actor is ever changed by hand.
	endSessionsOf(db, row.id, at);
	forgottenCount++;
	return { forgotten: pseudonym, tokensRevoked: revoked };
}

/** Every actor with each of its grants: the project (0 for every project) and what the actor holds there by it. */
export function listActors(db: Db) {
	return db.all(Q.actors, { org: orgId(db) }).map((row) => ({
		name: row.name,
		kind: row.kind,
		disabled: row.disabled_at !== null,
		createdAt: row.created_at,
		grants: db.all(Q.grants, { actor: row.id }).map((grant) => ({
			project: grant.project,
			can: heldCapabilities(row.kind, json<Capability[]>(grant.can)),
		})),
	}));
}
