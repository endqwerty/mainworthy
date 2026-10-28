// People sign in as themselves through the instance's identity provider, the first time with the invitation an
// admin handed them. This file is what happens in each case, in order; the rows are in `credentials.ts`,
// `invitations.ts` and `sessions.ts`, and what a provider's answer is worth in `oidc.ts`. Other layers reach all of
// it through `identity.ts`. Mainworthy keeps no password, passkey or second factor: the provider holds those
// (decision 2026-10-27, people sign in through an identity provider).
//
// Every way in has the same two halves. First, outside the write gate, the provider's answer is judged: its code is
// exchanged over the network and its ID token checked. Then, under the gate and in one transaction, everything is
// read again and judged again before anything is written, and it is read by what it holds, never by a row's number
// alone: the person by name, an identity by its issuer and subject, an invitation by the hash of its code. Between
// the two halves a person may have been forgotten, or an archive imported, after which a row's number belongs to
// somebody else.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { App, Config } from "../kernel/app.ts";
import { Busy, type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
import { invalid, notFound } from "../kernel/errors.ts";
import { limiterOf } from "./attempts.ts";
import { holdCeremonyGeneration } from "./ceremonies.ts";
import { CONTEXT } from "./contexts.ts";
import {
	type CredentialRow,
	credentialById,
	insertOidc,
	liveCredentials,
	noteCredentialUse,
	oidcByHandle,
	oidcHandle,
	revokeCredential,
	revokeCredentialsOf,
} from "./credentials.ts";
import { revokeTokensOf, type SignedIn } from "./identity.ts";
import {
	type InvitationPurpose,
	type InvitationRow,
	insertInvitation,
	invitationByHash,
	isOpen,
	revokeInvitationsOf,
	spendInvitation,
} from "./invitations.ts";
import { addressKey, type LimiterAnswer } from "./limiter.ts";
import { lockActors, lockIdentity, lockSignInActor } from "./locks.ts";
import { beginOidc, CEREMONY_MS, finishOidc, type Identity, type OidcPurpose, type OidcRefusal } from "./oidc.ts";
import {
	dateSessionProof,
	endSession,
	endSessionsOf,
	endSessionsOn,
	findSession,
	newSessionSecret,
	openSessionOnCredential,
	PROOF_MS,
	type ProofContext,
	requireRecentProof,
} from "./sessions.ts";

/** A person who stands: an actor that is a person and was not forgotten. */
type Person = { id: number; name: string };

const Q = {
	personByName: sql<{ name: string }, Person>(
		`SELECT id, name FROM actors
		 WHERE name = $name AND kind = 'human' AND disabled_at IS NULL AND org = (SELECT id FROM orgs ORDER BY id LIMIT 1)`,
	),
	personById: sql<{ id: number }, Person>(
		"SELECT id, name FROM actors WHERE id = $id AND kind = 'human' AND disabled_at IS NULL",
	),
	nameOf: sql<{ id: number }, { name: string }>("SELECT name FROM actors WHERE id = $id"),
	actorsNamedLike: sql<{ name: string }, { id: number }>(
		"SELECT id FROM actors WHERE lower(name) = $name AND disabled_at IS NULL AND org = (SELECT id FROM orgs ORDER BY id LIMIT 1)",
	),
};

const hashOf = (secret: string): string => bytesToHex(sha256(new TextEncoder().encode(secret)));

// ── Where the instance is ──────────────────────────────────────────────────────────────────────────────────

/**
 * The address people open the instance at, from the configuration and from nothing else: never from a request's
 * `Host` or a forwarded header, which whoever sends the request chooses. An invitation link starts with it and the
 * provider sends the browser back to it. Null when the configuration names none.
 *
 * Throws for plain http off `localhost`, and for a value with anything after the host, since the server wants the
 * root address of the instance. Either stops the start (`open` in `start.ts` asks once, before anything else). The
 * value is not repeated in the message: an address can carry a password.
 */
export function publicAddress(config: Config): { url: string } | null {
	const text = config.publicUrl;
	if (text === undefined) return null;
	let url: URL | null = null;
	try {
		url = new URL(text);
	} catch {}
	const host = url?.hostname ?? "";
	const local = host === "localhost" || host.endsWith(".localhost");
	const secure = url !== null && (url.protocol === "https:" || (url.protocol === "http:" && local));
	// Nothing after the host: the instance is served at the root, and a link is this address and a path.
	const bare = url !== null && url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "";
	if (url === null || host === "" || !secure || !bare) {
		throw new Error(
			"MAINWORTHY_PUBLIC_URL is not an address this instance can use. Write the address people open this instance at and nothing after the host: https and a host name (https://mainworthy.example), or http://localhost with its port. Plain http anywhere else, a path and a query are refused",
		);
	}
	return { url: url.origin };
}

/** What `GET /api/login/methods` says: the ways of signing in this instance offers. */
export function signInMethods(app: App): { token: true; oidc: { name: string } | null } {
	return { token: true, oidc: app.config.oidc ? { name: app.config.oidc.name } : null };
}

// ── Refusals ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why somebody was not signed in. A closed set of codes, for the server's log: the caller of a sign-in is told
 * one thing whatever the reason, so that a reply never says which identities are linked.
 */
export type WhyNot =
	/** What was wrong with the identity provider's answer, or with where it came back to. */
	| OidcRefusal
	/** The provider vouched for an identity no person here has linked. */
	| "unknown-identity"
	/** The provider vouched for an identity of another person than the one asking to prove it. */
	| "other-identity"
	/** The provider said when the person last signed in there, and that was too long ago to count as proof. */
	| "stale"
	/** The provider did not say when the person last signed in there, or said a time still to come. */
	| "unverified"
	/** What was judged outside the gate was not what the commit found: changed, revoked, forgotten or imported over. */
	| "changed-meanwhile"
	/** No ceremony of this server, for this purpose, inside its time and not yet spent. */
	| "challenge"
	/** The answer does not come from where its ceremony began: another browser, another session, another invitation. */
	| "context"
	/** The invitation was used, revoked or has run out, or there is none with that code. */
	| "invitation"
	/** The identity is linked already, to this person or another. */
	| "credential-exists"
	/** An invitation to join, for a person who has a way of signing in already. */
	| "has-credentials"
	/** A body that is no way of signing in. */
	| "input";

export type Refused = { ok: false; why: WhyNot; credential?: number };
/** A caller that failed too often, by its address, and is told to wait `retryAfter` whole seconds. */
export type Limited = { ok: false; why: "limited"; retryAfter: number };
export type Entry = { ok: true; signedIn: SignedIn } | Refused | Limited;
const no = (why: WhyNot, credential?: number): Refused =>
	credential === undefined ? { ok: false, why } : { ok: false, why, credential };

// ── The limit on failed attempts ───────────────────────────────────────────────────────────────────────────
//
// A person's sign-in is counted in the limiter a token is counted in (`limiter.ts` has the rule, `attempts.ts`
// the instance's one).
//
/** The keys an attempt counts under, without the ones that count nothing (an unknown or private address). */
const counted = (...keys: (string | null)[]): string[] => keys.filter((key) => key !== null);
const waiting = (answer: Extract<LimiterAnswer, { kind: "blocked" }>): Limited => ({
	ok: false,
	why: "limited",
	retryAfter: answer.retryAfterSeconds,
});

/**
 * The count for something that is not a guess when it is right: a provider's answer, an invitation's code. It
 * is asked before the thing is looked at, and `wrong` is what a failure is answered with: the wait when the
 * address was blocked as the attempt arrived, and else the refusal itself, counted.
 */
async function byAddress(
	app: App,
	address: string | null,
): Promise<{ wrong: <R extends Refused>(refused: R) => Promise<R | Limited> }> {
	const limiter = limiterOf(app);
	const keys = counted(addressKey(address));
	const answer = await limiter.check(keys, app.now());
	return {
		wrong: async (refused) => {
			if (answer.kind === "blocked") return waiting(answer);
			const failed = await limiter.failed(keys, app.now());
			return failed.kind === "blocked" ? waiting(failed) : refused;
		},
	};
}

/** Thrown inside a commit to undo what it wrote and answer with a refusal. */
class Stop extends Error {
	constructor(readonly refused: Refused) {
		super(refused.why);
	}
}

/** Runs `work` under the gate in one transaction. A `Stop` thrown in it rolls everything back and is its answer. */
async function commit<T>(
	app: App,
	actors: { identity: readonly number[] } | { signIn: number | null },
	work: (db: WriteDb) => Promise<T>,
): Promise<T | Refused> {
	return await app.database.write(async (db) => {
		try {
			return await db.transaction(async () => {
				if ("identity" in actors) await lockActors(db, actors.identity, true);
				else if (actors.signIn !== null) await lockSignInActor(db, actors.signIn);
				return await work(db);
			});
		} catch (error) {
			if (error instanceof Stop) return error.refused;
			throw error;
		}
	});
}

/**
 * What the surface says of the request. `userAgent` is what the client calls itself, for a person looking at
 * their own sessions: never trusted, and cut. `address` is where the request came from, as the surface
 * determined it, or null when nothing says: failed attempts are counted against it, and the session is opened
 * from it. `proven` is called once the proof was found good and before the wait at the gate, for a surface that
 * treats a caller differently from then on.
 */
type About = { userAgent: string | null; address: string | null; proven?: () => void };

/**
 * Opens the session of a sign-in on the credential that proved it, as that row stands in this transaction.
 * `cookie` is the secret the browser will hold. Null when the row no longer holds what it held a moment ago.
 */
async function openOn(app: App, db: WriteDb, row: CredentialRow, cookie: string, about: About) {
	return await openSessionOnCredential(app, db, {
		credential: { id: row.id, actor: row.actor, data: row.data },
		sessionHash: hashOf(cookie),
		userAgent: about.userAgent?.slice(0, 256) ?? null,
		address: about.address,
	});
}

// ── Identities, as a signed-in person sees them ─────────────────────────────────────────────────────────

/** A person's ways of signing in. Never a hash, a key or a credential id: a list is read on a screen. */
export async function listCredentials(db: ReadDb, actor: number) {
	return (await liveCredentials(db, actor)).map((row) => ({
		id: row.id,
		kind: row.kind,
		label: row.label,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	}));
}

/** The person a credential signs in, when it still works; else null. */
export async function credentialOwner(db: ReadDb, id: number): Promise<number | null> {
	const row = await credentialById(db, id);
	return row && row.revoked_at === null ? row.actor : null;
}

/**
 * Unlinks one identity a person signs in with, and ends the sessions that rest on it. The last one stays: with
 * none, the person could not sign in through the provider, and only an admin's recovery link would let them back.
 */
export async function removeCredential(
	app: App,
	db: WriteDb,
	id: number,
	proof: ProofContext,
): Promise<{ removed: true; sessionsEnded: number }> {
	await lockIdentity(db);
	const row = await credentialById(db, id);
	if (!row || row.revoked_at !== null) throw notFound(`credential ${id}`);
	await requireRecentProof(app, db, proof);
	if ((await liveCredentials(db, row.actor)).filter((held) => held.id !== row.id).length === 0) {
		const name = (await db.get(Q.nameOf, { id: row.actor }))?.name ?? "this person";
		throw invalid(
			`this is the last identity ${name} signs in with, so it stays. Link another first, then remove this one. If it is lost, an admin can make a recovery link (mainworthy invite new ${name})`,
		);
	}
	const at = app.now();
	await revokeCredential(db, id, at);
	return { removed: true, sessionsEnded: await endSessionsOn(db, id, at) };
}

// ── An invitation ──────────────────────────────────────────────────────────────────────────────────────────

/** What inviting somebody answers on an instance with no identity provider: nobody could accept. */
export const NO_PROVIDER =
	"this instance has no identity provider, so an invitation could not be accepted. Whoever runs it sets MAINWORTHY_OIDC_ISSUER and the variables beside it, and starts it again";

/**
 * Makes an invitation for a person and returns its code, which is shown once and of which only the SHA-256 is
 * stored. In the operation's transaction. A new invitation replaces the person's earlier ones that nobody
 * accepted, so one link is good for a person at a time. It is accepted by signing in at the provider, so an
 * instance with none makes no invitation.
 */
export async function createInvitation(
	app: App,
	db: WriteDb,
	input: { actor: number; by: number; purpose: InvitationPurpose; lastsMs: number; context: string | null },
): Promise<{ id: number; code: string; link: string; expiresAt: number }> {
	if (!app.config.oidc) throw invalid(NO_PROVIDER);
	await lockIdentity(db);
	if (input.context !== null) await requireRecentProof(app, db, { actor: input.by, context: input.context });
	const at = app.now();
	await revokeInvitationsOf(db, input.actor, at);
	const code = newSessionSecret();
	const expiresAt = at + input.lastsMs;
	const id = await insertInvitation(db, {
		actor: input.actor,
		hash: hashOf(code),
		purpose: input.purpose,
		by: input.by,
		at,
		expiresAt,
	});
	// The code is after the `#`: a browser keeps that part to itself, so it reaches no server log on the way.
	return { id, code, link: `${publicAddress(app.config)?.url ?? ""}/invite#${code}`, expiresAt };
}

/** An invitation that can be accepted now, with the person it is for; else null, whatever the reason. */
async function openInvitation(
	app: App,
	db: ReadDb,
	hash: string,
): Promise<{ invitation: InvitationRow; person: Person } | null> {
	const invitation = await invitationByHash(db, hash);
	if (!invitation || !isOpen(invitation, app.now())) return null;
	const person = await db.get(Q.personById, { id: invitation.actor });
	return person ? { invitation, person } : null;
}

/**
 * What the page of an invitation shows: who it is for, what accepting does and when it runs out. Null for a code
 * that accepts nothing, whatever the reason. Showing the page never consumes the invitation. A right code is proof
 * of the invitation, so its page stays reachable during an address block.
 */
export async function showInvitation(
	app: App,
	code: string,
	address: string | null,
): Promise<
	| { ok: true; shown: { invitation: { name: string; purpose: InvitationPurpose; expiresAt: number } } }
	| Refused
	| Limited
> {
	const found = await app.database.admissionRead(async (readDb) => await openInvitation(app, readDb, hashOf(code)));
	if (!found) return (await byAddress(app, address)).wrong(no("invitation"));
	const { invitation, person } = found;
	return {
		ok: true,
		shown: { invitation: { name: person.name, purpose: invitation.purpose, expiresAt: invitation.expires_at } },
	};
}

/** Who a browser is signed in as, by its session cookie, and null when the cookie names no session that is alive. */
async function holderOf(app: App, cookie: string, db?: ReadDb): Promise<{ id: number; name: string } | null> {
	const actor = (await findSession(app, hashOf(cookie), db ? { db } : {}))?.actor;
	return actor ? { id: actor.id, name: actor.name } : null;
}

export type Accepted = Entry | { ok: false; why: "other-session"; signedInAs: string };

/**
 * Accepts an invitation, known by the hash of its code, with the identity the provider vouched for, and signs
 * the person in.
 *
 * One transaction links the identity, spends the invitation and opens the session. An invitation to recover also
 * revokes, there, every identity and token the person had and ends every session of theirs: until it is accepted
 * nothing of theirs changes, so a link that is never used locks nobody out.
 *
 * `browser` is the session cookie the request carried, if any. When it signs in somebody else, the invitation is
 * accepted only when `replaceActor` is that person, and that session ends in the same transaction: the page asked
 * about them before the browser left for the provider. A yes about one person ends no other person's session: who
 * the browser holds is asked again in the commit, and the answer names whoever that is now, so the page can ask
 * again. With no session, or the invited person's own, nothing ends.
 */
async function acceptByHash(
	app: App,
	hash: string,
	input: {
		browser: string | null;
		identity: { handle: string; label: string; generation: string; replaceActor: number | null };
	},
	about: About,
): Promise<Accepted> {
	const attempt = await byAddress(app, about.address);
	const first = await app.database.admissionRead(async (readDb) => await openInvitation(app, readDb, hash));
	// A code that accepts nothing is a wrong guess at one, and is counted.
	if (!first) return attempt.wrong(no("invitation"));
	// Somebody other than `person` whom the browser's cookie signs in now, and whether the page said their name.
	// Nothing of this is carried over the wait at the gate: it is asked here, and asked again in the commit.
	const elsewhere = async (
		person: { id: number },
		db?: ReadDb,
	): Promise<{ id: number; name: string; agreed: boolean } | null> => {
		const holder = input.browser === null ? null : await holderOf(app, input.browser, db);
		return holder && holder.id !== person.id
			? { id: holder.id, name: holder.name, agreed: input.identity.replaceActor === holder.id }
			: null;
	};
	const unasked = (held: { name: string; agreed: boolean } | null): Accepted | null =>
		held && !held.agreed ? { ok: false, why: "other-session", signedInAs: held.name } : null;
	const early = unasked(await elsewhere(first.person));
	if (early) return early;
	about.proven?.();
	const cookie = newSessionSecret();
	const replacing = input.browser === null ? null : await holderOf(app, input.browser);
	return await commit(
		app,
		{ identity: [first.person.id, ...(replacing ? [replacing.id] : [])] },
		async (db): Promise<Accepted> => {
			if (!(await holdCeremonyGeneration(db, input.identity.generation))) return no("challenge");
			const now = await openInvitation(app, db, hash);
			if (!now) return no("invitation");
			const { invitation, person } = now;
			if (person.id !== first.person.id) throw new Busy();
			// Recheck the browser before writing. A new holder needs fresh lock discovery, even if its name was agreed.
			const held = await elsewhere(person, db);
			if (held && held.id !== replacing?.id) throw new Busy();
			const refused = unasked(held);
			if (refused) return refused;
			const at = app.now();
			// By the hash of its code, and only while it is still good: of two acceptances one finds it spent.
			if (!(await spendInvitation(db, hash, at))) throw new Stop(no("invitation"));
			if (invitation.purpose === "recover") {
				await revokeCredentialsOf(db, person.id, at);
				await revokeTokensOf(db, person.id, at);
				await endSessionsOf(db, person.id, at, "ended");
			} else if ((await liveCredentials(db, person.id)).length > 0) throw new Stop(no("has-credentials"));
			if (await oidcByHandle(db, input.identity.handle)) throw new Stop(no("credential-exists"));
			const root = await insertOidc(db, { actor: person.id, ...input.identity, at });
			const opened = await openOn(app, db, root, cookie, about);
			if (!opened) throw new Stop(no("changed-meanwhile"));
			// What was just stored signed its person in, and says so: a list does not call it "never used".
			await noteCredentialUse(db, root.id, at);
			// The browser was somebody else's until now, and the page said whose. That session ends as a sign-out does.
			if (input.browser !== null && held) await endSession(app, db, hashOf(input.browser), "signed-out");
			return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } } as const;
		},
	);
}

// ── An identity provider ───────────────────────────────────────────────────────────────────────────────────
//
// A person reaches their identity at the provider by an invitation or by linking it from their settings, and
// never by what the provider says about them (an email, a name): the provider vouches for an issuer and a
// subject, and this instance decides whose that is. The provider's answer is judged outside the gate (the code
// is exchanged over the network, `oidc.ts`), and the rows are read again and written under it.

/** What a route about the provider answers on an instance that has none. */
export const OIDC_OFF =
	"this instance has no identity provider. Whoever runs it sets MAINWORTHY_OIDC_ISSUER and the variables beside it, and starts it again";

/** The page of the web UI the provider sends the browser back to, at the instance's public address. */
function oidcRedirect(app: App): string {
	const address = publicAddress(app.config);
	if (!app.config.oidc || !address) throw invalid(OIDC_OFF);
	return `${address.url}/signin/oidc`;
}

/** What the identity is called in a person's list of ways in: the provider, and the email or name it gave. */
function identityLabel(app: App, identity: Identity): string {
	const provider = app.config.oidc?.name ?? "Identity provider";
	const who = identity.email ?? identity.name;
	return (who ? `${provider} (${who})` : provider).slice(0, 120);
}

export type OidcStart =
	| { purpose: "sign-in" }
	/** `browser` is the session cookie the request carried, if any, and `replace` the name the page asked about. */
	| { purpose: "join"; code: string; replace: string | null; browser: string | null }
	/** Somebody signed in with a browser's session: the actor, and the session cookie the request carried. */
	| { purpose: "link" | "proof"; actor: number; browser: string };

export type OidcBegun =
	| { ok: true; url: string; ceremony: string; lastsMs: number }
	| Refused
	| Limited
	| { ok: false; why: "other-session"; signedInAs: string }
	| { ok: false; why: "unreachable" | "not-a-person" };

/**
 * Begins signing in, accepting an invitation, linking or proving through the provider: where the browser goes next, and
 * the ceremony cookie that ties the answer to this browser. An invitation is looked at now, as its page does,
 * and a browser signed in as somebody else is asked about first, so the person is not sent to the provider for
 * an acceptance that could not go through. Throws `OIDC_OFF` on an instance with no provider.
 */
export async function beginOidcSignIn(app: App, start: OidcStart, address: string | null): Promise<OidcBegun> {
	const redirect = oidcRedirect(app);
	let purpose: OidcPurpose;
	if (start.purpose === "join") {
		const attempt = await byAddress(app, address);
		const hash = hashOf(start.code);
		const found = await app.database.admissionRead(async (readDb) => await openInvitation(app, readDb, hash));
		if (!found) return attempt.wrong(no("invitation"));
		const holder = start.browser === null ? null : await holderOf(app, start.browser);
		if (holder && holder.id !== found.person.id && start.replace !== holder.name)
			return { ok: false, why: "other-session", signedInAs: holder.name };
		purpose = {
			purpose: "join",
			invitation: hash,
			replace: holder && holder.id !== found.person.id ? holder.id : null,
		};
	} else if (start.purpose === "link") {
		if (!(await app.database.read(async (db) => await db.get(Q.personById, { id: start.actor }))))
			return { ok: false, why: "not-a-person" };
		await app.database.write(
			async (db) =>
				await db.transaction(
					async () =>
						// A person with no identity yet links their first one without proof, as with a first credential before.
						await requireRecentProof(
							app,
							db,
							{ actor: start.actor, context: CONTEXT.session(hashOf(start.browser)) },
							true,
						),
				),
		);
		purpose = { purpose: "link", actor: start.actor, session: hashOf(start.browser) };
	} else if (start.purpose === "proof") {
		// Proof is of an identity this person has linked: one with none proves with a token (`sessions.ts`).
		const linked = await app.database.read(async (db) => await liveCredentials(db, start.actor));
		if (linked.length === 0) return { ok: false, why: "not-a-person" };
		purpose = { purpose: "proof", actor: start.actor, session: hashOf(start.browser) };
	} else purpose = { purpose: "sign-in" };
	const ceremony = newSessionSecret();
	const url = await beginOidc(app, { purpose, browser: hashOf(ceremony), redirect, address });
	if (url !== null && typeof url !== "string") return waiting(url);
	return url === null ? { ok: false, why: "unreachable" } : { ok: true, url, ceremony, lastsMs: CEREMONY_MS };
}

/** How far ahead of this server's clock a provider's `auth_time` may be: the tolerance `openid-client` allows a token. */
const AUTH_TIME_SKEW_MS = 30_000;

export type OidcFinished =
	| Accepted
	| { ok: true; linked: true }
	| { ok: true; proven: true }
	| { ok: false; why: "linked-already" };

/**
 * Finishes what `beginOidcSignIn` began, with the query the provider sent the browser back with. `ceremony` is
 * the ceremony cookie the request carried and `browser` its session cookie, each or null. A refused answer is
 * counted under the address: nobody guesses a provider's signature.
 */
export async function finishOidcSignIn(
	app: App,
	input: { query: string; ceremony: string | null; browser: string | null },
	about: About,
): Promise<OidcFinished> {
	const attempt = await byAddress(app, about.address);
	const judged = await finishOidc(app, {
		query: input.query,
		browser: input.ceremony === null ? null : hashOf(input.ceremony),
		redirect: oidcRedirect(app),
	});
	if (!judged.ok) return attempt.wrong(no(judged.why));
	const { purpose, identity } = judged;
	const handle = oidcHandle(identity);
	const label = identityLabel(app, identity);
	if (purpose.purpose === "join") {
		return await acceptByHash(
			app,
			purpose.invitation,
			{
				browser: input.browser,
				identity: { handle, label, generation: judged.generation, replaceActor: purpose.replace },
			},
			about,
		);
	}
	if (purpose.purpose === "link") {
		const linking = purpose;
		return await commit(app, { identity: [linking.actor] }, async (db): Promise<OidcFinished> => {
			if (!(await holdCeremonyGeneration(db, judged.generation))) return no("challenge");
			// The browser that finishes is the session that began, and that session is still the person's.
			const held = input.browser === null ? null : await findSession(app, hashOf(input.browser), { db: db });
			if (input.browser === null || hashOf(input.browser) !== linking.session || held?.actor.id !== linking.actor)
				return no("context");
			await requireRecentProof(app, db, { actor: linking.actor, context: CONTEXT.session(linking.session) }, true);
			if (await oidcByHandle(db, handle)) return { ok: false, why: "linked-already" };
			await insertOidc(db, { actor: linking.actor, handle, label, at: app.now() });
			return { ok: true, linked: true };
		});
	}
	if (purpose.purpose === "proof") {
		const proving = purpose;
		// Proof is a sign-in at the provider that it says happened in the last ten minutes. An answer that does not
		// say when (a provider that leaves out `auth_time`, or Google without it enabled) would be a silent single
		// sign-on from whoever sits at the browser, so it proves nothing; a time still to come, beyond the clock
		// tolerance the library allows a token, proves nothing either.
		const authTime = identity.authTime;
		if (authTime === null || authTime - app.now() > AUTH_TIME_SKEW_MS) return no("unverified");
		return await commit(app, { identity: [proving.actor] }, async (db): Promise<OidcFinished> => {
			// Judged on the clock of the commit: a proof that went stale while waiting for the writer proves nothing.
			if (app.now() - authTime > PROOF_MS) return no("stale");
			if (!(await holdCeremonyGeneration(db, judged.generation))) return no("challenge");
			const held = input.browser === null ? null : await findSession(app, hashOf(input.browser), { db: db });
			if (input.browser === null || hashOf(input.browser) !== proving.session || held?.actor.id !== proving.actor)
				return no("context");
			const row = await oidcByHandle(db, handle);
			if (!row || row.actor !== proving.actor) return no("other-identity");
			if (!(await dateSessionProof(app, db, { actor: proving.actor, context: CONTEXT.session(proving.session) })))
				return no("changed-meanwhile");
			await noteCredentialUse(db, row.id, app.now());
			return { ok: true, proven: true };
		});
	}
	return await openOidcSession(app, { identity, generation: judged.generation }, about);
}

async function openOidcSession(
	app: App,
	input: { identity: Identity; generation: string },
	about: About,
): Promise<Entry> {
	const attempt = await byAddress(app, about.address);
	about.proven?.();
	const cookie = newSessionSecret();
	const hint = await app.database.admissionRead((db) => oidcByHandle(db, oidcHandle(input.identity)));
	const entry = await commit(app, { signIn: hint?.actor ?? null }, async (db): Promise<Entry> => {
		if (!(await holdCeremonyGeneration(db, input.generation))) return no("challenge");
		if (!app.config.oidc || input.identity.issuer !== app.config.oidc.issuer) return no("changed-meanwhile");
		const row = await oidcByHandle(db, oidcHandle(input.identity));
		if (row && row.actor !== hint?.actor) throw new Busy();
		const person = row ? await db.get(Q.personById, { id: row.actor }) : null;
		if (!row || !person) return no("unknown-identity");
		const opened = await openOn(app, db, row, cookie, about);
		if (!opened) throw new Stop(no("changed-meanwhile"));
		await noteCredentialUse(db, row.id, app.now());
		return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } };
	});
	// An identity nobody linked is somebody trying; a row that changed under a good answer is not.
	return entry.ok || entry.why === "limited" || entry.why === "changed-meanwhile" ? entry : attempt.wrong(entry);
}
