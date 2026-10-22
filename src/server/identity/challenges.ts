// The challenges of passkey ceremonies that are under way. In memory, for one `App`: a challenge lives five
// minutes and is worth nothing after a restart, so no table holds it.
//
// The passkey verifier judges one answer against what it is handed and keeps nothing (`webauthn.ts`). What it
// is handed comes from here: the challenge the server made, what it was made for, and the origin and RP ID it
// was made under. A challenge is found by an answer and spent by the commit that the answer leads to, so of
// two answers to one challenge only one stores a passkey or opens a session.
//
// A challenge also remembers where its ceremony began (`Ceremony.context`), and whoever completes it shows the
// same: a signed answer is then good only in the browser, the session or for the invitation that asked for it.

import type { App } from "../kernel/app.ts";
import { clearMailLinks } from "./contacts.ts";
import { clearOidc } from "./oidc.ts";
import { clearTotp } from "./totp.ts";
import { CEREMONY_MS, type Challenge, type Expected, newChallenge, type RelyingParty } from "./webauthn.ts";

/**
 * Where a ceremony began, as one text that only the same place makes again. Each holds the SHA-256 of a secret
 * and never a row's number: an import gives a number to another row, and a hash goes with what it is of.
 */
export const CONTEXT = {
	/** A browser nobody is signed in on, known by the ceremony cookie set with the challenge: the cookie's hash. */
	browser: (cookieHash: string): string => `browser ${cookieHash}`,
	/** A signed-in browser's session: the hash of its session cookie, which is what its row stores. */
	session: (sessionHash: string): string => `session ${sessionHash}`,
	/** The owner of the machine in local mode, who has no session: every such request is that one person. */
	local: "local",
	/** An invitation: the hash of its code. */
	invitation: (codeHash: string): string => `invitation ${codeHash}`,
} as const;

/** What a challenge was issued for, and where. An answer to one is no answer to the other. */
export type Ceremony =
	/**
	 * A new passkey for one person, named by the handle their passkeys are filed under and not by the number of
	 * their row: an import gives the numbers to other people, and the handle goes with the person.
	 */
	| { readonly purpose: "register"; readonly userHandle: string; readonly context: string }
	/** A sign-in by whoever holds a passkey of this instance. It names nobody. */
	| { readonly purpose: "sign-in"; readonly context: string };

type Kept = { readonly ceremony: Ceremony; readonly expected: Expected; readonly deadline: number };

/**
 * How many may be under way at once. Anybody can ask for a sign-in challenge without signing in, so the map
 * has an end: past it the oldest is dropped. A person's ceremony takes seconds, and the oldest of ten thousand
 * is one nobody is still answering unless somebody asks for thousands a second.
 */
const MOST = 10_000;

const kept = new WeakMap<App, Map<string, Kept>>();
function of(app: App): Map<string, Kept> {
	let challenges = kept.get(app);
	if (!challenges) {
		challenges = new Map();
		kept.set(app, challenges);
	}
	return challenges;
}

/** A new challenge for a ceremony at this relying party. It can be answered until `CEREMONY_MS` from now. */
export function issueChallenge(app: App, ceremony: Ceremony, party: RelyingParty): Challenge {
	const challenges = of(app);
	const now = app.now();
	if (challenges.size >= MOST) {
		for (const [challenge, entry] of challenges) if (now >= entry.deadline) challenges.delete(challenge);
		// A map keeps the order things were put in, so the first key is the oldest challenge.
		for (const challenge of challenges.keys()) {
			if (challenges.size < MOST) break;
			challenges.delete(challenge);
		}
	}
	const challenge = newChallenge();
	challenges.set(challenge, {
		ceremony,
		expected: { challenge, origin: party.origin, rpId: party.id },
		deadline: now + CEREMONY_MS,
	});
	return challenge;
}

/** A valid invitation reuses its challenge; near expiry a successor leaves any ongoing prompt valid. */
export function invitationChallenge(
	app: App,
	invitation: { codeHash: string; userHandle: string },
	party: RelyingParty,
): { challenge: Challenge; timeout: number } {
	const context = CONTEXT.invitation(invitation.codeHash);
	const now = app.now();
	for (const entry of of(app).values()) {
		if (
			entry.ceremony.purpose === "register" &&
			entry.ceremony.context === context &&
			entry.ceremony.userHandle === invitation.userHandle &&
			entry.expected.origin === party.origin &&
			entry.expected.rpId === party.id &&
			entry.deadline - now > 60_000
		)
			return { challenge: entry.expected.challenge, timeout: entry.deadline - now };
	}
	return {
		challenge: issueChallenge(app, { purpose: "register", userHandle: invitation.userHandle, context }, party),
		timeout: CEREMONY_MS,
	};
}

/**
 * What the verifier must hold an answer to, when `challenge` is one this server issued for this purpose and
 * its time has not run out; else null. `challenge` is what the answer says it answers (`challengeOf` in
 * `webauthn.ts` reads it as the verifier does), so it is only a key here: everything in the result is the
 * server's own record. Finding a challenge does not spend it. Whether the answer comes from where the
 * ceremony began is the caller's to compare (`ceremony.context`), each time it finds one.
 */
export function findChallenge<P extends Ceremony["purpose"]>(
	app: App,
	challenge: string,
	purpose: P,
): { ceremony: Extract<Ceremony, { purpose: P }>; expected: Expected } | null {
	const entry = kept.get(app)?.get(challenge);
	if (!entry || app.now() >= entry.deadline) return null;
	const { ceremony, expected } = entry;
	return isFor(ceremony, purpose) ? { ceremony, expected } : null;
}
const isFor = <P extends Ceremony["purpose"]>(
	ceremony: Ceremony,
	purpose: P,
): ceremony is Extract<Ceremony, { purpose: P }> => ceremony.purpose === purpose;

/**
 * Spends a challenge: it answers nothing from now on. Called inside the transaction that stores the passkey or
 * opens the session, after `findChallenge` found it there, with nothing awaited in between. So the second of
 * two answers to one challenge finds nothing, whichever of them reached the gate first.
 */
export function spendChallenge(app: App, challenge: string): void {
	kept.get(app)?.delete(challenge);
}

/**
 * Ends every ceremony that is under way. An import does this once it has committed: it replaced every person,
 * and a challenge issued before it must not be answered for whoever is there afterwards.
 */
export function clearChallenges(app: App): void {
	kept.delete(app);
	clearTotp(app);
	clearOidc(app);
	clearMailLinks(app);
}
