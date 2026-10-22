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
import { type Db, sql } from "../kernel/db.ts";
import { conflict, forbidden, invalid, notFound, OpError } from "../kernel/errors.ts";
import { limiterOf, startLimiterOf } from "./attempts.ts";
import { CONTEXT, findChallenge, invitationChallenge, issueChallenge, spendChallenge } from "./challenges.ts";
import { clearMailLinksOf, credentialNotice } from "./contacts.ts";
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
import { accountKey, addressKey, type LimiterAnswer } from "./limiter.ts";
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
	endOtherSessions,
	endSession,
	endSessionsOf,
	endSessionsOn,
	findSession,
	newSessionSecret,
	openSessionOnCredential,
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
 * Reserves an anonymous challenge or provider ceremony in the address's fixed-window allocation quota.
 * This is synchronous and independent of failed proofs: ordinary starts never penalise password sign-in.
 */
export function countSignInStart(app: App, address: string | null): Limited | null {
	const answer = startLimiterOf(app)(addressKey(address), app.now());
	return answer.kind === "blocked" ? waiting(answer) : null;
}

/**
 * The count for something that is not a guess when it is right: a passkey's answer, an invitation's code. It
 * is asked before the thing is looked at, and `wrong` is what a failure is answered with: the wait when the
 * address was blocked as the attempt arrived, and else the refusal itself, counted.
 */
function byAddress(app: App, address: string | null): { wrong: <R extends Refused>(refused: R) => R | Limited } {
	const limiter = limiterOf(app);
	const keys = counted(addressKey(address));
	const answer = limiter.check(keys, app.now());
	return {
		wrong: (refused) => {
			if (answer.kind === "blocked") return waiting(answer);
			limiter.failed(keys, app.now());
			return refused;
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
function commit<T>(app: App, work: () => T): Promise<T | Refused> {
	return app.gate.run(() => {
		try {
			return app.db.transaction(work);
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
function openOn(app: App, row: CredentialRow, cookie: string, about: About) {
	return openSessionOnCredential(app, {
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

/** Admission and result accounting shared by sign-in and a change's current-password check. */
async function checkPassword(
	app: App,
	input: { password: string; stored: string; name: string; address: string | null },
): Promise<PasswordMatch | Limited> {
	const limiter = limiterOf(app);
	const account = accountKey(input.name);
	const keys = counted(addressKey(input.address), account);
	const answer = limiter.check(keys, app.now());
	if (answer.kind === "blocked") return waiting(answer);
	let blockVersion = limiter.blockVersion;
	let right: PasswordMatch;
	try {
		right = await verifyPassword(input.password, input.stored, () => {
			const turn = limiter.check(keys, app.now());
			if (turn.kind === "blocked") throw new PasswordBlocked(turn);
			blockVersion = limiter.blockVersion;
		});
	} catch (error) {
		if (error instanceof PasswordBlocked) return waiting(error.answer);
		throw error;
	}
	const after = limiter.check(keys, app.now());
	if (after.kind === "blocked") return waiting(after);
	if (right === "wrong") limiter.failed(keys, app.now());
	// A success clears only the name, and cannot erase a block begun while this check was running.
	else if (account !== null) limiter.succeeded([account], blockVersion);
	return right;
}

/**
 * Signs a person in with their name and password.
 *
 * A password is checked whoever is named: for a name that has none, against a hash nobody's password matches
 * (`dummyHash`). So the unknown name, the forgotten person, the person without a password and the wrong
 * password all cost the same work and get the same answer, and all four are counted alike under the address
 * and the name. While either is blocked the password is not checked at all.
 */
export async function signInWithPassword(
	app: App,
	input: { name: string; password: string },
	about: About,
): Promise<Entry | { ok: true; secondFactor: { challenge: string; expiresAt: number }; ceremony: string }> {
	const limiter = limiterOf(app);
	const account = accountKey(input.name);
	const keys = counted(addressKey(about.address), account);
	const answer = limiter.check(keys, app.now());
	if (answer.kind === "blocked") return waiting(answer);
	const person = app.reader.get(Q.personByName, { name: input.name });
	const stored = person ? livePassword(app.reader, person.id) : null;
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
	return commit(app, () => {
		// The name is looked up again and must lead to a password with the very hash that was verified.
		const now = app.db.get(Q.personByName, { name: input.name });
		const current = now ? livePassword(app.db, now.id) : null;
		if (!now || !current || current.data !== stored.data) return no("changed-meanwhile");
		const factor = liveTotp(app.db, now.id);
		if (factor) {
			const ceremony = newSessionSecret();
			return {
				ok: true,
				secondFactor: issueTotp(app, {
					kind: "sign-in",
					name: now.name,
					password: current.data,
					rehashed,
					factor: factor.id,
					context: CONTEXT.browser(secretHash(ceremony)),
				}),
				ceremony,
			} as const;
		}
		if (app.config.requireAdminMfa && hasAdminGrant(app.db, now.id)) return no("second-factor-required");
		const opened = openOn(app, current, cookie, about);
		if (!opened) throw new Stop(no("changed-meanwhile"));
		if (rehashed === null) noteCredentialUse(app.db, current.id, app.now());
		else if (!rehashPassword(app.db, current, rehashed, app.now())) throw new Stop(no("changed-meanwhile"));
		return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } } as const;
	});
}

export type PasswordChange =
	| { ok: true; sessionsEnded: number }
	| {
			ok: false;
			why: "not-signed-in" | "not-a-person" | "current-required" | "wrong-current" | "changed-meanwhile" | "busy";
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
		who: () => { id: number; name: string } | null;
		session: () => number | null;
		current: string | undefined;
		next: string;
		address: string | null;
	},
): Promise<PasswordChange> {
	const caller = input.who();
	if (!caller) return { ok: false, why: "not-signed-in" };
	const person = app.reader.get(Q.personById, { id: caller.id });
	if (!person) return { ok: false, why: "not-a-person" };
	const held = livePassword(app.reader, person.id);
	let hash: string;
	try {
		if (held) {
			if (input.current === undefined) return { ok: false, why: "current-required" };
			const checked = await checkPassword(app, {
				password: input.current,
				stored: held.data,
				name: person.name,
				address: input.address,
			});
			if (typeof checked !== "string") return checked;
			if (checked === "wrong") return { ok: false, why: "wrong-current" };
		}
		hash = await hashPassword(input.next, app.config.passwordCost);
	} catch (error) {
		if (error instanceof PasswordWorkBusy) return { ok: false, why: "busy" };
		throw error;
	}
	return app.gate.run(() =>
		app.db.transaction((): PasswordChange => {
			// The session, read on committed rows: nothing else writes while this holds the gate.
			const still = input.who();
			const session = input.session();
			const now = app.db.get(Q.personById, { id: person.id });
			if (!still || session === null || !now || still.id !== now.id || now.name !== person.name)
				return { ok: false, why: "not-signed-in" };
			// The same password as was verified, by its hash, or none as before: else somebody changed it meanwhile.
			const current = livePassword(app.db, now.id);
			if ((current?.data ?? null) !== (held?.data ?? null)) return { ok: false, why: "changed-meanwhile" };
			const at = app.now();
			if (current) revokeCredential(app.db, current.id, at);
			const made = insertPassword(app.db, { actor: now.id, hash, at });
			credentialNotice(app, now.id, current ? "Your password was changed" : "A password was added");
			if (!current) return { ok: true, sessionsEnded: 0 };
			restSession(app.db, { session, from: current.id, to: made });
			return { ok: true, sessionsEnded: endSessionsOn(app.db, current.id, at) };
		}),
	);
}

// ── A passkey ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a page passes to the browser to sign in with a passkey, with a new challenge. It names no passkey: the
 * browser offers the ones it holds for this instance, so nobody types a name first and the reply says nothing
 * about who has a passkey. Null on an instance with no public address.
 *
 * Nobody is signed in, so the ceremony is tied to the browser that asks: `ceremony` is a new random secret the
 * surface hands that browser as a cookie for `lastsMs`, and the challenge keeps its SHA-256. The answer is
 * taken only with that cookie (`signInWithPasskey`).
 */
export function passkeySignInOptions(
	app: App,
	client: "web" | "native" = "web",
): { options: AssertionOptions; ceremony: string; lastsMs: number } | null {
	const address = publicAddress(app.config);
	if (!address) return null;
	if (client === "native" && !address.url.startsWith("https://")) return null;
	// Native AuthenticationServices uses the HTTPS RP ID as its origin, without a port.
	// Record it in this challenge, leaving browser challenges bound to the configured web origin.
	const party = client === "native" ? { ...address.party, origin: `https://${address.party.id}` } : address.party;
	const ceremony = newSessionSecret();
	const context = CONTEXT.browser(hashOf(ceremony));
	return {
		options: assertionOptions({
			rpId: address.party.id,
			challenge: issueChallenge(app, { purpose: "sign-in", context }, party),
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
 */
function judgeAssertion(
	app: App,
	db: Db,
	answer: unknown,
	ceremony: string | null,
): { ok: true; row: CredentialRow; person: Person; shown: Assertion; challenge: string } | Refused {
	const parsed = AssertionResponse.safeParse(answer);
	const challenge = challengeOf(answer);
	if (!parsed.success || challenge === null) return no("input");
	const found = findChallenge(app, challenge, "sign-in");
	if (!found) return no("challenge");
	if (ceremony === null || found.ceremony.context !== CONTEXT.browser(hashOf(ceremony))) return no("context");
	const row = passkeyByCredentialId(db, parsed.data.id);
	if (!row) return no("unknown-passkey");
	const person = row.revoked_at === null ? db.get(Q.personById, { id: row.actor }) : null;
	const stored = storedPasskey(row);
	// A removed passkey's row holds no key any more, and a forgotten person's passkeys were revoked with them.
	if (!person || !stored) return no("revoked-passkey");
	if ((parsed.data.userHandle ?? null) === null || parsed.data.userHandle !== userHandleOf(db, person.id))
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
	const attempt = byAddress(app, about.address);
	const first = judgeAssertion(app, app.reader, answer, ceremony);
	if (!first.ok) return attempt.wrong(first);
	about.proven?.();
	const cookie = newSessionSecret();
	const entry = await commit(app, () => {
		const now = judgeAssertion(app, app.db, answer, ceremony);
		if (!now.ok) return now;
		const opened = openOn(app, now.row, cookie, about);
		if (!opened || !countPasskeyUse(app.db, now.row, now.shown, app.now())) throw new Stop(no("changed-meanwhile"));
		spendChallenge(app, now.challenge);
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
function judgeRegistration(
	app: App,
	db: Db,
	input: { person: Person; answer: unknown; context: string },
): { ok: true; passkey: Passkey; challenge: string } | Refused {
	const { person, answer, context } = input;
	const challenge = challengeOf(answer);
	if (challenge === null) return no("input");
	const found = findChallenge(app, challenge, "register");
	const handle = userHandleOf(db, person.id);
	if (!found || handle === null || found.ceremony.userHandle !== handle) return no("challenge");
	if (found.ceremony.context !== context) return no("context");
	const verdict = verifyRegistration(answer, found.expected);
	if (!verdict.ok) return no(verdict.reason);
	if (passkeyByCredentialId(db, verdict.value.credentialId)) return no("credential-exists");
	return { ok: true, passkey: verdict.value, challenge };
}
function mustBePerson(db: Db, actor: number): Person {
	const person = db.get(Q.personById, { id: actor });
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
export function beginPasskey(app: App, input: { actor: number; context: string }): RegistrationOptions {
	const party = mustHavePasskeys(app);
	const person = mustBePerson(app.db, input.actor);
	const userHandle = ensureUserHandle(app.db, person.id, app.now());
	return registrationFor({
		party,
		person,
		userHandle,
		challenge: issueChallenge(app, { purpose: "register", userHandle, context: input.context }, party),
		exclude: liveCredentials(app.db, person.id),
	});
}

/**
 * Stores the passkey a signed-in person registered, and spends its challenge, in the operation's transaction.
 * The refusal says what the verifier found, as a code: the caller is the person whose own key it is.
 */
export function addPasskey(
	app: App,
	input: { actor: number; context: string; answer: unknown; label: string },
): { id: number; label: string } {
	mustHavePasskeys(app);
	const person = mustBePerson(app.db, input.actor);
	const judged = judgeRegistration(app, app.db, { person, answer: input.answer, context: input.context });
	if (!judged.ok) {
		if (judged.why === "credential-exists")
			throw conflict("this passkey is registered on this instance already; a passkey is registered once");
		throw invalid(
			`the passkey was not accepted (${judged.why}). Begin again: a registration answers the challenge it was given, once, within five minutes`,
		);
	}
	const row = insertPasskey(app.db, { actor: person.id, passkey: judged.passkey, label: input.label, at: app.now() });
	credentialNotice(app, person.id, "A passkey was added");
	spendChallenge(app, judged.challenge);
	return { id: row.id, label: row.label };
}

// ── Credentials, as a signed-in person sees them ───────────────────────────────────────────────────────────

/** A person's ways of signing in. Never a hash, a key or a credential id: a list is read on a screen. */
export function listCredentials(db: Db, actor: number) {
	return liveCredentials(db, actor).map((row) => ({
		id: row.id,
		kind: row.kind,
		label: row.label,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	}));
}

/** The person a credential signs in, when it still works; else null. */
export function credentialOwner(db: Db, id: number): number | null {
	const row = credentialById(db, id);
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
export function removeCredential(app: App, id: number): { removed: true; sessionsEnded: number } {
	const row = credentialById(app.db, id);
	if (!row || row.revoked_at !== null) throw notFound(`credential ${id}`);
	const requiresFactor = app.config.requireAdminMfa && hasAdminGrant(app.db, row.actor);
	if (row.kind === "totp" && requiresFactor && livePassword(app.db, row.actor))
		throw forbidden(
			"this instance requires a second factor for admins with a password; remove the password first to use only passkeys",
		);
	const passwordWorks = !requiresFactor || liveTotp(app.db, row.actor) !== null;
	// An identity is a way in only at the provider the instance is configured with now.
	const provider = app.config.oidc ? `${app.config.oidc.issuer}#` : null;
	const identityWorks = (held: CredentialRow): boolean =>
		provider !== null && held.handle?.startsWith(provider) === true && (!requiresFactor || providerVouches(app));
	const waysIn = liveCredentials(app.db, row.actor).filter(
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
		const name = app.db.get(Q.nameOf, { id: row.actor })?.name ?? "this person";
		throw invalid(
			`this is the last way ${name} signs in, so it stays. Add a passkey or set a password first, then remove this one. If it is lost, an admin can make a recovery link (mainworthy invite new ${name})`,
		);
	}
	const at = app.now();
	revokeCredential(app.db, id, at);
	credentialNotice(app, row.actor, `${REMOVED[row.kind]} was removed`);
	return {
		removed: true,
		sessionsEnded: row.kind === "totp" ? endSessionsOf(app.db, row.actor, at, "ended") : endSessionsOn(app.db, id, at),
	};
}

// ── An invitation ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Makes an invitation for a person and returns its code, which is shown once and of which only the SHA-256 is
 * stored. In the operation's transaction. A new invitation replaces the person's earlier ones that nobody
 * accepted, so one link is good for a person at a time. The person's passkey handle is made here if there is
 * none, so that showing the invitation later writes no row.
 */
export function createInvitation(
	app: App,
	input: { actor: number; by: number; purpose: InvitationPurpose; lastsMs: number },
): { id: number; code: string; link: string; expiresAt: number } {
	const at = app.now();
	revokeInvitationsOf(app.db, input.actor, at);
	ensureUserHandle(app.db, input.actor, at);
	const code = newSessionSecret();
	const expiresAt = at + input.lastsMs;
	const id = insertInvitation(app.db, {
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
function openInvitation(app: App, db: Db, hash: string): { invitation: InvitationRow; person: Person } | null {
	const invitation = invitationByHash(db, hash);
	if (!invitation || !isOpen(invitation, app.now())) return null;
	const person = db.get(Q.personById, { id: invitation.actor });
	return person ? { invitation, person } : null;
}

/**
 * What the page of an invitation shows: who it is for, what accepting does and when it runs out, and the
 * options for registering a passkey with it (null on an instance with no public address). Null for a code
 * that accepts nothing, whatever the reason. It writes no row, so a link that a mail or chat preview opens,
 * or a page that is reloaded, changes nothing that is stored. A working invitation reuses its registration
 * challenge so one code cannot fill the map. Near expiry a successor leaves the old prompt valid until its end.
 *
 * The options exclude no passkey: whoever holds a recovery code is not told which authenticators the person
 * had, and accepting revokes those anyway.
 *
 * A right code is proof of the invitation, so its page stays reachable during either address block.
 */
export function showInvitation(
	app: App,
	code: string,
	address: string | null,
):
	| {
			ok: true;
			shown: {
				invitation: { name: string; purpose: InvitationPurpose; expiresAt: number };
				passkey: RegistrationOptions | null;
			};
	  }
	| Refused
	| Limited {
	const attempt = byAddress(app, address);
	const hash = hashOf(code);
	const found = openInvitation(app, app.reader, hash);
	if (!found) return attempt.wrong(no("invitation"));
	const { invitation, person } = found;
	const party = publicAddress(app.config)?.party;
	const handle = userHandleOf(app.reader, person.id);
	const passkey =
		party && handle !== null ? invitationChallenge(app, { codeHash: hash, userHandle: handle }, party) : null;
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
function holderOf(app: App, cookie: string): { id: number; name: string } | null {
	const actor = findSession(app, hashOf(cookie))?.actor;
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
export function acceptInvitation(
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
	return acceptByHash(app, hashOf(code), { ...rest, identity: null }, about);
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
		identity: { handle: string; label: string } | null;
	},
	about: About,
): Promise<Accepted> {
	const judge = (db: Db) => {
		const found = openInvitation(app, db, hash);
		if (!found) return no("invitation");
		if (input.passkey === undefined) return { ok: true, ...found, registration: null } as const;
		const registration = judgeRegistration(app, db, {
			person: found.person,
			answer: input.passkey,
			context: CONTEXT.invitation(hash),
		});
		return registration.ok ? ({ ok: true, ...found, registration } as const) : registration;
	};
	const attempt = byAddress(app, about.address);
	const first = judge(app.reader);
	// A code that accepts nothing is a wrong guess at one, and is counted. A good code with a passkey that was
	// not accepted is somebody who holds the invitation, and is not.
	if (!first.ok) return first.why === "invitation" ? attempt.wrong(first) : first;
	// Somebody other than `person` whom the browser's cookie signs in now, and whether the page said their name.
	// Nothing of this is carried over the wait at the gate: it is asked here, and asked again in the commit.
	const elsewhere = (person: { id: number }): { name: string; agreed: boolean } | null => {
		const holder = input.browser === null ? null : holderOf(app, input.browser);
		return holder && holder.id !== person.id ? { name: holder.name, agreed: input.replace === holder.name } : null;
	};
	const unasked = (held: { name: string; agreed: boolean } | null): Accepted | null =>
		held && !held.agreed ? { ok: false, why: "other-session", signedInAs: held.name } : null;
	// Said before a password is hashed for an acceptance that cannot go through as it stands.
	const early = unasked(elsewhere(first.person));
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
	return commit(app, (): Accepted => {
		const now = judge(app.db);
		if (!now.ok) return now;
		const { invitation, person, registration } = now;
		const vouched = input.identity !== null && providerVouches(app);
		if (!registration && !vouched && app.config.requireAdminMfa && hasAdminGrant(app.db, person.id))
			return no("second-factor-required");
		// Who the browser holds, on committed rows and before anything is written: nothing else writes while this
		// holds the gate. The name is the one that person has now.
		const held = elsewhere(person);
		const refused = unasked(held);
		if (refused) return refused;
		const at = app.now();
		// By the hash of its code, and only while it is still good: of two acceptances one finds it spent.
		if (!spendInvitation(app.db, hash, at)) throw new Stop(no("invitation"));
		if (invitation.purpose === "recover") {
			revokeCredentialsOf(app.db, person.id, at);
			revokeTokensOf(app.db, person.id, at);
			endSessionsOf(app.db, person.id, at, "ended");
			app.db.afterCommit(() => clearMailLinksOf(app, person.id));
		} else if (liveCredentials(app.db, person.id).length > 0) throw new Stop(no("has-credentials"));
		let root: CredentialRow | null = null;
		if (passwordHash !== null)
			root = credentialById(app.db, insertPassword(app.db, { actor: person.id, hash: passwordHash, at }));
		if (input.identity) {
			if (oidcByHandle(app.db, input.identity.handle)) throw new Stop(no("credential-exists"));
			root = insertOidc(app.db, { actor: person.id, ...input.identity, at });
		}
		if (registration)
			root = insertPasskey(app.db, {
				actor: person.id,
				passkey: registration.passkey,
				label: input.label ?? "passkey",
				at,
			});
		if (!root) throw new Stop(no("input"));
		const opened = openOn(app, root, cookie, about);
		if (!opened) throw new Stop(no("changed-meanwhile"));
		// What was just stored signed its person in, and says so: a list does not call it "never used".
		for (const row of liveCredentials(app.db, person.id)) noteCredentialUse(app.db, row.id, at);
		// The browser was somebody else's until now, and the page said whose. That session ends as a sign-out does.
		if (input.browser !== null && held) endSession(app, hashOf(input.browser), "signed-out");
		if (registration) spendChallenge(app, registration.challenge);
		credentialNotice(
			app,
			person.id,
			invitation.purpose === "recover"
				? "Your sign-in methods were replaced through account recovery"
				: "Your sign-in methods were added",
		);
		return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } } as const;
	});
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
		const attempt = byAddress(app, address);
		const hash = hashOf(start.code);
		const found = openInvitation(app, app.reader, hash);
		if (!found) return attempt.wrong(no("invitation"));
		const holder = start.browser === null ? null : holderOf(app, start.browser);
		if (holder && holder.id !== found.person.id && start.replace !== holder.name)
			return { ok: false, why: "other-session", signedInAs: holder.name };
		purpose = { purpose: "join", invitation: hash, replace: start.replace };
	} else if (start.purpose === "link") {
		if (!app.reader.get(Q.personById, { id: start.actor })) return { ok: false, why: "not-a-person" };
		purpose = { purpose: "link", actor: start.actor, session: hashOf(start.browser) };
	} else purpose = start;
	const ceremony = newSessionSecret();
	const url = await beginOidc(app, { purpose, browser: hashOf(ceremony), redirect });
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
	const attempt = byAddress(app, about.address);
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
		return acceptByHash(
			app,
			purpose.invitation,
			{
				password: undefined,
				passkey: undefined,
				label: undefined,
				replace: purpose.replace,
				browser: input.browser,
				identity: { handle, label },
			},
			about,
		);
	}
	if (purpose.purpose === "link") {
		const linking = purpose;
		return commit(app, (): OidcFinished => {
			// The browser that finishes is the session that began, and that session is still the person's.
			const held = input.browser === null ? null : findSession(app, hashOf(input.browser), { db: app.db });
			if (input.browser === null || hashOf(input.browser) !== linking.session || held?.actor.id !== linking.actor)
				return no("context");
			if (oidcByHandle(app.db, handle)) return { ok: false, why: "linked-already" };
			insertOidc(app.db, { actor: linking.actor, handle, label, at: app.now() });
			credentialNotice(app, linking.actor, "An identity provider sign-in was added");
			return { ok: true, linked: true };
		});
	}
	return openOidcSession(app, { identity }, about);
}

async function openOidcSession(
	app: App,
	input: { identity: Identity } | { native: NativeOidcExchange },
	about: About,
): Promise<Entry> {
	const attempt = byAddress(app, about.address);
	if ("native" in input && !findNativeOidc(app, input.native)) return attempt.wrong(no("challenge"));
	about.proven?.();
	const cookie = newSessionSecret();
	const entry = await commit(app, (): Entry => {
		const handoff = "native" in input ? takeNativeOidc(app, input.native) : null;
		const identity = "identity" in input ? input.identity : handoff?.identity;
		if (!identity) return no("challenge");
		if ("native" in input && input.native.instance !== publicAddress(app.config)?.url) return no("context");
		if (!app.config.oidc || identity.issuer !== app.config.oidc.issuer) return no("changed-meanwhile");
		const row = oidcByHandle(app.db, oidcHandle(identity));
		if (handoff && (!row || row.id !== handoff.credential || row.actor !== handoff.actor))
			return no("changed-meanwhile");
		const person = row ? app.db.get(Q.personById, { id: row.actor }) : null;
		if (!row || !person) return no("unknown-identity");
		if (app.config.requireAdminMfa && hasAdminGrant(app.db, person.id) && !providerVouches(app))
			return no("second-factor-required");
		const opened = openOn(app, row, cookie, about);
		if (!opened) throw new Stop(no("changed-meanwhile"));
		noteCredentialUse(app.db, row.id, app.now());
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

function factorAttempt(app: App, input: { kind: "sign-in" | "enrol"; name: string; address: string | null }) {
	const limiter = limiterOf(app);
	const account = `${input.kind === "enrol" ? "totp-enrol" : "totp"}:${input.name}`;
	const keys = counted(addressKey(input.address), account);
	const answer = limiter.check(keys, app.now());
	return { limiter, account, keys, answer };
}

export async function signInWithTotp(
	app: App,
	input: { challenge: string; code: string; ceremony: string | null },
	about: About,
): Promise<Entry> {
	const initial = findTotp(app, input.challenge, "sign-in");
	if (!initial || input.ceremony === null || initial.context !== CONTEXT.browser(secretHash(input.ceremony)))
		return byAddress(app, about.address).wrong(no("challenge"));
	const attempt = factorAttempt(app, { kind: "sign-in", name: initial.name, address: about.address });
	if (attempt.answer.kind === "blocked") return waiting(attempt.answer);
	const cookie = newSessionSecret();
	return commit(app, () => {
		const held = findTotp(app, input.challenge, "sign-in");
		if (!held || held !== initial) return no("challenge");
		const person = app.db.get(Q.personByName, { name: held.name });
		const password = person ? livePassword(app.db, person.id) : null;
		const factor = person ? liveTotp(app.db, person.id) : null;
		if (!password || password.data !== held.password || !factor || factor.id !== held.factor)
			return no("changed-meanwhile");
		const currentLimit = attempt.limiter.check(attempt.keys, app.now());
		if (currentLimit.kind === "blocked") return waiting(currentLimit);
		const stored = readTotp(factor.data);
		const next = stored ? acceptTotp(stored, input.code, app.now()) : null;
		if (!next) {
			attempt.limiter.failed(attempt.keys, app.now());
			return no("wrong-code");
		}
		const opened = openOn(app, password, cookie, about);
		if (!opened || !updateTotp(app.db, factor, JSON.stringify(next), app.now()))
			throw new Stop(no("changed-meanwhile"));
		if (held.rehashed === null) noteCredentialUse(app.db, password.id, app.now());
		else if (!rehashPassword(app.db, password, held.rehashed, app.now())) throw new Stop(no("changed-meanwhile"));
		spendTotp(app, input.challenge);
		attempt.limiter.succeeded([attempt.account]);
		about.proven?.();
		return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } } as const;
	});
}

export function beginTotp(app: App, input: { actor: number; context: string }) {
	const person = mustBePerson(app.db, input.actor);
	if (liveTotp(app.db, person.id))
		throw conflict("an authenticator is enrolled already; remove it before enrolling another");
	const secret = newTotpSecret();
	return {
		...issueTotp(app, { kind: "enrol", actor: person.id, name: person.name, context: input.context, secret }),
		...provisioning(secret, person.name),
	};
}

export function confirmTotp(
	app: App,
	input: { actor: number; session: number | null; context: string; challenge: string; code: string },
) {
	const person = mustBePerson(app.db, input.actor);
	const held = findTotp(app, input.challenge, "enrol");
	if (!held || held.actor !== person.id || held.name !== person.name || held.context !== input.context)
		throw invalid("this authenticator enrolment ended; begin again in the same session");
	if (liveTotp(app.db, person.id)) throw conflict("an authenticator is enrolled already");
	const attempt = factorAttempt(app, { kind: "enrol", name: person.name, address: null });
	if (attempt.answer.kind === "blocked")
		throw new OpError("limited", `wait ${attempt.answer.retryAfterSeconds} seconds before trying another code`);
	const stored = acceptTotp({ secret: held.secret, lastStep: -1, recovery: [] }, input.code, app.now());
	if (!stored) {
		attempt.limiter.failed(attempt.keys, app.now());
		throw invalid("that authenticator code was not accepted");
	}
	const recovery = recoveryCodes();
	const at = app.now();
	const id = insertTotp(app.db, {
		actor: person.id,
		data: JSON.stringify({ ...stored, recovery: recovery.hashes }),
		at,
	});
	const sessionsEnded = endOtherSessions(app.db, person.id, input.session, at);
	credentialNotice(app, person.id, "An authenticator was added");
	spendTotp(app, input.challenge);
	attempt.limiter.succeeded([attempt.account]);
	return { id, recoveryCodes: recovery.codes, sessionsEnded };
}

export async function beginNativeOidc(app: App, request: NativeOidcRequest): Promise<string | null> {
	const redirect = oidcRedirect(app).replace("/signin/oidc", "/api/login/oidc/native/callback");
	if (request.instance !== publicAddress(app.config)?.url) return null;
	return beginOidc(app, { purpose: { purpose: "native", ...request }, browser: null, redirect });
}

export async function finishNativeOidc(
	app: App,
	query: string,
	address: string | null,
): Promise<string | Limited | null> {
	const attempt = byAddress(app, address);
	const judged = await finishOidc(app, {
		query,
		browser: null,
		native: true,
		redirect: oidcRedirect(app).replace("/signin/oidc", "/api/login/oidc/native/callback"),
	});
	const refused = (request: NativeOidcRequest | undefined, why: WhyNot): string | Limited | null => {
		const answer = attempt.wrong(no(why));
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
	const row = oidcByHandle(app.reader, oidcHandle(judged.identity));
	if (!row) return refused(judged.purpose, "unknown-identity");
	return issueNativeOidc(
		app,
		{ ...judged.purpose, identity: judged.identity, credential: row.id, actor: row.actor },
		judged.generation,
	);
}

export const exchangeNativeOidc = (app: App, input: NativeOidcExchange, about: About): Promise<Entry> =>
	openOidcSession(app, { native: input }, about);
