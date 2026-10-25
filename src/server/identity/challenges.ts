import { z } from "zod";
import type { App } from "../kernel/app.ts";
import type { ReadDb, WriteDb } from "../kernel/db.ts";
import { Ceremonies, ceremonyWrite, clearCeremonies } from "./ceremonies.ts";
import { CONTEXT } from "./contexts.ts";
import { CEREMONY_MS, type Challenge, type Expected, newChallenge, type RelyingParty } from "./webauthn.ts";

/** What a challenge was issued for, and where. An answer to one is no answer to the other. */
export type Ceremony =
	/**
	 * A new passkey for one person, named by the handle their passkeys are filed under and not by the number of
	 * their row: an import gives the numbers to other people, and the handle goes with the person.
	 */
	| { readonly purpose: "register"; readonly userHandle: string; readonly context: string }
	/** A sign-in by whoever holds a passkey of this instance. It names nobody. */
	| { readonly purpose: "sign-in"; readonly context: string }
	| { readonly purpose: "prove"; readonly actor: number; readonly context: string };

type Kept = { readonly ceremony: Ceremony; readonly expected: Expected; readonly deadline: number };

const Payload = z.object({
	ceremony: z.discriminatedUnion("purpose", [
		z.object({ purpose: z.literal("register"), userHandle: z.string(), context: z.string() }),
		z.object({ purpose: z.literal("sign-in"), context: z.string() }),
		z.object({ purpose: z.literal("prove"), actor: z.number().int(), context: z.string() }),
	]),
	expected: z.object({ challenge: z.string(), origin: z.string(), rpId: z.string() }),
	deadline: z.number(),
});
const kept = new Ceremonies("passkey", (value): Kept => {
	const parsed = Payload.parse(value);
	return { ...parsed, expected: { ...parsed.expected, challenge: newChallengeValue(parsed.expected.challenge) } };
});
function newChallengeValue(value: string): Challenge {
	// The stored value has the same opaque spelling as a generated challenge.
	if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("invalid stored challenge");
	return value as Challenge;
}

/** A new challenge for a ceremony at this relying party. It can be answered until `CEREMONY_MS` from now. */
export async function issueChallenge(
	app: App,
	ceremony: Ceremony,
	party: RelyingParty,
	owner = ceremony.context,
	db?: WriteDb,
): Promise<Challenge> {
	const now = app.now();
	const challenge = newChallenge();
	await ceremonyWrite(app, db, (lease) =>
		kept.put(
			lease,
			challenge,
			{
				ceremony,
				expected: { challenge, origin: party.origin, rpId: party.id },
				deadline: now + CEREMONY_MS,
			},
			owner,
			now,
		),
	);
	return challenge;
}

/** A valid invitation reuses its challenge; near expiry a successor leaves any ongoing prompt valid. */
export async function invitationChallenge(
	app: App,
	invitation: { codeHash: string; userHandle: string },
	party: RelyingParty,
): Promise<{ challenge: Challenge; timeout: number }> {
	const context = CONTEXT.invitation(invitation.codeHash);
	const reusable = async (db: ReadDb) => {
		const now = app.now();
		for (const entry of await kept.owned(db, context, now)) {
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
		return null;
	};
	const existing = await app.database.admissionRead(reusable);
	if (existing) return existing;
	return await ceremonyWrite(app, undefined, (db) =>
		kept.forOwner(db, context, async () => {
			const existing = await reusable(db);
			if (existing) return existing;
			return {
				challenge: await issueChallenge(
					app,
					{ purpose: "register", userHandle: invitation.userHandle, context },
					party,
					context,
					db,
				),
				timeout: CEREMONY_MS,
			};
		}),
	);
}

/**
 * What the verifier must hold an answer to, when `challenge` is one this server issued for this purpose and
 * its time has not run out; else null. `challenge` is what the answer says it answers (`challengeOf` in
 * `webauthn.ts` reads it as the verifier does), so it is only a key here: everything in the result is the
 * server's own record. Finding a challenge does not spend it. Whether the answer comes from where the
 * ceremony began is the caller's to compare (`ceremony.context`), each time it finds one.
 */
export async function findChallenge<P extends Ceremony["purpose"]>(
	app: App,
	challenge: string,
	purpose: P,
	db?: ReadDb,
): Promise<{ ceremony: Extract<Ceremony, { purpose: P }>; expected: Expected } | null> {
	const entry = db
		? await kept.get(db, challenge, app.now())
		: await app.database.admissionRead((read) => kept.get(read, challenge, app.now()));
	if (!entry || app.now() >= entry.deadline) return null;
	const { ceremony, expected } = entry;
	return isFor(ceremony, purpose) ? { ceremony, expected } : null;
}
const isFor = <P extends Ceremony["purpose"]>(
	ceremony: Ceremony,
	purpose: P,
): ceremony is Extract<Ceremony, { purpose: P }> => ceremony.purpose === purpose;

/**
 * Spends a challenge in the transaction that stores its passkey or opens its session. The conditional delete
 * chooses one consumer across instances; a rollback restores both the proof and its domain changes.
 */
export async function spendChallenge(app: App, challenge: string, db: WriteDb): Promise<boolean> {
	return await kept.take(db, challenge, app.now());
}

/** Ends ceremonies in the import transaction, including proofs already exchanging with a provider. */
export async function clearChallenges(app: App, db?: WriteDb): Promise<void> {
	await ceremonyWrite(app, db, clearCeremonies);
}
