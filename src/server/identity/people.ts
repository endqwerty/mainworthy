// People sign in as themselves: with a name and a password, with a passkey, through the identity provider, or
// the first time with the invitation an admin handed them. This file is what happens in each case, in order; the rows are in
// `credentials.ts`, `invitations.ts` and `sessions.ts`, the challenges in `challenges.ts`, what a passkey's
// answer is worth in `webauthn.ts`, and what a provider's answer is worth in `oidc.ts`. Other layers reach all of it through `identity.ts`.
//
// Every way in has the same two halves. First, outside the write gate, what was presented is judged against
// committed rows: a password is hashed and compared on another thread, a passkey's signature is checked. Then,
// under the gate and in one transaction, everything is read again and judged again before anything is written,
// and it is read by what it holds, never by a row's number alone: the person by name, a password by its
// stored hash, a passkey by its credential id, key and counter, an invitation by the hash of its code. Between
// the two halves a password may have been changed, a person forgotten, or an archive imported, after which a
// row's number belongs to somebody else.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { App, Config } from "../kernel/app.ts";
import { Busy, type ReadDb, sql, type WriteDb } from "../kernel/db.ts";
import { conflict, forbidden, invalid, notFound, OpError } from "../kernel/errors.ts";
import { limiterOf, takeStart } from "./attempts.ts";
import { holdCeremonyGeneration } from "./ceremonies.ts";
import { findChallenge, invitationChallenge, issueChallenge, spendChallenge } from "./challenges.ts";
import { clearMailLinksOf, credentialNotice, emailHolders, personByEmail } from "./contacts.ts";
import { CONTEXT } from "./contexts.ts";
import {
	type CredentialRow,
	countPasskeyUse,
	credentialById,
	ensureUserHandle,
	insertOidc,
	insertPasskey,
	insertPassword,
	insertTotp,
	liveCredentials,
	livePassword,
	liveTotp,
	noteCredentialUse,
	oidcByHandle,
	oidcHandle,
	passkeyByCredentialId,
	rehashPassword,
	revokeCredential,
	revokeCredentialsOf,
	storedPasskey,
	updateTotp,
	userHandleOf,
} from "./credentials.ts";
import { hasAdminGrant, providerVouches, revokeTokensOf, type SignedIn } from "./identity.ts";
import {
	type InvitationPurpose,
	type InvitationRow,
	insertInvitation,
	invitationByHash,
	isOpen,
	revokeInvitationsOf,
	spendInvitation,
} from "./invitations.ts";
import { accountKey, addressKey, type LimiterAnswer, startAddressKey } from "./limiter.ts";
import { lockActors, lockIdentity, lockSignInActor } from "./locks.ts";
import {
	beginOidc,
	findNativeOidc,
	finishOidc,
	type Identity,
	issueNativeOidc,
	type NativeOidcExchange,
	type NativeOidcRequest,
	type OidcPurpose,
	type OidcRefusal,
	takeNativeOidc,
} from "./oidc.ts";
import { dummyHash, hashPassword, type PasswordMatch, PasswordWorkBusy, verifyPassword } from "./passwords.ts";
import {
	dateSessionProof,
	endOtherSessions,
	endSession,
	endSessionsOf,
	endSessionsOn,
	findSession,
	newSessionSecret,
	openSessionOnCredential,
	type ProofContext,
	proofSession,
	requireRecentProof,
	restSession,
} from "./sessions.ts";
import {
	acceptTotp,
	findTotp,
	issueTotp,
	newTotpSecret,
	provisioning,
	readTotp,
	recoveryCodes,
	secretHash,
	spendTotp,
} from "./totp.ts";
import {
	type Assertion,
	type AssertionOptions,
	AssertionResponse,
	assertionOptions,
	CEREMONY_MS,
	type Challenge,
	challengeOf,
	type Passkey,
	type Refusal,
	type RegistrationOptions,
	type RelyingParty,
	registrationOptions,
	relyingParty,
	verifyAssertion,
	verifyRegistration,
} from "./webauthn.ts";

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

/** What the instance is called in the window an authenticator shows. */
const RP_NAME = "Mainworthy";

/** What a route or an operation about passkeys answers on an instance that was given no public address. */
export const PASSKEYS_OFF =
	"passkeys are off on this instance: it was given no public address. Set MAINWORTHY_PUBLIC_URL to the address people open it at, and start it again";

/**
 * The address people open the instance at, and the relying party of its passkeys, from the configuration and
 * from nothing else: never from a request's `Host` or a forwarded header, which whoever sends the request
 * chooses. Null when the configuration names none: the instance then has no passkeys.
 *
 * Throws for a value a browser would not make a passkey at (an IP address, plain http off `localhost`) and for
 * one with anything after the host, since the server wants the root address of the instance. Either stops the
 * start (`open` in `start.ts` asks once, before anything else). A typing error must not leave an instance where passkeys silently never work,
 * or where one is registered for a name the instance is not reached at. The value is not repeated in the
 * message: an address can carry a password.
 */
export function publicAddress(config: Config): { url: string; party: RelyingParty } | null {
	const text = config.publicUrl;
	if (text === undefined) return null;
	const party = relyingParty(text);
	let url: URL | null = null;
	try {
		url = new URL(text);
	} catch {}
	// Nothing after the host: the instance is served at the root, and a link is this address and a path.
	const bare = url !== null && url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "";
	if (!party || !bare) {
		throw new Error(
			"MAINWORTHY_PUBLIC_URL is not an address this instance can use for passkeys. Write the address people open this instance at and nothing after the host: https and a host name (https://mainworthy.example), or http://localhost with its port. No browser makes a passkey at an IP address or over plain http anywhere else, and this server wants the root address, so a path and a query are refused too. Unset it to start without passkeys",
		);
	}
	return { url: party.origin, party };
}

function mustHavePasskeys(app: App): RelyingParty {
	const address = publicAddress(app.config);
	if (!address) throw invalid(PASSKEYS_OFF);
	return address.party;
}

/** What `GET /api/login/methods` says: the ways of signing in this instance offers. */
export function signInMethods(app: App): {
	password: true;
	passkey: boolean;
	mail: boolean;
	oidc: { name: string } | null;
} {
	return {
		password: true,
		passkey: publicAddress(app.config) !== null,
		mail: app.config.mail !== undefined,
		oidc: app.config.oidc ? { name: app.config.oidc.name } : null,
	};
}

// ── Refusals ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why somebody was not signed in. A closed set of codes, for the server's log: the caller of a sign-in is told
 * one thing whatever the reason, so that a reply never says which names exist or which half was right.
 */
export type WhyNot =
	/** What the passkey verifier found wrong with an answer. */
	| Refusal
	/** What was wrong with the identity provider's answer, or with where it came back to. */
	| OidcRefusal
	/** The provider vouched for an identity no person here has linked. */
	| "unknown-identity"
	/** No person of that name stands: unknown, forgotten, or an agent's or a pipeline's name. */
	| "unknown-name"
	/** The person has no password that works. */
	| "no-password"
	| "wrong-password"
	| "wrong-code"
	| "second-factor-required"
	/** Too many passwords are being checked at this moment. */
	| "busy"
	/** What was judged outside the gate was not what the commit found: changed, revoked, forgotten or imported over. */
	| "changed-meanwhile"
	/** No challenge of this server, for this purpose and this person, inside its time and not yet spent. */
	| "challenge"
	/** The answer does not come from where its ceremony began: another browser, another session, another invitation. */
	| "context"
	| "unknown-passkey"
	/** The passkey was removed, or its person was forgotten. */
	| "revoked-passkey"
	/** The answer carries no user handle, or one that is not the handle of the passkey's person. */
	| "user-handle"
	/** The invitation was used, revoked or has run out, or there is none with that code. */
	| "invitation"
	/** The credential id is registered already, to this person or another. */
	| "credential-exists"
	/** An invitation to join, for a person who has a way of signing in already. */
	| "has-credentials";

export type Refused = { ok: false; why: WhyNot; credential?: number };
/** A caller that failed too often, by its address or at this name, and is told to wait `retryAfter` whole seconds. */
export type Limited = { ok: false; why: "limited"; retryAfter: number };
export type Entry = { ok: true; signedIn: SignedIn } | Refused | Limited;
const no = (why: WhyNot, credential?: number): Refused =>
	credential === undefined ? { ok: false, why } : { ok: false, why, credential };

// ── The limit on failed attempts ───────────────────────────────────────────────────────────────────────────
//
// A person's sign-in is counted in the limiter a token is counted in (`limiter.ts` has the rule, `attempts.ts`
// the instance's one). What differs is the keys, and what passes a block:
//
// - A name and a password, and the current password of a change: the address and the name. A password is a
//   secret a person chose, so while either key is blocked it is not looked at, right or wrong. A name nobody
//   has is counted exactly as a wrong password is, or the count would say which names exist. A success clears
//   the name and never the address.
// - A passkey's answer and an invitation's code: the address alone. Neither is a guess anybody makes (a
//   signature, 256 random bits the server made), so a right one is looked at and passes while the address is
//   blocked, as a right generated token does. A wrong one during a block is told to wait and is not counted.

/** The keys an attempt counts under, without the ones that count nothing (an unknown or private address). */
const counted = (...keys: (string | null)[]): string[] => keys.filter((key) => key !== null);
const waiting = (answer: Extract<LimiterAnswer, { kind: "blocked" }>): Limited => ({
	ok: false,
	why: "limited",
	retryAfter: answer.retryAfterSeconds,
});

/**
 * The count for something that is not a guess when it is right: a passkey's answer, an invitation's code. It
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

// ── A name and a password ──────────────────────────────────────────────────────────────────────────────────

class PasswordBlocked extends Error {
	constructor(readonly answer: Extract<LimiterAnswer, { kind: "blocked" }>) {
		super("password check is blocked");
	}
}

/**
 * Admission and result accounting shared by sign-in and a change's current-password check. A right password
 * resets the count of `name` only when what it counts is `holder`'s alone: the count is of the text, trimmed and
 * in lower case, which can also be another person's name in another case, or their email address. Resetting it
 * then would let one person's sign-ins clear the wrong passwords tried at another's.
 */
async function checkPassword(
	app: App,
	input: { password: string; stored: string; name: string; address: string | null; holder: number | null },
): Promise<PasswordMatch | Limited> {
	const limiter = limiterOf(app);
	const account = accountKey(input.name);
	const keys = counted(addressKey(input.address), account);
	const answer = await limiter.check(keys, app.now());
	if (answer.kind === "blocked") return waiting(answer);
	let blockVersion = answer.version;
	let right: PasswordMatch;
	try {
		right = await verifyPassword(input.password, input.stored, async () => {
			const turn = await limiter.check(keys, app.now());
			if (turn.kind === "blocked") throw new PasswordBlocked(turn);
			blockVersion = turn.version;
		});
	} catch (error) {
		if (error instanceof PasswordBlocked) return waiting(error.answer);
		throw error;
	}
	const after = await limiter.check(keys, app.now());
	if (after.kind === "blocked") return waiting(after);
	if (right === "wrong") {
		const failed = await limiter.failed(keys, app.now());
		if (failed.kind === "blocked") return waiting(failed);
	}
	// A success clears only the name, and cannot erase a block begun while this check was running.
	else if (account !== null && input.holder !== null && (await countedForOnly(app, input.name, input.holder)))
		await limiter.succeeded([account], blockVersion);
	return right;
}

/** Is `holder` the only one whose name, in any case, or whose email address is `text` trimmed and lower-cased? */
async function countedForOnly(app: App, text: string, holder: number): Promise<boolean> {
	const counted = text.trim().toLowerCase();
	return await app.database.admissionRead(async (db) => {
		const named = (await db.all(Q.actorsNamedLike, { name: counted })).map((row) => row.id);
		return [...named, ...(await emailHolders(db, counted))].every((id) => id === holder);
	});
}

/**
 * Signs a person in with their name, or their email address, and password. A name wins over another person's
 * address that reads the same.
 *
 * A password is checked whoever is named: for a name that has none, against a hash nobody's password matches
 * (`dummyHash`). So the unknown name, the forgotten person, the person without a password and the wrong
 * password all cost the same work and get the same answer, and all four are counted alike under the address
 * and what was typed. While either is blocked the password is not checked at all. What was typed, not the
 * person it names: a name blocked by guesses would otherwise make the refusal of its person's address differ
 * from an unknown address's, and say whose it is. So a person's name and address are counted apart.
 */
export async function signInWithPassword(
	app: App,
	input: { name: string; password: string },
	about: About,
): Promise<Entry | { ok: true; secondFactor: { challenge: string; expiresAt: number }; ceremony: string }> {
	const limiter = limiterOf(app);
	const account = accountKey(input.name);
	const keys = counted(addressKey(about.address), account);
	const answer = await limiter.check(keys, app.now());
	if (answer.kind === "blocked") return waiting(answer);
	const person = await app.database.admissionRead(
		async (readDb) =>
			(await readDb.get(Q.personByName, { name: input.name })) ?? (await personByEmail(readDb, input.name)),
	);
	const name = person?.name ?? input.name;
	const stored = person
		? await app.database.admissionRead(async (readDb) => await livePassword(readDb, person.id))
		: null;
	let right: PasswordMatch;
	let rehashed: string | null = null;
	try {
		// Asked for whoever is named, so that the one sign-in that has to make it first is not marked by that.
		const nobodys = await dummyHash(app.config.passwordCost);
		const checked = await checkPassword(app, {
			password: input.password,
			stored: stored?.data ?? nobodys,
			name: input.name,
			address: about.address,
			holder: person?.id ?? null,
		});
		if (typeof checked !== "string") return checked;
		right = checked;
		if (right === "legacy") rehashed = await hashPassword(input.password, app.config.passwordCost);
	} catch (error) {
		if (error instanceof PasswordWorkBusy) return no("busy");
		throw error;
	}
	if (!person || !stored || right === "wrong") {
		return no(!person ? "unknown-name" : !stored ? "no-password" : "wrong-password");
	}
	about.proven?.();
	const cookie = newSessionSecret();
	return await commit(app, { signIn: person.id }, async (db) => {
		// The name is looked up again and must lead to a password with the very hash that was verified.
		const now = await db.get(Q.personByName, { name });
		if (now && now.id !== person.id) throw new Busy();
		const current = now ? await livePassword(db, now.id) : null;
		if (!now || !current || current.data !== stored.data) return no("changed-meanwhile");
		const factor = await liveTotp(db, now.id);
		if (factor) {
			if (rehashed !== null && !(await rehashPassword(db, current, rehashed, app.now())))
				throw new Stop(no("changed-meanwhile"));
			const ceremony = newSessionSecret();
			return {
				ok: true,
				secondFactor: await issueTotp(
					app,
					{
						kind: "sign-in",
						actor: now.id,
						password: rehashed ?? current.data,
						factor: factor.id,
						context: CONTEXT.browser(secretHash(ceremony)),
					},
					db,
				),
				ceremony,
			} as const;
		}
		if (app.config.requireAdminMfa && (await hasAdminGrant(db, now.id))) return no("second-factor-required");
		const opened = await openOn(app, db, current, cookie, about);
		if (!opened) throw new Stop(no("changed-meanwhile"));
		if (rehashed === null) await noteCredentialUse(db, current.id, app.now());
		else if (!(await rehashPassword(db, current, rehashed, app.now()))) throw new Stop(no("changed-meanwhile"));
		return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } } as const;
	});
}

export type PasswordChange =
	| { ok: true; sessionsEnded: number }
	| {
			ok: false;
			why:
				| "not-signed-in"
				| "not-a-person"
				| "current-required"
				| "wrong-current"
				| "changed-meanwhile"
				| "busy"
				| "recent-proof";
	  }
	| Limited;

/**
 * Sets a person's password, or replaces it. `who` and `session` are the caller's browser session, asked again
 * inside the commit: the person it signs in, and its row.
 *
 * The current password is required when there is one, so a browser left open is not enough to lock its owner
 * out. It is a guess like any other at that person's password: it is counted under `address`, where the
 * request came from, and under the person's name, with the sign-ins for that name, and is not looked at while
 * either is blocked. The old row is revoked and a new one made. The sessions that rested on the old password end, but for the
 * one that made the change, which rests on the new password from then on.
 */
export async function changePassword(
	app: App,
	input: {
		who: (db?: ReadDb) => Promise<{ id: number; name: string } | null>;
		session: (db: ReadDb) => Promise<number | null>;
		context: (db: ReadDb) => Promise<string | null>;
		current: string | undefined;
		next: string;
		address: string | null;
	},
): Promise<PasswordChange> {
	const caller = await input.who();
	if (!caller) return { ok: false, why: "not-signed-in" };
	const person = await app.database.read(async (readDb) => await readDb.get(Q.personById, { id: caller.id }));
	if (!person) return { ok: false, why: "not-a-person" };
	const held = await app.database.read(async (readDb) => await livePassword(readDb, person.id));
	let hash: string;
	try {
		if (held) {
			if (input.current === undefined) return { ok: false, why: "current-required" };
			const checked = await checkPassword(app, {
				password: input.current,
				stored: held.data,
				name: person.name,
				address: input.address,
				holder: person.id,
			});
			if (typeof checked !== "string") return checked;
			if (checked === "wrong") return { ok: false, why: "wrong-current" };
		}
		hash = await hashPassword(input.next, app.config.passwordCost);
	} catch (error) {
		if (error instanceof PasswordWorkBusy) return { ok: false, why: "busy" };
		throw error;
	}
	return await app.database.write(
		async (db) =>
			await db.transaction(async (): Promise<PasswordChange> => {
				await lockActors(db, [person.id], true);
				// Recheck the session and credential after the actor lock wait.
				const still = await input.who(db);
				const session = await input.session(db);
				const now = await db.get(Q.personById, { id: person.id });
				if (!still || session === null || !now || still.id !== now.id || now.name !== person.name)
					return { ok: false, why: "not-signed-in" };
				// The same password as was verified, by its hash, or none as before: else somebody changed it meanwhile.
				const current = await livePassword(db, now.id);
				if ((current?.data ?? null) !== (held?.data ?? null)) return { ok: false, why: "changed-meanwhile" };
				const at = app.now();
				const proof = { actor: now.id, context: await input.context(db) };
				if (current && !(await dateSessionProof(app, db, proof))) return { ok: false, why: "not-signed-in" };
				try {
					await requireRecentProof(app, db, proof, true);
				} catch (error) {
					if (error instanceof OpError && error.code === "recent_proof_required")
						return { ok: false, why: "recent-proof" };
					throw error;
				}
				if (current) await revokeCredential(db, current.id, at);
				const made = await insertPassword(db, { actor: now.id, hash, at });
				await credentialNotice(app, db, now.id, current ? "Your password was changed" : "A password was added");
				if (!current) return { ok: true, sessionsEnded: 0 };
				await restSession(db, { session, from: current.id, to: made });
				return { ok: true, sessionsEnded: await endSessionsOn(db, current.id, at) };
			}),
	);
}

// ── A passkey ──────────────────────────────────────────────────────────────────────────────────────────────

export async function beginCredentialProof(app: App, db: ReadDb, input: ProofContext): Promise<AssertionOptions> {
	const session = await proofSession(app, input, db);
	if (!session || input.context === null) throw forbidden("confirm a credential from a session that is signed in");
	const party = mustHavePasskeys(app);
	return assertionOptions({
		rpId: party.id,
		challenge: await issueChallenge(app, { purpose: "prove", actor: input.actor, context: input.context }, party),
		allow: (await liveCredentials(db, input.actor)).flatMap((row) => storedPasskey(row) ?? []),
	});
}

type CredentialProof = { password: string } | { passkey: unknown } | { code: string };

/** Verifies outside the gate, then rechecks the exact credential and session before dating this session. */
export async function proveCredential(
	app: App,
	input: ProofContext & { proof: CredentialProof; address: string | null },
): Promise<{ ok: true } | Refused | Limited> {
	if (!(await app.database.read(async (db) => await proofSession(app, input, db)))) return no("context");
	const person = await app.database.read(async (readDb) => await readDb.get(Q.personById, { id: input.actor }));
	if (!person) return no("unknown-name");
	const proof = input.proof;
	if ("passkey" in proof) {
		const attempt = await byAddress(app, input.address);
		const first = await app.database.read(
			async (readDb) => await judgeAssertion(app, readDb, proof.passkey, null, input),
		);
		if (!first.ok) return attempt.wrong(first);
		return await commit(app, { identity: [person.id] }, async (db) => {
			if (!(await proofSession(app, input, db))) return no("context");
			const now = await judgeAssertion(app, db, proof.passkey, null, input);
			if (!now.ok) return attempt.wrong(now);
			if (now.row.data !== first.row.data || now.row.handle !== first.row.handle) return no("changed-meanwhile");
			if (!(await countPasskeyUse(db, now.row, now.shown, app.now())) || !(await dateSessionProof(app, db, input)))
				throw new Stop(no("changed-meanwhile"));
			if (!(await spendChallenge(app, now.challenge, db))) throw new Stop(no("challenge"));
			return { ok: true } as const;
		});
	}
	const row =
		"password" in proof
			? await app.database.read(async (readDb) => await livePassword(readDb, person.id))
			: await app.database.read(async (readDb) => await liveTotp(readDb, person.id));
	if ("password" in proof) {
		try {
			const checked = await checkPassword(app, {
				password: proof.password,
				stored: row?.data ?? (await dummyHash(app.config.passwordCost)),
				name: person.name,
				address: input.address,
				holder: person.id,
			});
			if (typeof checked !== "string") return checked;
			if (!row || checked === "wrong") return no("wrong-password");
		} catch (error) {
			if (error instanceof PasswordWorkBusy) return no("busy");
			throw error;
		}
		return await commit(app, { identity: [person.id] }, async (db) => {
			const current = await livePassword(db, person.id);
			if (!(await proofSession(app, input, db)) || current?.id !== row.id || current.data !== row.data)
				return no("changed-meanwhile");
			if (!(await dateSessionProof(app, db, input))) return no("context");
			await noteCredentialUse(db, current.id, app.now());
			return { ok: true } as const;
		});
	}
	const attempt = await factorAttempt(app, { kind: "sign-in", name: person.name, address: input.address });
	if (attempt.answer.kind === "blocked") return waiting(attempt.answer);
	const stored = row ? readTotp(row.data) : null;
	const next = stored && /^\d{6}$/.test(proof.code) ? acceptTotp(stored, proof.code, app.now()) : null;
	if (!row || !stored || !next) {
		const failed = await attempt.limiter.failed(attempt.keys, app.now());
		return failed.kind === "blocked" ? waiting(failed) : no("wrong-code");
	}
	return await commit(app, { identity: [person.id] }, async (db) => {
		const current = await liveTotp(db, person.id);
		if (!(await proofSession(app, input, db)) || current?.id !== row.id || current.data !== row.data)
			return no("changed-meanwhile");
		const limit = await attempt.limiter.check(attempt.keys, app.now());
		if (limit.kind === "blocked") return waiting(limit);
		// Checked again at the write's time, and that result is what is kept: a step later than the first check
		// is the one the code was spent on.
		const accepted = acceptTotp(stored, proof.code, app.now());
		if (!accepted) return no("wrong-code");
		if (
			!(await updateTotp(db, current, JSON.stringify(accepted), app.now())) ||
			!(await dateSessionProof(app, db, input))
		)
			throw new Stop(no("changed-meanwhile"));
		await attempt.limiter.succeeded([attempt.account], limit.version);
		return { ok: true } as const;
	});
}

/**
 * What a page passes to the browser to sign in with a passkey, with a new challenge. It names no passkey: the
 * browser offers the ones it holds for this instance, so nobody types a name first and the reply says nothing
 * about who has a passkey. Null on an instance with no public address.
 *
 * Nobody is signed in, so the ceremony is tied to the browser that asks: `ceremony` is a new random secret the
 * surface hands that browser as a cookie for `lastsMs`, and the challenge keeps its SHA-256. The answer is
 * taken only with that cookie (`signInWithPasskey`).
 */
export async function passkeySignInOptions(
	app: App,
	source: string | null,
	client: "web" | "native" = "web",
): Promise<{ options: AssertionOptions; ceremony: string; lastsMs: number } | Limited | null> {
	const address = publicAddress(app.config);
	if (!address) return null;
	if (client === "native" && !address.url.startsWith("https://")) return null;
	const quota = await takeStart(app, source);
	if (quota.kind === "blocked") return waiting(quota);
	// Native AuthenticationServices uses the HTTPS RP ID as its origin, without a port.
	// Record it in this challenge, leaving browser challenges bound to the configured web origin.
	const party = client === "native" ? { ...address.party, origin: `https://${address.party.id}` } : address.party;
	const ceremony = newSessionSecret();
	const context = CONTEXT.browser(hashOf(ceremony));
	return {
		options: assertionOptions({
			rpId: address.party.id,
			challenge: await issueChallenge(
				app,
				{ purpose: "sign-in", context },
				party,
				startAddressKey(source) ?? "unknown",
			),
			allow: [],
		}),
		ceremony,
		lastsMs: CEREMONY_MS,
	};
}

/**
 * Judges a passkey's answer to a sign-in challenge against the rows of `db`. The person is the one the stored
 * row names, found by the credential id; nothing else in the answer chooses who signs in. The sign-in named no
 * passkey, so the answer must carry the user handle, and it must be that person's. `ceremony` is the ceremony
 * cookie the request carried, or null: the answer is taken only from the browser its challenge was issued to.
 * A recent-proof challenge already knows its person and offers their credentials, so its user handle may be
 * absent; one returned must still match. Its session context and credential ownership identify the person.
 */
async function judgeAssertion(
	app: App,
	db: ReadDb,
	answer: unknown,
	ceremony: string | null,
	proof?: ProofContext,
): Promise<{ ok: true; row: CredentialRow; person: Person; shown: Assertion; challenge: string } | Refused> {
	const parsed = AssertionResponse.safeParse(answer);
	const challenge = challengeOf(answer);
	if (!parsed.success || challenge === null) return no("input");
	const found = proof
		? await findChallenge(app, challenge, "prove", db)
		: await findChallenge(app, challenge, "sign-in", db);
	if (!found) return no("challenge");
	if (
		proof
			? found.ceremony.context !== proof.context
			: ceremony === null || found.ceremony.context !== CONTEXT.browser(hashOf(ceremony))
	)
		return no("context");
	const row = await passkeyByCredentialId(db, parsed.data.id);
	if (!row) return no("unknown-passkey");
	if (
		proof &&
		(row.actor !== proof.actor || found.ceremony.purpose !== "prove" || found.ceremony.actor !== proof.actor)
	)
		return no("context");
	const person = row.revoked_at === null ? await db.get(Q.personById, { id: row.actor }) : null;
	const stored = storedPasskey(row);
	// A removed passkey's row holds no key any more, and a forgotten person's passkeys were revoked with them.
	if (!person || !stored) return no("revoked-passkey");
	const handle = parsed.data.userHandle ?? null;
	if ((!proof && handle === null) || (handle !== null && handle !== (await userHandleOf(db, person.id))))
		return no("user-handle");
	const verdict = verifyAssertion(
		parsed.data,
		{
			credentialId: stored.credentialId,
			publicKey: stored.key,
			algorithm: stored.algorithm,
			signCount: stored.counter,
		},
		found.expected,
	);
	// A counter that did not grow is the one refusal that says something of a credential: a copy may exist.
	if (!verdict.ok) return verdict.reason === "possibly-cloned" ? no(verdict.reason, row.id) : no(verdict.reason);
	return { ok: true, row, person, shown: verdict.value, challenge };
}

/**
 * Signs a person in with a passkey's answer to a challenge of `passkeySignInOptions`.
 *
 * The answer is judged twice: at once, so that nothing wrong ever waits at the gate, and again in the commit
 * against the rows as they are then. The second time is the one that counts. It is where the counter is
 * compared with the stored one for good, where the challenge is found still unspent, and where the new counter
 * is stored, the challenge spent and the session opened, all or none.
 *
 * An answer that is refused, the first time or the second, is counted under the address it came from. A right
 * one signs in from an address that is blocked: nobody guesses a signature (`byAddress`).
 *
 * `ceremony` is the value of the ceremony cookie the request carried (`passkeySignInOptions`), or null. An
 * answer without the cookie of the browser that asked for its challenge is refused like any other.
 */
export async function signInWithPasskey(
	app: App,
	input: { answer: unknown; ceremony: string | null },
	about: About,
): Promise<Entry> {
	const { answer, ceremony } = input;
	const attempt = await byAddress(app, about.address);
	const first = await app.database.admissionRead(async (readDb) => await judgeAssertion(app, readDb, answer, ceremony));
	if (!first.ok) return attempt.wrong(first);
	about.proven?.();
	const cookie = newSessionSecret();
	const entry = await commit(app, { signIn: first.row.actor }, async (db) => {
		const now = await judgeAssertion(app, db, answer, ceremony);
		if (!now.ok) return now;
		if (now.row.actor !== first.row.actor) throw new Busy();
		const opened = await openOn(app, db, now.row, cookie, about);
		if (!opened || !(await countPasskeyUse(db, now.row, now.shown, app.now()))) throw new Stop(no("changed-meanwhile"));
		if (!(await spendChallenge(app, now.challenge, db))) throw new Stop(no("challenge"));
		return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } } as const;
	});
	// A row that changed under a good answer is nobody's wrong guess. Anything else the commit refused is one.
	return entry.ok || entry.why === "changed-meanwhile" ? entry : attempt.wrong(entry);
}

/**
 * The options for a new passkey of one person, using the challenge its caller issued for that ceremony.
 */
function registrationFor(input: {
	party: RelyingParty;
	person: Person;
	userHandle: string;
	challenge: Challenge;
	exclude: readonly CredentialRow[];
}): RegistrationOptions {
	const { party, person, userHandle, challenge, exclude } = input;
	return registrationOptions({
		rpId: party.id,
		rpName: RP_NAME,
		user: { handle: userHandle, name: person.name, displayName: person.name },
		challenge,
		exclude: exclude.flatMap((row) => storedPasskey(row) ?? []),
	});
}

/**
 * Judges the answer to a registration challenge, for one person. The challenge must be one issued for a
 * registration of this very person, who is named in it by the handle their passkeys are filed under, and
 * issued where this answer comes from (`context`): the same session, or the same invitation. The credential
 * id must be on no row, live or revoked, of anybody.
 */
async function judgeRegistration(
	app: App,
	db: ReadDb,
	input: { person: Person; answer: unknown; context: string },
): Promise<{ ok: true; passkey: Passkey; challenge: string } | Refused> {
	const { person, answer, context } = input;
	const challenge = challengeOf(answer);
	if (challenge === null) return no("input");
	const found = await findChallenge(app, challenge, "register", db);
	const handle = await userHandleOf(db, person.id);
	if (!found || handle === null || found.ceremony.userHandle !== handle) return no("challenge");
	if (found.ceremony.context !== context) return no("context");
	const verdict = verifyRegistration(answer, found.expected);
	if (!verdict.ok) return no(verdict.reason);
	if (await passkeyByCredentialId(db, verdict.value.credentialId)) return no("credential-exists");
	return { ok: true, passkey: verdict.value, challenge };
}
async function mustBePerson(db: ReadDb, actor: number): Promise<Person> {
	const person = await db.get(Q.personById, { id: actor });
	if (!person) throw invalid("only a person has a password or a passkey");
	return person;
}

/**
 * Begins the registration of a passkey for a signed-in person: what the page passes to the browser. In the
 * operation's transaction, because the person's handle is made here the first time.
 *
 * `context` is where the caller is signed in (`Session.context`): the registration is completed there and
 * nowhere else, so another session of the same person does not store a passkey this one asked for.
 */
export async function beginPasskey(
	app: App,
	db: WriteDb,
	input: { actor: number; context: string },
): Promise<RegistrationOptions> {
	await lockIdentity(db);
	await requireRecentProof(app, db, input, true);
	const party = mustHavePasskeys(app);
	const person = await mustBePerson(db, input.actor);
	const userHandle = await ensureUserHandle(db, person.id, app.now());
	return registrationFor({
		party,
		person,
		userHandle,
		challenge: await issueChallenge(
			app,
			{ purpose: "register", userHandle, context: input.context },
			party,
			input.context,
			db,
		),
		exclude: await liveCredentials(db, person.id),
	});
}

/**
 * Stores the passkey a signed-in person registered, and spends its challenge, in the operation's transaction.
 * The refusal says what the verifier found, as a code: the caller is the person whose own key it is.
 */
export async function addPasskey(
	app: App,
	db: WriteDb,
	input: { actor: number; context: string; answer: unknown; label: string },
): Promise<{ id: number; label: string }> {
	await lockIdentity(db);
	await requireRecentProof(app, db, input, true);
	mustHavePasskeys(app);
	const person = await mustBePerson(db, input.actor);
	const judged = await judgeRegistration(app, db, { person, answer: input.answer, context: input.context });
	if (!judged.ok) {
		if (judged.why === "credential-exists")
			throw conflict("this passkey is registered on this instance already; a passkey is registered once");
		throw invalid(
			`the passkey was not accepted (${judged.why}). Begin again: a registration answers the challenge it was given, once, within five minutes`,
		);
	}
	if (!(await spendChallenge(app, judged.challenge, db))) throw invalid("this passkey registration ended; begin again");
	const row = await insertPasskey(db, {
		actor: person.id,
		passkey: judged.passkey,
		label: input.label,
		at: app.now(),
	});
	await credentialNotice(app, db, person.id, "A passkey was added");
	return { id: row.id, label: row.label };
}

// ── Credentials, as a signed-in person sees them ───────────────────────────────────────────────────────────

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

/** How a notice names a credential of each kind. */
const REMOVED: Record<CredentialRow["kind"], string> = {
	password: "A password",
	passkey: "A passkey",
	oidc: "An identity provider sign-in",
	totp: "An authenticator",
};

/**
 * Removes one way a person signs in, and ends the sessions that rest on it. The last one stays: with none, the
 * person could not sign in to add another, and only an admin's recovery link would let them back.
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
	const requiresFactor = app.config.requireAdminMfa && (await hasAdminGrant(db, row.actor));
	if (row.kind === "totp" && requiresFactor && (await livePassword(db, row.actor)))
		throw forbidden(
			"this instance requires a second factor for admins with a password; remove the password first to use only passkeys",
		);
	const passwordWorks = !requiresFactor || (await liveTotp(db, row.actor)) !== null;
	// An identity is a way in only at the provider the instance is configured with now.
	const provider = app.config.oidc ? `${app.config.oidc.issuer}#` : null;
	const identityWorks = (held: CredentialRow): boolean =>
		provider !== null && held.handle?.startsWith(provider) === true && (!requiresFactor || providerVouches(app));
	const waysIn = (await liveCredentials(db, row.actor)).filter(
		(held) =>
			held.kind === "passkey" ||
			(held.kind === "password" && passwordWorks) ||
			(held.kind === "oidc" && identityWorks(held)),
	);
	if (row.kind === "passkey" && !passwordWorks && waysIn.length <= 1)
		throw invalid(
			"this is the last way to sign in because this instance requires a second factor for admins; add another passkey or enrol an authenticator first, then remove this passkey",
		);
	if (row.kind !== "totp" && waysIn.filter((held) => held.id !== row.id).length === 0) {
		const name = (await db.get(Q.nameOf, { id: row.actor }))?.name ?? "this person";
		throw invalid(
			`this is the last way ${name} signs in, so it stays. Add a passkey or set a password first, then remove this one. If it is lost, an admin can make a recovery link (mainworthy invite new ${name})`,
		);
	}
	const at = app.now();
	await revokeCredential(db, id, at);
	await credentialNotice(app, db, row.actor, `${REMOVED[row.kind]} was removed`);
	return {
		removed: true,
		sessionsEnded:
			row.kind === "totp" ? await endSessionsOf(db, row.actor, at, "ended") : await endSessionsOn(db, id, at),
	};
}

// ── An invitation ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Makes an invitation for a person and returns its code, which is shown once and of which only the SHA-256 is
 * stored. In the operation's transaction. A new invitation replaces the person's earlier ones that nobody
 * accepted, so one link is good for a person at a time. The person's passkey handle is made here if there is
 * none. Showing its page can allocate a separate short-lived passkey challenge.
 */
export async function createInvitation(
	app: App,
	db: WriteDb,
	input: { actor: number; by: number; purpose: InvitationPurpose; lastsMs: number; context: string | null },
): Promise<{ id: number; code: string; link: string; expiresAt: number }> {
	await lockIdentity(db);
	if (input.context !== null) await requireRecentProof(app, db, { actor: input.by, context: input.context });
	const at = app.now();
	await revokeInvitationsOf(db, input.actor, at);
	await ensureUserHandle(db, input.actor, at);
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
 * What the page of an invitation shows: who it is for, what accepting does and when it runs out, and the
 * options for registering a passkey with it (null on an instance with no public address). Null for a code
 * that accepts nothing, whatever the reason. Showing the page never consumes the invitation. A working
 * invitation reuses its stored registration challenge so reloads do not fill the ceremony table. Near expiry a successor leaves the old prompt valid until its end.
 *
 * The options exclude no passkey: whoever holds a recovery code is not told which authenticators the person
 * had, and accepting revokes those anyway.
 *
 * A right code is proof of the invitation, so its page stays reachable during either address block.
 */
export async function showInvitation(
	app: App,
	code: string,
	address: string | null,
): Promise<
	| {
			ok: true;
			shown: {
				invitation: { name: string; purpose: InvitationPurpose; expiresAt: number };
				passkey: RegistrationOptions | null;
			};
	  }
	| Refused
	| Limited
> {
	const hash = hashOf(code);
	const found = await app.database.admissionRead(async (readDb) => {
		const opened = await openInvitation(app, readDb, hash);
		return opened ? { ...opened, handle: await userHandleOf(readDb, opened.person.id) } : null;
	});
	if (!found) return (await byAddress(app, address)).wrong(no("invitation"));
	const { invitation, person } = found;
	const party = publicAddress(app.config)?.party;
	const { handle } = found;
	const passkey =
		party && handle !== null ? await invitationChallenge(app, { codeHash: hash, userHandle: handle }, party) : null;
	return {
		ok: true,
		shown: {
			invitation: { name: person.name, purpose: invitation.purpose, expiresAt: invitation.expires_at },
			// The challenge is this invitation's, by the hash of its code: another invitation for the same person
			// does not accept a passkey made for this one.
			passkey:
				party && handle !== null && passkey
					? {
							...registrationFor({
								party,
								person,
								userHandle: handle,
								challenge: passkey.challenge,
								exclude: [],
							}),
							timeout: passkey.timeout,
						}
					: null,
		},
	};
}

/** Who a browser is signed in as, by its session cookie, and null when the cookie names no session that is alive. */
async function holderOf(app: App, cookie: string, db?: ReadDb): Promise<{ id: number; name: string } | null> {
	const actor = (await findSession(app, hashOf(cookie), db ? { db } : {}))?.actor;
	return actor ? { id: actor.id, name: actor.name } : null;
}

export type Accepted = Entry | { ok: false; why: "other-session"; signedInAs: string };

/**
 * Accepts an invitation with a password, a passkey or both, and signs the person in.
 *
 * One transaction stores what the person will sign in with, spends the invitation and opens the session. An
 * invitation to recover also revokes, there, every credential and token the person had and ends every session of
 * theirs: until it is accepted nothing of theirs changes, so a link that is never used locks nobody out.
 *
 * `browser` is the session cookie the request carried, if any. When it signs in somebody else, the invitation
 * is accepted only when `replace` is that person's name, and that session ends in the same transaction: the
 * page asked about them first. A yes about one person ends no other person's session: who the browser holds
 * is asked again in the commit, and the answer names whoever that is now, so the page can ask again. With no
 * session, or the invited person's own, `replace` ends nothing.
 * The new session rests on the passkey when there is one, else on the password.
 */
export async function acceptInvitation(
	app: App,
	input: {
		code: string;
		password: string | undefined;
		passkey: unknown;
		label: string | undefined;
		replace: string | null;
		browser: string | null;
	},
	about: About,
): Promise<Accepted> {
	const { code, ...rest } = input;
	return await acceptByHash(app, hashOf(code), { ...rest, identity: null }, about);
}

/**
 * `acceptInvitation` for an invitation known by the hash of its code, which is how a ceremony with the provider
 * keeps it. `identity` is what the provider vouched for, stored as the person's way in instead of a password
 * or a passkey.
 */
async function acceptByHash(
	app: App,
	hash: string,
	input: {
		password: string | undefined;
		passkey: unknown;
		label: string | undefined;
		replace: string | null;
		browser: string | null;
		identity: { handle: string; label: string; generation: string; replaceActor: number | null } | null;
	},
	about: About,
): Promise<Accepted> {
	const judge = async (db: ReadDb) => {
		const found = await openInvitation(app, db, hash);
		if (!found) return no("invitation");
		if (input.passkey === undefined) return { ok: true, ...found, registration: null } as const;
		const registration = await judgeRegistration(app, db, {
			person: found.person,
			answer: input.passkey,
			context: CONTEXT.invitation(hash),
		});
		return registration.ok ? ({ ok: true, ...found, registration } as const) : registration;
	};
	const attempt = await byAddress(app, about.address);
	const first = await app.database.admissionRead(async (readDb) => await judge(readDb));
	// A code that accepts nothing is a wrong guess at one, and is counted. A good code with a passkey that was
	// not accepted is somebody who holds the invitation, and is not.
	if (!first.ok) return first.why === "invitation" ? attempt.wrong(first) : first;
	// Somebody other than `person` whom the browser's cookie signs in now, and whether the page said their name.
	// Nothing of this is carried over the wait at the gate: it is asked here, and asked again in the commit.
	const elsewhere = async (
		person: { id: number },
		db?: ReadDb,
	): Promise<{ id: number; name: string; agreed: boolean } | null> => {
		const holder = input.browser === null ? null : await holderOf(app, input.browser, db);
		return holder && holder.id !== person.id
			? {
					id: holder.id,
					name: holder.name,
					agreed: input.identity ? input.identity.replaceActor === holder.id : input.replace === holder.name,
				}
			: null;
	};
	const unasked = (held: { name: string; agreed: boolean } | null): Accepted | null =>
		held && !held.agreed ? { ok: false, why: "other-session", signedInAs: held.name } : null;
	// Said before a password is hashed for an acceptance that cannot go through as it stands.
	const early = unasked(await elsewhere(first.person));
	if (early) return early;
	about.proven?.();
	let passwordHash: string | null = null;
	try {
		if (input.password !== undefined) passwordHash = await hashPassword(input.password, app.config.passwordCost);
	} catch (error) {
		if (error instanceof PasswordWorkBusy) return no("busy");
		throw error;
	}
	const cookie = newSessionSecret();
	const replacing = input.browser === null ? null : await holderOf(app, input.browser);
	return await commit(
		app,
		{ identity: [first.person.id, ...(replacing ? [replacing.id] : [])] },
		async (db): Promise<Accepted> => {
			if (input.identity && !(await holdCeremonyGeneration(db, input.identity.generation))) return no("challenge");
			const now = await judge(db);
			if (!now.ok) return now;
			const { invitation, person, registration } = now;
			if (person.id !== first.person.id) throw new Busy();
			const vouched = input.identity !== null && providerVouches(app);
			if (!registration && !vouched && app.config.requireAdminMfa && (await hasAdminGrant(db, person.id)))
				return no("second-factor-required");
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
				await clearMailLinksOf(db, person.id);
			} else if ((await liveCredentials(db, person.id)).length > 0) throw new Stop(no("has-credentials"));
			let root: CredentialRow | null = null;
			if (passwordHash !== null)
				root = await credentialById(db, await insertPassword(db, { actor: person.id, hash: passwordHash, at }));
			if (input.identity) {
				if (await oidcByHandle(db, input.identity.handle)) throw new Stop(no("credential-exists"));
				root = await insertOidc(db, { actor: person.id, ...input.identity, at });
			}
			if (registration)
				root = await insertPasskey(db, {
					actor: person.id,
					passkey: registration.passkey,
					label: input.label ?? "passkey",
					at,
				});
			if (!root) throw new Stop(no("input"));
			const opened = await openOn(app, db, root, cookie, about);
			if (!opened) throw new Stop(no("changed-meanwhile"));
			// What was just stored signed its person in, and says so: a list does not call it "never used".
			for (const row of await liveCredentials(db, person.id)) await noteCredentialUse(db, row.id, at);
			// The browser was somebody else's until now, and the page said whose. That session ends as a sign-out does.
			if (input.browser !== null && held) await endSession(app, db, hashOf(input.browser), "signed-out");
			if (registration && !(await spendChallenge(app, registration.challenge, db))) throw new Stop(no("challenge"));
			await credentialNotice(
				app,
				db,
				person.id,
				invitation.purpose === "recover"
					? "Your sign-in methods were replaced through account recovery"
					: "Your sign-in methods were added",
			);
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
	| { purpose: "link"; actor: number; browser: string };

export type OidcBegun =
	| { ok: true; url: string; ceremony: string; lastsMs: number }
	| Refused
	| Limited
	| { ok: false; why: "other-session"; signedInAs: string }
	| { ok: false; why: "unreachable" | "not-a-person" };

/**
 * Begins signing in, accepting an invitation or linking through the provider: where the browser goes next, and
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
						await requireRecentProof(app, db, { actor: start.actor, context: CONTEXT.session(hashOf(start.browser)) }),
				),
		);
		purpose = { purpose: "link", actor: start.actor, session: hashOf(start.browser) };
	} else purpose = start;
	const ceremony = newSessionSecret();
	const url = await beginOidc(app, { purpose, browser: hashOf(ceremony), redirect, address });
	if (url !== null && typeof url !== "string") return waiting(url);
	return url === null ? { ok: false, why: "unreachable" } : { ok: true, url, ceremony, lastsMs: CEREMONY_MS };
}

export type OidcFinished = Accepted | { ok: true; linked: true } | { ok: false; why: "linked-already" };

/**
 * Finishes what `beginOidcSignIn` began, with the query the provider sent the browser back with. `ceremony` is
 * the ceremony cookie the request carried and `browser` its session cookie, each or null. A refused answer is
 * counted under the address, as a passkey's is: nobody guesses a provider's signature.
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
	if (purpose.purpose === "native") return no("context");
	const handle = oidcHandle(identity);
	const label = identityLabel(app, identity);
	if (purpose.purpose === "join") {
		return await acceptByHash(
			app,
			purpose.invitation,
			{
				password: undefined,
				passkey: undefined,
				label: undefined,
				replace: null,
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
			await requireRecentProof(app, db, { actor: linking.actor, context: CONTEXT.session(linking.session) });
			if (await oidcByHandle(db, handle)) return { ok: false, why: "linked-already" };
			await insertOidc(db, { actor: linking.actor, handle, label, at: app.now() });
			await credentialNotice(app, db, linking.actor, "An identity provider sign-in was added");
			return { ok: true, linked: true };
		});
	}
	return await openOidcSession(app, { identity, generation: judged.generation }, about);
}

async function openOidcSession(
	app: App,
	input: { identity: Identity; generation: string } | { native: NativeOidcExchange },
	about: About,
): Promise<Entry> {
	const attempt = await byAddress(app, about.address);
	if ("native" in input && !(await findNativeOidc(app, input.native))) return attempt.wrong(no("challenge"));
	about.proven?.();
	const cookie = newSessionSecret();
	const initial = "native" in input ? await findNativeOidc(app, input.native) : null;
	const hint = await app.database.admissionRead((db) =>
		"identity" in input
			? oidcByHandle(db, oidcHandle(input.identity))
			: initial
				? credentialById(db, initial.credential)
				: Promise.resolve(null),
	);
	const entry = await commit(app, { signIn: hint?.actor ?? null }, async (db): Promise<Entry> => {
		if ("identity" in input && !(await holdCeremonyGeneration(db, input.generation))) return no("challenge");
		const handoff = "native" in input ? await takeNativeOidc(app, input.native, db) : null;
		if ("native" in input && !handoff) return no("challenge");
		if ("native" in input && input.native.instance !== publicAddress(app.config)?.url) return no("context");
		if (!app.config.oidc || ("identity" in input && input.identity.issuer !== app.config.oidc.issuer))
			return no("changed-meanwhile");
		const row =
			"identity" in input
				? await oidcByHandle(db, oidcHandle(input.identity))
				: handoff
					? await credentialById(db, handoff.credential)
					: null;
		if (
			handoff &&
			(!row ||
				row.actor !== handoff.actor ||
				row.kind !== "oidc" ||
				row.revoked_at !== null ||
				!row.handle?.startsWith(`${app.config.oidc.issuer}#`))
		)
			return no("changed-meanwhile");
		if (row && row.actor !== hint?.actor) throw new Busy();
		const person = row ? await db.get(Q.personById, { id: row.actor }) : null;
		if (!row || !person) return no("unknown-identity");
		if (app.config.requireAdminMfa && (await hasAdminGrant(db, person.id)) && !providerVouches(app))
			return no("second-factor-required");
		const opened = await openOn(app, db, row, cookie, about);
		if (!opened) throw new Stop(no("changed-meanwhile"));
		await noteCredentialUse(db, row.id, app.now());
		return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } };
	});
	// An identity nobody linked is somebody trying; a person refused by the rule for admins, or a row that changed
	// under a good answer, is not.
	return entry.ok ||
		entry.why === "limited" ||
		entry.why === "changed-meanwhile" ||
		entry.why === "second-factor-required"
		? entry
		: attempt.wrong(entry);
}

async function factorAttempt(app: App, input: { kind: "sign-in" | "enrol"; name: string; address: string | null }) {
	const limiter = limiterOf(app);
	const account = `${input.kind === "enrol" ? "totp-enrol" : "totp"}:${input.name}`;
	const keys = counted(addressKey(input.address), account);
	const answer = await limiter.check(keys, app.now());
	return { limiter, account, keys, answer };
}

export async function signInWithTotp(
	app: App,
	input: { challenge: string; code: string; ceremony: string | null },
	about: About,
): Promise<Entry> {
	const initial = await findTotp(app, input.challenge, "sign-in");
	if (!initial || input.ceremony === null || initial.context !== CONTEXT.browser(secretHash(input.ceremony)))
		return (await byAddress(app, about.address)).wrong(no("challenge"));
	const factorPerson = await app.database.admissionRead((db) => db.get(Q.personById, { id: initial.actor }));
	if (!factorPerson) return no("changed-meanwhile");
	const attempt = await factorAttempt(app, { kind: "sign-in", name: factorPerson.name, address: about.address });
	if (attempt.answer.kind === "blocked") return waiting(attempt.answer);
	const cookie = newSessionSecret();
	return await commit(app, { signIn: factorPerson.id }, async (db) => {
		const held = await findTotp(app, input.challenge, "sign-in", db);
		if (!held || held.context !== initial.context || held.actor !== initial.actor) return no("challenge");
		const person = await db.get(Q.personById, { id: held.actor });
		if (person && person.id !== factorPerson?.id) throw new Busy();
		const password = person ? await livePassword(db, person.id) : null;
		const factor = person ? await liveTotp(db, person.id) : null;
		if (!password || secretHash(password.data) !== held.password || !factor || factor.id !== held.factor)
			return no("changed-meanwhile");
		const currentLimit = await attempt.limiter.check(attempt.keys, app.now());
		if (currentLimit.kind === "blocked") return waiting(currentLimit);
		const stored = readTotp(factor.data);
		const next = stored ? acceptTotp(stored, input.code, app.now()) : null;
		if (!next) {
			const failed = await attempt.limiter.failed(attempt.keys, app.now());
			return failed.kind === "blocked" ? waiting(failed) : no("wrong-code");
		}
		const opened = await openOn(app, db, password, cookie, about);
		if (!opened || !(await updateTotp(db, factor, JSON.stringify(next), app.now())))
			throw new Stop(no("changed-meanwhile"));
		await noteCredentialUse(db, password.id, app.now());
		if (!(await spendTotp(app, input.challenge, db))) throw new Stop(no("challenge"));
		await attempt.limiter.succeeded([attempt.account], currentLimit.version);
		about.proven?.();
		return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } } as const;
	});
}

export async function beginTotp(app: App, db: WriteDb, input: { actor: number; context: string }) {
	await requireRecentProof(app, db, input);
	const person = await mustBePerson(db, input.actor);
	if (await liveTotp(db, person.id))
		throw conflict("an authenticator is enrolled already; remove it before enrolling another");
	const secret = newTotpSecret();
	return {
		...(await issueTotp(app, { kind: "enrol", actor: person.id, context: input.context, secret }, db)),
		...provisioning(secret, person.name),
	};
}

export async function confirmTotp(
	app: App,
	db: WriteDb,
	input: { actor: number; session: number | null; context: string; challenge: string; code: string },
) {
	await lockIdentity(db);
	await requireRecentProof(app, db, input);
	const person = await mustBePerson(db, input.actor);
	const held = await findTotp(app, input.challenge, "enrol", db);
	if (!held || held.actor !== person.id || held.context !== input.context)
		throw invalid("this authenticator enrolment ended; begin again in the same session");
	if (await liveTotp(db, person.id)) throw conflict("an authenticator is enrolled already");
	const attempt = await factorAttempt(app, { kind: "enrol", name: person.name, address: null });
	if (attempt.answer.kind === "blocked")
		throw new OpError("limited", `wait ${attempt.answer.retryAfterSeconds} seconds before trying another code`);
	const stored = acceptTotp({ secret: held.secret, lastStep: -1, recovery: [] }, input.code, app.now());
	if (!stored) {
		const failed = await attempt.limiter.failed(attempt.keys, app.now());
		if (failed.kind === "blocked")
			throw new OpError("limited", `wait ${failed.retryAfterSeconds} seconds before trying another code`);
		throw invalid("that authenticator code was not accepted");
	}
	if (!(await spendTotp(app, input.challenge, db))) throw invalid("this authenticator enrolment ended; begin again");
	const recovery = recoveryCodes();
	const at = app.now();
	const id = await insertTotp(db, {
		actor: person.id,
		data: JSON.stringify({ ...stored, recovery: recovery.hashes }),
		at,
	});
	const sessionsEnded = await endOtherSessions(db, person.id, input.session, at);
	await credentialNotice(app, db, person.id, "An authenticator was added");
	await attempt.limiter.succeeded([attempt.account], attempt.answer.version);
	return { id, recoveryCodes: recovery.codes, sessionsEnded };
}

export async function beginNativeOidc(
	app: App,
	request: NativeOidcRequest,
	address: string | null,
): Promise<string | Limited | null> {
	const redirect = oidcRedirect(app).replace("/signin/oidc", "/api/login/oidc/native/callback");
	if (request.instance !== publicAddress(app.config)?.url) return null;
	const begun = await beginOidc(app, { purpose: { purpose: "native", ...request }, browser: null, redirect, address });
	return begun !== null && typeof begun !== "string" ? waiting(begun) : begun;
}

export async function finishNativeOidc(
	app: App,
	query: string,
	address: string | null,
): Promise<string | Limited | null> {
	const attempt = await byAddress(app, address);
	const judged = await finishOidc(app, {
		query,
		browser: null,
		native: true,
		redirect: oidcRedirect(app).replace("/signin/oidc", "/api/login/oidc/native/callback"),
	});
	const refused = async (request: NativeOidcRequest | undefined, why: WhyNot): Promise<string | Limited | null> => {
		const answer = await attempt.wrong(no(why));
		if (!request) return answer.why === "limited" ? answer : null;
		const back = new URL(request.callback);
		back.searchParams.set("state", request.state);
		back.searchParams.set("error", answer.why === "limited" ? "limited" : "unauthenticated");
		if (answer.why === "limited") back.searchParams.set("retryAfter", String(answer.retryAfter));
		return back.href;
	};
	if (!judged.ok) return refused(judged.native, judged.why);
	if (judged.purpose.purpose !== "native") return null;
	if (judged.identity.issuer !== app.config.oidc?.issuer) return null;
	const row = await app.database.admissionRead(
		async (readDb) => await oidcByHandle(readDb, oidcHandle(judged.identity)),
	);
	if (!row) return refused(judged.purpose, "unknown-identity");
	return issueNativeOidc(app, { ...judged.purpose, credential: row.id, actor: row.actor }, judged.generation);
}

export const exchangeNativeOidc = async (app: App, input: NativeOidcExchange, about: About): Promise<Entry> =>
	await openOidcSession(app, { native: input }, about);
