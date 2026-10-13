// The challenges of passkey ceremonies that are under way. In memory, for one `App`: a challenge lives five
// minutes and is worth nothing after a restart, so no table holds it.
//
// The passkey verifier judges one answer against what it is handed and keeps nothing (`webauthn.ts`). What it
// is handed comes from here: the challenge the server made, what it was made for, and the origin and RP ID it
// was made under. A challenge is found by an answer and spent by the commit that the answer leads to, so of
// two answers to one challenge only one stores a passkey or opens a session.
import type { App } from "../kernel/app.ts";
import { CEREMONY_MS, type Challenge, type Expected, newChallenge, type RelyingParty } from "./webauthn.ts";

/** What a challenge was issued for. An answer to one is no answer to the other. */
export type Ceremony =
	/**
	 * A new passkey for one person, named by the handle their passkeys are filed under and not by the number of
	 * their row: an import gives the numbers to other people, and the handle goes with the person.
	 */
	| { readonly purpose: "register"; readonly userHandle: string }
	/** A sign-in by whoever holds a passkey of this instance. It names nobody. */
	| { readonly purpose: "sign-in" };

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

/**
 * What the verifier must hold an answer to, when `challenge` is one this server issued for this purpose and
 * its time has not run out; else null. `challenge` is what the answer says it answers, so it is only a key
 * here: everything in the result is the server's own record. Finding a challenge does not spend it.
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
}

/**
 * The challenge an answer says it answers: the `challenge` member of its `clientDataJSON`, or null when there
 * is none to read. Used to find the server's record and for nothing else; the verifier compares the two again.
 */
export function challengeOf(answer: unknown): string | null {
	if (typeof answer !== "object" || answer === null || !("clientDataJSON" in answer)) return null;
	const encoded = answer.clientDataJSON;
	// A browser's client data is a few hundred bytes. Nothing longer is decoded to look for a key.
	if (typeof encoded !== "string" || encoded.length > 8192) return null;
	try {
		const data: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (typeof data !== "object" || data === null || !("challenge" in data)) return null;
		return typeof data.challenge === "string" ? data.challenge : null;
	} catch {
		return null;
	}
}
