// People sign in as themselves: with a name and a password, with a passkey, or the first time with the
// invitation an admin handed them. This file is what happens in each case, in order; the rows are in
// `credentials.ts`, `invitations.ts` and `sessions.ts`, the challenges in `challenges.ts`, and what a passkey's
// answer is worth in `webauthn.ts`. Other layers reach all of it through `identity.ts`.
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
import { conflict, invalid, notFound } from "../kernel/errors.ts";
import { type Ceremony, challengeOf, findChallenge, issueChallenge, spendChallenge } from "./challenges.ts";
import {
	type CredentialRow,
	countPasskeyUse,
	credentialById,
	ensureUserHandle,
	insertPasskey,
	insertPassword,
	liveCredentials,
	livePassword,
	noteCredentialUse,
	passkeyByCredentialId,
	revokeCredential,
	revokeCredentialsOf,
	storedPasskey,
	userHandleOf,
} from "./credentials.ts";
import type { SignedIn } from "./identity.ts";
import {
	type InvitationPurpose,
	type InvitationRow,
	insertInvitation,
	invitationByHash,
	isOpen,
	revokeInvitationsOf,
	spendInvitation,
} from "./invitations.ts";
import { dummyHash, hashPassword, PasswordWorkBusy, verifyPassword } from "./passwords.ts";
import {
	endSession,
	endSessionsOf,
	endSessionsOn,
	findSession,
	newSessionSecret,
	openSessionOnCredential,
	restSession,
} from "./sessions.ts";
import {
	type Assertion,
	type AssertionOptions,
	AssertionResponse,
	assertionOptions,
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
 * Throws for a value a browser would not make a passkey at, which stops the start (`open` in `start.ts` asks
 * once, before anything else). A typing error must not leave an instance where passkeys silently never work,
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
			"MAINWORTHY_PUBLIC_URL is not an address a browser makes a passkey at. Write the address people open this instance at and nothing after the host: https and a host name (https://mainworthy.example), or http://localhost with its port. An IP address, plain http anywhere else, a path and a query are refused. Unset it to start without passkeys",
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
export function signInMethods(app: App): { password: true; passkey: boolean } {
	return { password: true, passkey: publicAddress(app.config) !== null };
}

// ── Refusals ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Why somebody was not signed in. A closed set of codes, for the server's log: the caller of a sign-in is told
 * one thing whatever the reason, so that a reply never says which names exist or which half was right.
 */
export type WhyNot =
	/** What the passkey verifier found wrong with an answer. */
	| Refusal
	/** No person of that name stands: unknown, forgotten, or an agent's or a pipeline's name. */
	| "unknown-name"
	/** The person has no password that works. */
	| "no-password"
	| "wrong-password"
	/** Too many passwords are being checked at this moment. */
	| "busy"
	/** What was judged outside the gate was not what the commit found: changed, revoked, forgotten or imported over. */
	| "changed-meanwhile"
	/** No challenge of this server, for this purpose and this person, inside its time and not yet spent. */
	| "challenge"
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
export type Entry = { ok: true; signedIn: SignedIn } | Refused;
const no = (why: WhyNot, credential?: number): Refused =>
	credential === undefined ? { ok: false, why } : { ok: false, why, credential };

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

/**
 * Signs a person in with their name and password.
 *
 * A password is checked whoever is named: for a name that has none, against a hash nobody's password matches
 * (`dummyHash`). So the unknown name, the forgotten person, the person without a password and the wrong
 * password all cost the same work and get the same answer.
 */
export async function signInWithPassword(
	app: App,
	input: { name: string; password: string },
	about: About,
): Promise<Entry> {
	const person = app.reader.get(Q.personByName, { name: input.name });
	const stored = person ? livePassword(app.reader, person.id) : null;
	let right: boolean;
	try {
		// Asked for whoever is named, so that the one sign-in that has to make it first is not marked by that.
		const nobodys = await dummyHash(app.config.passwordCost);
		right = await verifyPassword(input.password, stored?.data ?? nobodys);
	} catch (error) {
		if (error instanceof PasswordWorkBusy) return no("busy");
		throw error;
	}
	if (!person) return no("unknown-name");
	if (!stored) return no("no-password");
	if (!right) return no("wrong-password");
	about.proven?.();
	const cookie = newSessionSecret();
	return commit(app, () => {
		// The name is looked up again and must lead to a password with the very hash that was verified.
		const now = app.db.get(Q.personByName, { name: input.name });
		const current = now ? livePassword(app.db, now.id) : null;
		if (!now || !current || current.data !== stored.data) return no("changed-meanwhile");
		const opened = openOn(app, current, cookie, about);
		if (!opened) throw new Stop(no("changed-meanwhile"));
		noteCredentialUse(app.db, current.id, app.now());
		return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } } as const;
	});
}

export type PasswordChange =
	| { ok: true; sessionsEnded: number }
	| {
			ok: false;
			why: "not-signed-in" | "not-a-person" | "current-required" | "wrong-current" | "changed-meanwhile" | "busy";
	  };

/**
 * Sets a person's password, or replaces it. `who` and `session` are the caller's browser session, asked again
 * inside the commit: the person it signs in, and its row.
 *
 * The current password is required when there is one, so a browser left open is not enough to lock its owner
 * out. The old row is revoked and a new one made. The sessions that rested on the old password end, but for the
 * one that made the change, which rests on the new password from then on.
 */
export async function changePassword(
	app: App,
	input: {
		who: () => { id: number; name: string } | null;
		session: () => number | null;
		current: string | undefined;
		next: string;
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
			if (!(await verifyPassword(input.current, held.data))) return { ok: false, why: "wrong-current" };
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
 */
export function passkeySignInOptions(app: App): AssertionOptions | null {
	const address = publicAddress(app.config);
	if (!address) return null;
	return assertionOptions({
		rpId: address.party.id,
		challenge: issueChallenge(app, { purpose: "sign-in" }, address.party),
		allow: [],
	});
}

/**
 * Judges a passkey's answer to a sign-in challenge against the rows of `db`. The person is the one the stored
 * row names, found by the credential id; nothing else in the answer chooses who signs in. The sign-in named no
 * passkey, so the answer must carry the user handle, and it must be that person's.
 */
function judgeAssertion(
	app: App,
	db: Db,
	answer: unknown,
): { ok: true; row: CredentialRow; person: Person; shown: Assertion; challenge: string } | Refused {
	const parsed = AssertionResponse.safeParse(answer);
	const challenge = challengeOf(answer);
	if (!parsed.success || challenge === null) return no("input");
	const found = findChallenge(app, challenge, "sign-in");
	if (!found) return no("challenge");
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
 */
export function signInWithPasskey(app: App, answer: unknown, about: About): Promise<Entry> {
	const first = judgeAssertion(app, app.reader, answer);
	if (!first.ok) return Promise.resolve(first);
	about.proven?.();
	const cookie = newSessionSecret();
	return commit(app, () => {
		const now = judgeAssertion(app, app.db, answer);
		if (!now.ok) return now;
		const opened = openOn(app, now.row, cookie, about);
		if (!opened || !countPasskeyUse(app.db, now.row, now.shown, app.now())) throw new Stop(no("changed-meanwhile"));
		spendChallenge(app, now.challenge);
		return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } } as const;
	});
}

/** The options for a new passkey of one person, with a new challenge that only an answer for that person spends. */
function registrationFor(
	app: App,
	input: { party: RelyingParty; person: Person; userHandle: string; exclude: readonly CredentialRow[] },
): RegistrationOptions {
	const { party, person, userHandle, exclude } = input;
	return registrationOptions({
		rpId: party.id,
		rpName: RP_NAME,
		user: { handle: userHandle, name: person.name, displayName: person.name },
		challenge: issueChallenge(app, { purpose: "register", userHandle }, party),
		exclude: exclude.flatMap((row) => storedPasskey(row) ?? []),
	});
}

/**
 * Judges the answer to a registration challenge, for one person. The challenge must be one issued for a
 * registration of this very person, who is named in it by the handle their passkeys are filed under. The
 * credential id must be on no row, live or revoked, of anybody.
 */
function judgeRegistration(
	app: App,
	db: Db,
	person: Person,
	answer: unknown,
): { ok: true; passkey: Passkey; challenge: string } | Refused {
	const challenge = challengeOf(answer);
	if (challenge === null) return no("input");
	const found = findChallenge(app, challenge, "register");
	const handle = userHandleOf(db, person.id);
	if (!found || handle === null || !isFor(found.ceremony, handle)) return no("challenge");
	const verdict = verifyRegistration(answer, found.expected);
	if (!verdict.ok) return no(verdict.reason);
	if (passkeyByCredentialId(db, verdict.value.credentialId)) return no("credential-exists");
	return { ok: true, passkey: verdict.value, challenge };
}
const isFor = (ceremony: Extract<Ceremony, { purpose: "register" }>, userHandle: string): boolean =>
	ceremony.userHandle === userHandle;

function mustBePerson(db: Db, actor: number): Person {
	const person = db.get(Q.personById, { id: actor });
	if (!person) throw invalid("only a person has a password or a passkey");
	return person;
}

/**
 * Begins the registration of a passkey for a signed-in person: what the page passes to the browser. In the
 * operation's transaction, because the person's handle is made here the first time.
 */
export function beginPasskey(app: App, actor: number): RegistrationOptions {
	const party = mustHavePasskeys(app);
	const person = mustBePerson(app.db, actor);
	const userHandle = ensureUserHandle(app.db, person.id, app.now());
	return registrationFor(app, { party, person, userHandle, exclude: liveCredentials(app.db, person.id) });
}

/**
 * Stores the passkey a signed-in person registered, and spends its challenge, in the operation's transaction.
 * The refusal says what the verifier found, as a code: the caller is the person whose own key it is.
 */
export function addPasskey(
	app: App,
	input: { actor: number; answer: unknown; label: string },
): { id: number; label: string } {
	mustHavePasskeys(app);
	const person = mustBePerson(app.db, input.actor);
	const judged = judgeRegistration(app, app.db, person, input.answer);
	if (!judged.ok) {
		if (judged.why === "credential-exists")
			throw conflict("this passkey is registered on this instance already; a passkey is registered once");
		throw invalid(
			`the passkey was not accepted (${judged.why}). Begin again: a registration answers the challenge it was given, once, within five minutes`,
		);
	}
	const row = insertPasskey(app.db, { actor: person.id, passkey: judged.passkey, label: input.label, at: app.now() });
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

/**
 * Removes one way a person signs in, and ends the sessions that rest on it. The last one stays: with none, the
 * person could not sign in to add another, and only an admin's recovery link would let them back.
 */
export function removeCredential(app: App, id: number): { removed: true; sessionsEnded: number } {
	const row = credentialById(app.db, id);
	if (!row || row.revoked_at !== null) throw notFound(`credential ${id}`);
	if (liveCredentials(app.db, row.actor).length <= 1) {
		const name = app.db.get(Q.nameOf, { id: row.actor })?.name ?? "this person";
		throw invalid(
			`this is the last way ${name} signs in, so it stays. Add a passkey or set a password first, then remove this one. If it is lost, an admin can make a recovery link (mainworthy invite new ${name})`,
		);
	}
	const at = app.now();
	revokeCredential(app.db, id, at);
	return { removed: true, sessionsEnded: endSessionsOn(app.db, id, at) };
}

// ── An invitation ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Makes an invitation for a person and returns its code, which is shown once and of which only the SHA-256 is
 * stored. In the operation's transaction. A new invitation replaces the person's earlier ones that nobody
 * accepted, so one link is good for a person at a time. The person's passkey handle is made here if there is
 * none, so that showing the invitation later writes nothing.
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
 * or a page that is reloaded, changes nothing; each asking gets a challenge of its own.
 *
 * The options exclude no passkey: whoever holds a recovery code is not told which authenticators the person
 * had, and accepting revokes those anyway.
 */
export function showInvitation(
	app: App,
	code: string,
): {
	invitation: { name: string; purpose: InvitationPurpose; expiresAt: number };
	passkey: RegistrationOptions | null;
} | null {
	const found = openInvitation(app, app.reader, hashOf(code));
	if (!found) return null;
	const { invitation, person } = found;
	const party = publicAddress(app.config)?.party;
	const handle = userHandleOf(app.reader, person.id);
	return {
		invitation: { name: person.name, purpose: invitation.purpose, expiresAt: invitation.expires_at },
		passkey: party && handle !== null ? registrationFor(app, { party, person, userHandle: handle, exclude: [] }) : null,
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
 * invitation to recover also revokes, there, every credential the person had and ends every session of
 * theirs: until it is accepted nothing of theirs changes, so a link that is never used locks nobody out.
 *
 * `browser` is the session cookie the request carried, if any. When it signs in somebody else, the invitation
 * is accepted only with `replace`, and that other session ends in the same transaction: the page asked first.
 * The new session rests on the passkey when there is one, else on the password.
 */
export async function acceptInvitation(
	app: App,
	input: {
		code: string;
		password: string | undefined;
		passkey: unknown;
		label: string | undefined;
		replace: boolean;
		browser: string | null;
	},
	about: About,
): Promise<Accepted> {
	const hash = hashOf(input.code);
	const judge = (db: Db) => {
		const found = openInvitation(app, db, hash);
		if (!found) return no("invitation");
		if (input.passkey === undefined) return { ok: true, ...found, registration: null } as const;
		const registration = judgeRegistration(app, db, found.person, input.passkey);
		return registration.ok ? ({ ok: true, ...found, registration } as const) : registration;
	};
	const first = judge(app.reader);
	if (!first.ok) return first;
	const other = input.browser === null ? null : holderOf(app, input.browser);
	if (other && other.id !== first.person.id && !input.replace)
		return { ok: false, why: "other-session", signedInAs: other.name };
	about.proven?.();
	let passwordHash: string | null = null;
	try {
		if (input.password !== undefined) passwordHash = await hashPassword(input.password, app.config.passwordCost);
	} catch (error) {
		if (error instanceof PasswordWorkBusy) return no("busy");
		throw error;
	}
	const cookie = newSessionSecret();
	return commit(app, () => {
		const now = judge(app.db);
		if (!now.ok) return now;
		const { invitation, person, registration } = now;
		const at = app.now();
		// By the hash of its code, and only while it is still good: of two acceptances one finds it spent.
		if (!spendInvitation(app.db, hash, at)) throw new Stop(no("invitation"));
		if (invitation.purpose === "recover") {
			revokeCredentialsOf(app.db, person.id, at);
			endSessionsOf(app.db, person.id, at, "ended");
		} else if (liveCredentials(app.db, person.id).length > 0) throw new Stop(no("has-credentials"));
		let root: CredentialRow | null = null;
		if (passwordHash !== null)
			root = credentialById(app.db, insertPassword(app.db, { actor: person.id, hash: passwordHash, at }));
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
		// The browser was somebody else's until now. That session ends as a sign-out does.
		if (input.browser !== null && other && other.id !== person.id) endSession(app, hashOf(input.browser), "signed-out");
		if (registration) spendChallenge(app, registration.challenge);
		return { ok: true, signedIn: { cookie, expiresAt: opened.expiresAt } } as const;
	});
}
