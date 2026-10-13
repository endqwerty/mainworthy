// Actors, grants and tokens. Owns the tables `orgs`, `actors`, `grants` and `tokens`.
// There is no seat here: an actor is a free row with capabilities (principle P8).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { type ActorKind, Capability, heldCapabilities, whyNotGrantable } from "../../core/kinds.ts";
import type { App } from "../kernel/app.ts";
import type { Actor } from "../kernel/ctx.ts";
import { type Db, json, sql } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";

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
	touchToken: sql<{ id: number; at: number }>("UPDATE tokens SET last_used_at = $at WHERE id = $id"),
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
 * First start: one organisation, the rule actor and the owner. Idempotent.
 * Returns the owner's token only when it was created on this call and the operator did not supply one.
 */
export function bootstrap(app: App): { owner: Actor; generatedToken: string | null } {
	return app.db.transaction(() => {
		const at = app.now();
		if (!app.db.get(Q.org)) app.db.run(Q.insertOrg, { name: "default", at });
		const org = orgId(app.db);
		ensureActor(app.db, { org, kind: "rule", name: RULE_ACTOR, at });
		const existing = app.db.get(Q.actorByName, { org, name: app.config.owner });
		const owner = existing ?? ensureActor(app.db, { org, kind: "human", name: app.config.owner, at });
		// Written on every start, so the owner of the instance is never left without the means to repair it.
		app.db.run(Q.setGrant, { actor: owner.id, project: 0, can: JSON.stringify(ALL_CAPABILITIES) });
		let generatedToken: string | null = null;
		if (app.config.ownerToken) {
			const hash = hashToken(app.config.ownerToken);
			if (!app.db.get(Q.tokenByHash, { hash })) {
				app.db.run(Q.insertToken, { actor: owner.id, hash, label: "owner (from CASEBOOK_OWNER_TOKEN)", at });
			}
		} else if (!existing && app.config.mode === "server") {
			generatedToken = newSecret();
			app.db.run(Q.insertToken, { actor: owner.id, hash: hashToken(generatedToken), label: "owner (generated)", at });
		}
		return { owner: toActor(app.db, owner, 0), generatedToken };
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

/** The actor behind a token, with its capabilities on `project` (0 for an operation that is not about a project). */
export function authenticate(app: App, secret: string, project: number): Actor | null {
	// On the reader: a request is authenticated before it queues at the write gate, and must not touch the
	// writing connection while another command's transaction is open on it.
	const db = app.reader;
	const token = db.get(Q.tokenByHash, { hash: hashToken(secret) });
	if (!token || token.revoked_at !== null) return null;
	const row = db.get(Q.actorById, { id: token.actor });
	if (!row || row.disabled_at !== null) return null;
	return toActor(db, row, project);
}

/** Records that a token was used. Kept out of `authenticate` so a read never writes. */
export function noteTokenUse(app: App, secret: string): void {
	const token = app.reader.get(Q.tokenByHash, { hash: hashToken(secret) });
	if (token) app.db.run(Q.touchToken, { id: token.id, at: app.now() });
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
 * `setGrant` is the one way to change it.
 */
export function createToken(
	app: App,
	input: { actor: string; kind: ActorKind; can: readonly Capability[]; project: number; label: string },
): { secret: string; actor: string } {
	if (input.kind === "rule") throw invalid("a rule does not hold a token");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,63}$/.test(input.actor)) throw invalid("actor name: letters, digits, . _ @ -");
	const db = app.db;
	const org = orgId(db);
	const at = app.now();
	const existing = db.get(Q.actorByName, { org, name: input.actor });
	if (existing && existing.kind !== input.kind) {
		throw conflict(`actor ${input.actor} exists and is a ${existing.kind}, not a ${input.kind}`);
	}
	if (existing && input.can.length > 0 && !sameGrant(db, existing.id, input.project, input.can)) {
		throw invalid(
			`actor ${input.actor} exists: a new token carries what it may already do. Change that with grant.set (casebook actor grant)`,
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

export function listTokens(db: Db) {
	return db.all(Q.tokens, { org: orgId(db) });
}

export function revokeToken(app: App, id: number): boolean {
	return app.db.run(Q.revokeToken, { id, at: app.now() }).changes > 0;
}

/**
 * Removes an actor's identity and keeps the record true: the name becomes a pseudonym, the actor is disabled and
 * its tokens are revoked. Every fact still points at the same actor row, so history says the same actor did each
 * thing; it no longer says who that was. Text the person typed elsewhere is not touched (docs/compliance.md).
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
