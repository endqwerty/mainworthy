// Actors, grants and tokens, and who a request is. Owns the tables `orgs`, `actors`, `grants` and `tokens`.
// There is no seat here: an actor is a free row with capabilities (principle P8).
//
// This file is the interface of the module. `sessions.ts` (the table `sessions`), `uses.ts` (when a token or a
// session was last used) and `limiter.ts` with `attempts.ts` (the count of failed attempts) are its other files, and nothing outside
// this directory imports them: a surface asks `admit` who a request is, and signs a browser in and out through
// `signInWithToken` and `signOut`.
//
// A person signing in as themselves is in `people.ts`, with the tables under it in `credentials.ts` and
// `invitations.ts`. What other layers use of those is named once, below, and reached through this file too.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { untilPhrase } from "../../core/duration.ts";
import { type ActorKind, Capability, heldCapabilities, whyNotGrantable } from "../../core/kinds.ts";
import type { App } from "../kernel/app.ts";
import type { Actor } from "../kernel/ctx.ts";
import { type Db, json, sql } from "../kernel/db.ts";
import { conflict, invalid, notFound } from "../kernel/errors.ts";
import { limiterOf } from "./attempts.ts";
import { clearChallenges } from "./challenges.ts";
import { credentialSummary, dropUserHandle, revokeCredentialsOf } from "./credentials.ts";
import { listInvitations, revokeInvitation, revokeInvitationsOf } from "./invitations.ts";
import { addressKey, isGeneratedSecret, prefixKey } from "./limiter.ts";
import {
	endSession,
	endSessionById,
	endSessionsOf,
	findSession,
	hasUnendedSession,
	listSessions,
	newSessionSecret,
	openSession,
	sessionOwner,
	sweepSessions,
} from "./sessions.ts";
import { clearUses, flushUses, forgetNotedAddresses, lastAddress, notedUse, noteUse } from "./uses.ts";

export { whyNotPassword } from "./passwords.ts";
// What the sign-in routes and the operations of a signed-in person need of them.
export {
	type Accepted,
	acceptInvitation,
	addPasskey,
	beginPasskey,
	changePassword,
	createInvitation,
	credentialOwner,
	listCredentials,
	PASSKEYS_OFF,
	type PasswordChange,
	passkeySignInOptions,
	publicAddress,
	removeCredential,
	showInvitation,
	signInMethods,
	signInWithPasskey,
	signInWithPassword,
	type WhyNot,
} from "./people.ts";
// What the server's start and the archive need of the module's other files.
export {
	clearChallenges,
	clearUses,
	credentialSummary,
	endSessionById,
	flushUses,
	listInvitations,
	listSessions,
	revokeInvitation,
	sessionOwner,
	sweepSessions,
};

type ActorRow = { id: number; org: number; kind: ActorKind; name: string; disabled_at: number | null };
/** What decides whether a token works: whose it is, whether it was revoked, and when it ends (null: never). */
type TokenState = { actor: number; revoked_at: number | null; expires_at: number | null };
/**
 * Which start-up rule made a token. `env`: it is the value of `MAINWORTHY_OWNER_TOKEN`. `generated`: a start made
 * it because the owner held none. A token somebody made with `token.create` has no source.
 */
type TokenSource = "env" | "generated";

/** A token the owner chose and shorter than this stops the start. */
const OWNER_TOKEN_MIN = 20;
/**
 * The longest token a sign-in reads (`POST /api/login` takes its schema from here). A configured owner token that
 * is longer stops the start too: it would work as a bearer and never sign a browser in.
 */
export const TOKEN_MAX = 512;
/** One shorter than this starts, and every start says so. */
const OWNER_TOKEN_SOUND = 32;
/**
 * How the refusal of a start ends: what it left alone. Not "nothing": the database is opened, and brought to this
 * build's schema with a copy of it written beside it, before the owner and the owner's token are looked at.
 */
const START_REFUSED =
	"no actor and no token was changed (the database may have been brought to this build's schema first, with a copy of it as it was beside it)";
/** How long before a token ends the start names it. */
const ENDING_SOON_MS = 14 * 86_400_000;

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
	tokenByHash: sql<{ hash: string }, TokenState & { id: number; source: TokenSource | null }>(
		"SELECT id, actor, revoked_at, expires_at, source FROM tokens WHERE hash = $hash",
	),
	insertToken: sql<{
		actor: number;
		hash: string;
		label: string;
		at: number;
		expires: number | null;
		by: number | null;
		source: TokenSource | null;
	}>(
		`INSERT INTO tokens (actor, hash, label, created_at, expires_at, created_by, source)
		 VALUES ($actor, $hash, $label, $at, $expires, $by, $source)`,
	),
	tokenById: sql<{ id: number }, TokenState>("SELECT actor, revoked_at, expires_at FROM tokens WHERE id = $id"),
	// A token works when it was not revoked and the clock has not reached its end.
	activeTokens: sql<{ actor: number; now: number }, { n: number }>(
		`SELECT count(*) AS n FROM tokens
		 WHERE actor = $actor AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $now)`,
	),
	tokens: sql<
		{ org: number },
		{
			id: number;
			actor: string;
			kind: string;
			label: string;
			created_at: number;
			created_by: string | null;
			expires_at: number | null;
			last_used_at: number | null;
			last_used_addr: string | null;
			revoked_at: number | null;
		}
	>(
		`SELECT t.id, a.name AS actor, a.kind, t.label, t.created_at, maker.name AS created_by, t.expires_at,
			t.last_used_at, t.last_used_addr, t.revoked_at
		 FROM tokens t JOIN actors a ON a.id = t.actor LEFT JOIN actors maker ON maker.id = t.created_by
		 WHERE a.org = $org ORDER BY t.id`,
	),
	// The tokens that work now and stop working by `until`, each with the actor it signs in.
	endingTokens: sql<
		{ org: number; now: number; until: number },
		{ id: number; actor: string; label: string; expires_at: number }
	>(
		`SELECT t.id, a.name AS actor, t.label, t.expires_at
		 FROM tokens t JOIN actors a ON a.id = t.actor
		 WHERE a.org = $org AND t.revoked_at IS NULL AND t.expires_at > $now AND t.expires_at <= $until
		 ORDER BY t.expires_at, t.id`,
	),
	revokeToken: sql<{ id: number; at: number }>(
		"UPDATE tokens SET revoked_at = $at WHERE id = $id AND revoked_at IS NULL",
	),
	// Every token that came from the environment and was not revoked, with the actor it signs in: what a new value
	// there replaces. Whoever's it is, and not the owner's alone: the variable is one, the owner's name is another
	// variable, and when both change in one start the old value is the token of whoever was the owner before.
	envTokens: sql<readonly [], { id: number; actor: string }>(
		`SELECT t.id, a.name AS actor FROM tokens t JOIN actors a ON a.id = t.actor
		 WHERE t.source = 'env' AND t.revoked_at IS NULL ORDER BY t.id`,
	),
	revokeTokensOf: sql<{ actor: number; at: number }>(
		"UPDATE tokens SET revoked_at = $at WHERE actor = $actor AND revoked_at IS NULL",
	),
	// Every token of an actor, revoked or not, and the erasure of where each was last used from.
	tokensOf: sql<{ actor: number }, { id: number }>("SELECT id FROM tokens WHERE actor = $actor"),
	forgetAddresses: sql<{ actor: number }>("UPDATE tokens SET last_used_addr = NULL WHERE actor = $actor"),
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
 * the owner holds no token that works, which is the first start, the start after an import and the start after
 * the owner's last token ended. `warnings` are for the operator, one line each, and none holds a secret: a
 * configured token that signs the owner in no more (it was revoked, it reached its end, or it is somebody else's)
 * is said, not revived; so is one that is short, every token that a new value retired, and every token that ends
 * within 14 days, and a server that names no proxy, because behind one it cannot tell its visitors apart
 * (`NO_PROXY_NAMED`).
 *
 * The configured token is the one secret here that a person chose, and it opens everything. One shorter than 20
 * characters stops the start, and so does one longer than a sign-in reads, in local mode too: the value becomes a
 * token there as well. A start that is refused changes no actor and no token; the schema is another matter, and
 * the refusal says so (`START_REFUSED`).
 */
export function bootstrap(app: App): { owner: Actor; generatedToken: string | null; warnings: string[] } {
	const configured = app.config.ownerToken;
	if (configured && (configured.length < OWNER_TOKEN_MIN || configured.length > TOKEN_MAX)) {
		const why =
			configured.length < OWNER_TOKEN_MIN
				? `is shorter than ${OWNER_TOKEN_MIN} characters, and it opens everything on this instance`
				: `is longer than ${TOKEN_MAX} characters, and a sign-in reads no token longer than that`;
		throw invalid(
			`MAINWORTHY_OWNER_TOKEN ${why}. Make one with \`openssl rand -hex 32\`, set MAINWORTHY_OWNER_TOKEN to it and start again; ${START_REFUSED}`,
		);
	}
	return app.db.transaction(() => {
		const at = app.now();
		if (!app.db.get(Q.org)) app.db.run(Q.insertOrg, { name: "default", at });
		const org = orgId(app.db);
		ensureActor(app.db, { org, kind: "rule", name: RULE_ACTOR, at });
		if (isForgottenName(app.config.owner)) {
			throw invalid(
				`MAINWORTHY_OWNER names ${app.config.owner}, and a name that starts with forgotten- is what a forgotten actor is called. Set MAINWORTHY_OWNER to the owner's name and start again; ${START_REFUSED}`,
			);
		}
		const existing = app.db.get(Q.actorByName, { org, name: app.config.owner });
		if (existing && existing.kind !== "human") {
			throw invalid(
				`MAINWORTHY_OWNER names ${existing.name}, which is ${KIND_NOUN[existing.kind]} on this instance and not a person. Set MAINWORTHY_OWNER to the owner's name and start again; ${START_REFUSED}`,
			);
		}
		const owner = existing ?? ensureActor(app.db, { org, kind: "human", name: app.config.owner, at });
		// Written on every start, so the owner of the instance is never left without the means to repair it.
		app.db.run(Q.setGrant, { actor: owner.id, project: 0, can: JSON.stringify(ALL_CAPABILITIES) });
		const server = app.config.mode === "server";
		const warnings: string[] = [];
		let generatedToken: string | null = null;
		if (configured) {
			if (configured.length < OWNER_TOKEN_SOUND) {
				warnings.push(
					`MAINWORTHY_OWNER_TOKEN is shorter than ${OWNER_TOKEN_SOUND} characters. It signs ${owner.name} in as it is; a longer one is harder to guess. Make one with \`openssl rand -hex 32\`.`,
				);
			}
			const row = app.db.get(Q.tokenByHash, { hash: hashToken(configured) });
			if (!row) {
				// The variable holds a value that is not a token yet, so it was changed. What it held before is
				// retired here, in the transaction that makes the new one: an operator who replaces a value that
				// leaked expects the old one to stop working, and until now it worked for as long as its row.
				// That is every token marked `env`, whoever its actor is: there is one such variable, so at most
				// one of them should work, and the owner's name may have changed in this same start. The sessions
				// they opened end with them, because a session is read with its token.
				const retired = app.db.all(Q.envTokens);
				for (const token of retired) app.db.run(Q.revokeToken, { id: token.id, at });
				app.db.run(Q.insertToken, {
					actor: owner.id,
					hash: hashToken(configured),
					label: "owner (from MAINWORTHY_OWNER_TOKEN)",
					at,
					expires: null,
					by: null,
					source: "env",
				});
				if (retired.length > 0) {
					const named = retired.map((token) => `token ${token.id} of ${token.actor}`).join(", ");
					const held =
						retired.length === 1
							? `the token it held before (${named}) was revoked, and every session opened with it has ended`
							: `the tokens it held before (${named}) were revoked, and every session opened with them has ended`;
					warnings.push(`MAINWORTHY_OWNER_TOKEN has a new value: ${held}. Sign in with the new value.`);
				}
			} else if (server && (!works(row, at) || row.actor !== owner.id)) {
				// A token that was revoked stays revoked, one that reached its end stays ended, and one that is
				// somebody else's stays theirs: bringing it back, or handing it to the owner, would undo a decision
				// somebody made. The operator is told, because the start otherwise looks like any other and the
				// owner is left outside.
				// (The owner's token that works does not come here, so one that was not revoked has an end.)
				const why =
					row.actor !== owner.id
						? `is the token of ${app.db.get(Q.actorById, { id: row.actor })?.name ?? "another actor"}, not of the owner ${owner.name}`
						: row.revoked_at !== null || row.expires_at === null
							? "was revoked"
							: `reached its end at ${new Date(row.expires_at).toISOString()}`;
				warnings.push(
					`MAINWORTHY_OWNER_TOKEN ${why}: it does not sign ${owner.name} in, and it was left as it is. Set MAINWORTHY_OWNER_TOKEN to a new value and start again.`,
				);
			}
		} else if (server && (app.db.get(Q.activeTokens, { actor: owner.id, now: at })?.n ?? 0) === 0) {
			generatedToken = newSecret();
			app.db.run(Q.insertToken, {
				actor: owner.id,
				hash: hashToken(generatedToken),
				label: "owner (generated)",
				at,
				expires: null,
				by: null,
				source: "generated",
			});
		}
		// Nothing tells whoever holds a token that it is about to end, so the operator is told at each start. The
		// label is written as JSON: it is free text, and a warning is one line.
		for (const token of app.db.all(Q.endingTokens, { org, now: at, until: at + ENDING_SOON_MS })) {
			warnings.push(
				`token ${token.id} of ${token.actor} (${JSON.stringify(token.label)}) expires ${untilPhrase(token.expires_at, at)}, and what uses it is refused from then on. Make its replacement with \`mainworthy token new\`, and revoke this one once the replacement is in use.`,
			);
		}
		if (server && app.config.proxy === null) warnings.push(NO_PROXY_NAMED);
		return { owner: toActor(app.db, owner, 0), generatedToken, warnings };
	});
}

/**
 * What a start in server mode tells the operator when the configuration names no proxy. The server is then
 * reached directly, or through a proxy it does not know of. A request from a loopback or private address is
 * never counted by its address (`addressKey`), because behind a proxy that address is the proxy's and every
 * visitor shares it. Until the two variables say which peer is the proxy and where it writes the visitor's
 * address, a wrong token from such a request is counted with the others that begin as it does and with nothing
 * else, which does not slow somebody whose every guess begins differently.
 */
const NO_PROXY_NAMED =
	"MAINWORTHY_TRUSTED_PROXY and MAINWORTHY_CLIENT_ADDRESS_HEADER are not set: a failed sign-in from a loopback or private address, which behind a proxy is every visitor's, is not counted against that address, only against the first 8 characters of the token it tried. docs/deploy.md says how to set the two.";

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
 * Whether a token works at `now`: it was not revoked, and the clock has not reached its end. The one rule, for
 * a bearer, a sign-in and the question which token is an actor's last. (`sessions.ts`, `activeTokens` and
 * `endingTokens` say the same in SQL.) A token past its end is refused exactly as a revoked one is, and nothing
 * is written when that moment comes: the row keeps saying when it ended.
 */
const works = (token: TokenState, now: number): boolean =>
	token.revoked_at === null && (token.expires_at === null || now < token.expires_at);

/** A token that works, with its actor's row. `chosen`: its value came from the environment, so a person wrote it. */
type StandingToken = { id: number; actor: ActorRow; chosen: boolean };

/**
 * The token with this hash and its actor's row, when the token works and the actor stands. On the reader: a
 * request is admitted before it queues at the write gate, and must not touch the writing connection while another
 * command's transaction is open on it.
 */
function standingToken(db: Db, hash: string, now: number): StandingToken | null {
	const token = db.get(Q.tokenByHash, { hash });
	if (!token || !works(token, now)) return null;
	const actor = db.get(Q.actorById, { id: token.actor });
	if (!actor || actor.disabled_at !== null) return null;
	return { id: token.id, actor, chosen: token.source === "env" };
}

/**
 * The actor behind a token, with its capabilities on `project` (0 for an operation that is not about a project).
 * For the tests' harness and for code that holds a token and no request; a surface asks `admit`.
 */
export function authenticate(app: App, secret: string, project: number): Actor | null {
	const token = standingToken(app.reader, hashToken(secret), app.now());
	return token ? toActor(app.reader, token.actor, project) : null;
}

/**
 * A caller that was let in. It holds no secret. `actor` asks again each time it is called, so an operation that
 * waited at the gate, and a change stream opened an hour ago, stop when the token was revoked or reached its end,
 * the session ended or the actor was forgotten. Asking is not a use: only `admit` notes one.
 */
export type Session = {
	/** How the caller proved itself. `cookie` is a browser's session; `local` is the owner of this machine. */
	via: "token" | "cookie" | "local";
	/** The caller on a project (0: the instance) as it stands now, or null once it stands no more. */
	actor: (project: number) => Actor | null;
	/**
	 * For a browser's session (`cookie`): the id of its row as it stands now, or null once it has ended. It is
	 * how an operation knows which of the caller's sessions the request came by. A token and the owner of this
	 * machine have no such row.
	 */
	id?: () => number | null;
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
	/**
	 * The address the request came from, as the surface determined it: the connection's own, or the one a proxy
	 * the operator named reported. Null when the surface cannot tell (a request that never was on a connection).
	 * Failed attempts are counted against it, and it is noted with the use, so a person can see where a token or
	 * a session was last used from.
	 */
	address: string | null;
};

/** A caller that failed to prove itself too often, by its address or at this secret: `retryAfter` whole seconds. */
type Limited = { kind: "limited"; retryAfter: number };
export type Admission = { kind: "admitted"; session: Session } | { kind: "refused" } | Limited;
const REFUSED: Admission = { kind: "refused" };

type Presented = { kind: "standing"; token: StandingToken } | { kind: "refused" } | Limited;

/**
 * Looks at a secret that was presented as a token, under the limit on failed attempts. A bearer token and a
 * sign-in both come this way, so they are counted under the same keys: the caller's address and the first
 * characters of the secret. `limiter.ts` says what the rule is and why each line below is as it is.
 *
 * While a key is blocked nothing is reported, neither a failure nor a success, and a secret is not looked up,
 * with one exception: a secret in the form the server generates is looked up, and passes when it is right and
 * the server made it. The form alone does not say that. The owner's token from the environment is whatever the
 * operator wrote, and one written as `cb_` and 32 letters is still a person's choice and not 190 random bits:
 * its row says where it came from (`source`), and it gets no pass. It is answered as a wrong one is.
 *
 * A success outside a block clears the secret's own key and never the address's. A pass during a block clears
 * nothing: the block runs out by the clock.
 */
function present(app: App, secret: string, address: string | null): Presented {
	const limiter = limiterOf(app);
	const now = app.now();
	const prefix = prefixKey(secret);
	const keys = [addressKey(address), prefix].filter((key) => key !== null);
	const hash = hashToken(secret);
	const answer = limiter.check(keys, now);
	if (answer.kind === "blocked") {
		const token = isGeneratedSecret(secret) ? standingToken(app.reader, hash, now) : null;
		return token && !token.chosen
			? { kind: "standing", token }
			: { kind: "limited", retryAfter: answer.retryAfterSeconds };
	}
	// A sign-in reads no token longer than `TOKEN_MAX`, so a bearer is none either: a token must not work one way
	// and not the other. (An earlier build took an owner token of any length, and such a row is still there.) It
	// is counted like any other wrong token.
	const token = secret.length > TOKEN_MAX ? null : standingToken(app.reader, hash, now);
	if (!token) {
		limiter.failed(keys, now);
		return { kind: "refused" };
	}
	if (prefix !== null) limiter.succeeded([prefix]);
	return { kind: "standing", token };
}

/**
 * Who a request is: the one question every surface asks, once for each request. It reads committed rows on the
 * reader and writes nothing, so it never waits for a writer.
 *
 * A token, when one is presented, and nothing else then: a wrong token is not rescued by a cookie. Else, for a
 * request from this server's own page, the session its cookie names. Else, in local mode, the owner of the
 * machine the request started on.
 *
 * Only a token is held to the limit on failed attempts (`present`). A cookie is never counted, right or wrong:
 * it is 256 random bits that nobody guesses, and a browser that kept one after its session ended sends it with
 * every request. The owner of the machine proves nothing, so there is nothing to fail.
 *
 * The use is noted only after the caller passed, against the newest use known until then. A cookie that is past
 * its idle time is refused however often it is sent: it cannot renew itself.
 */
export function admit(app: App, facts: Facts): Admission {
	if (facts.bearer !== null) {
		const presented = present(app, facts.bearer, facts.address);
		if (presented.kind !== "standing") return presented;
		const { token } = presented;
		const hash = hashToken(facts.bearer);
		noteUse(app, "token", token.id, app.now(), facts.address);
		return {
			kind: "admitted",
			session: {
				via: "token",
				actor: (project) => {
					const standing = standingToken(app.reader, hash, app.now());
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
			noteUse(app, "session", found.id, app.now(), facts.address);
			return {
				kind: "admitted",
				session: {
					via: "cookie",
					id: () => findSession(app, hash)?.id ?? null,
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

/**
 * Signs a browser in with a token: opens a session whose secret is new and is not the token. The browser never
 * holds the token again, and only the SHA-256 of what it does hold is stored.
 *
 * The token is held to the limit on failed attempts exactly as a bearer token is (`present`), with `address` as
 * the address the request came from. `refused` and `limited` are known at once, and the caller answers without
 * waiting. Otherwise the session is being opened: it is written at the gate. That write looks the token up again
 * by its hash (`openSession`), and `signedIn` is null when the token stopped working while the request waited:
 * it was revoked, reached its end, or an import replaced every token. Nothing read before the wait is trusted
 * after it. The token's id, in particular, is not carried across: after an import a new token holds it.
 *
 * `about` is what the request said of itself, kept for a person looking at their own sessions: what the client
 * calls itself, and the address it came from (null for a request that never was on a connection).
 */
export function signInWithToken(
	app: App,
	secret: string,
	about: { userAgent: string | null; address: string | null },
): { kind: "opening"; signedIn: Promise<SignedIn | null> } | { kind: "refused" } | Limited {
	const presented = present(app, secret, about.address);
	if (presented.kind !== "standing") return presented;
	const { token } = presented;
	const tokenHash = hashToken(secret);
	// The use is of the token as it stands now, noted before any wait. An import clears the notes when it commits.
	noteUse(app, "token", token.id, app.now(), about.address);
	const cookie = newSessionSecret();
	const signedIn = app.gate.run(() => {
		const opened = openSession(app, {
			tokenHash,
			sessionHash: hashToken(cookie),
			// What the client calls itself, for a person looking at their own sessions. Never trusted, and cut:
			// the header is as long as its sender likes.
			userAgent: about.userAgent?.slice(0, 256) ?? null,
			address: about.address,
		});
		return opened ? { cookie, expiresAt: opened.expiresAt } : null;
	});
	return { kind: "opening", signedIn };
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
 *
 * `lastsMs` is how long the token works from now; absent, it has no end. `madeBy` is the id of the actor that
 * asked for it, which the row keeps; absent for a harness that makes a token with nobody asking.
 */
export function createToken(
	app: App,
	input: {
		actor: string;
		kind: ActorKind;
		can: readonly Capability[];
		project: number;
		label: string;
		lastsMs?: number;
		madeBy?: number;
	},
): { secret: string; actor: string; expiresAt: number | null } {
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
	const expiresAt = input.lastsMs === undefined ? null : at + input.lastsMs;
	db.run(Q.insertToken, {
		actor: actor.id,
		hash: hashToken(secret),
		label: input.label,
		at,
		expires: expiresAt,
		by: input.madeBy ?? null,
		source: null,
	});
	return { secret, actor: actor.name, expiresAt };
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

/**
 * The person an invitation is for: the one of this name, made now with the grant if there is none, exactly as
 * `createToken` makes a new person for a token. The rules are that function's, sentence for sentence: a name
 * that is an agent's, a pipeline's or the policy's is refused, so is a forgotten one, and a person who exists
 * keeps what they hold (naming that very grant is accepted, any other is refused, and `setGrant` changes it).
 * `isNew` says which it was, because it decides what the invitation does: a new person joins, one who exists
 * recovers.
 */
export function invitedPerson(
	app: App,
	input: { name: string; can: readonly Capability[]; project: number },
): { id: number; name: string; isNew: boolean } {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,63}$/.test(input.name)) throw invalid("actor name: letters, digits, . _ @ -");
	if (isForgottenName(input.name))
		throw invalid("actor name: a name that starts with forgotten- is what a forgotten actor is called; choose another");
	const db = app.db;
	const org = orgId(db);
	const existing = db.get(Q.actorByName, { org, name: input.name });
	if (existing && existing.kind !== "human")
		throw conflict(
			`actor ${input.name} exists and is ${KIND_NOUN[existing.kind]}, not a person: only a person is invited`,
		);
	if (existing && existing.disabled_at !== null) throw invalid(`actor ${input.name} was forgotten and is not invited`);
	if (existing && input.can.length > 0 && !sameGrant(db, existing.id, input.project, input.can)) {
		throw invalid(
			`actor ${input.name} exists: an invitation does not change what they may do. Change that with grant.set (mainworthy actor grant)`,
		);
	}
	refuseGrant("human", input.can);
	if (existing) return { id: existing.id, name: existing.name, isNew: false };
	const made = ensureActor(db, { org, kind: "human", name: input.name, at: app.now() });
	if (input.can.length > 0)
		db.run(Q.setGrant, { actor: made.id, project: input.project, can: JSON.stringify(input.can) });
	return { id: made.id, name: made.name, isNew: true };
}

/**
 * Whose things a signed-in caller may see and end: their own, or anyone's when the caller is a person who
 * administers the instance. Every operation that needs `self` asks here, and nothing else decides it
 * (`test/architecture.test.ts`). `caller` is the caller on the instance, so `admin` is the grant on every
 * project. An agent that holds `admin` is not a person: it sees and ends what is its own, like anybody.
 */
export function mayActFor(caller: Actor, subject: number): boolean {
	return caller.id === subject || (caller.kind === "human" && caller.can.includes("admin"));
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
 * Every token of the instance. `last_used_at` and `last_used_addr` are the newer of the row and what is noted and
 * not yet written (`uses.ts`), so a use shows in the list at once and not a minute later. `created_by` is the
 * name of the actor that made the token as history calls it now, or null when a start made it. `expired` is
 * whether the clock of this instance has reached the token's end, for a caller whose own clock may differ.
 */
export function listTokens(app: App) {
	const db = app.reader;
	const now = app.now();
	return db.all(Q.tokens, { org: orgId(db) }).map((row) => {
		const noted = notedUse(app, "token", row.id);
		return {
			...row,
			last_used_at: noted === null ? row.last_used_at : Math.max(row.last_used_at ?? 0, noted),
			last_used_addr: lastAddress(app, "token", row.id, { at: row.last_used_at, addr: row.last_used_addr }),
			expired: row.expires_at !== null && now >= row.expires_at,
		};
	});
}

/**
 * The name of the actor that this token is the last way in for: the token works at `now`, and its actor holds
 * no other that does. Null for any other token, and for an id that names none.
 */
export function lastTokenOf(db: Db, id: number, now: number): string | null {
	const token = db.get(Q.tokenById, { id });
	if (!token || !works(token, now)) return null;
	if ((db.get(Q.activeTokens, { actor: token.actor, now })?.n ?? 0) > 1) return null;
	return db.get(Q.actorById, { id: token.actor })?.name ?? null;
}

export function revokeToken(app: App, id: number): boolean {
	return app.db.run(Q.revokeToken, { id, at: app.now() }).changes > 0;
}

/**
 * Removes an actor's identity and keeps the record true: the name becomes a pseudonym, the actor is disabled, its
 * tokens are revoked and no longer say where they were used from, and its sessions are ended. Every fact still
 * points at the same actor row, so history says the same actor did each thing; it no longer says who that was.
 * Text the person typed elsewhere is not touched (docs/compliance.md).
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
	// An address says where the person was. A token's row is never deleted, so the address goes now, from the row
	// and from what is noted of it and not yet written. When each token was last used stays: that names nobody.
	db.run(Q.forgetAddresses, { actor: row.id });
	forgetNotedAddresses(
		app,
		"token",
		db.all(Q.tokensOf, { actor: row.id }).map((token) => token.id),
	);
	// A disabled actor's sessions are refused anyway. Ending them says why in each row, and keeps them ended if
	// the row of the actor is ever changed by hand.
	endSessionsOf(db, row.id, at);
	// The same for what a person signed in with and for a link that would still let them in. The handle their
	// passkeys were filed under is deleted: it named the person to an authenticator, and names nobody now.
	revokeCredentialsOf(db, row.id, at);
	revokeInvitationsOf(db, row.id, at);
	dropUserHandle(db, row.id);
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
