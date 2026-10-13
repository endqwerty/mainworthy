// A password: what one may be, how it is hashed and how it is checked. Owns no table and keeps no password:
// one comes in as an argument and leaves as an argon2id string, or as yes or no.
//
// Hashing is slow on purpose and runs on another thread (`Bun.password`), so whoever calls this is outside the
// write gate: a sign-in that is being checked never holds up a writer.
import type { Config } from "../kernel/app.ts";

/**
 * How long a password is, in characters. Twelve, because nothing else is asked of it: no digit, no capital
 * and no sign, which make passwords harder to remember and no harder to guess. The upper end only bounds the
 * work of hashing what a stranger sends.
 */
export const PASSWORD_LENGTH = { min: 12, max: 256 } as const;

/** Why this text cannot be a password, as a sentence for the person who typed it, or null when it can. */
export function whyNotPassword(text: string): string | null {
	// Characters as a person counts them, not UTF-16 units.
	const length = [...text].length;
	return length >= PASSWORD_LENGTH.min && length <= PASSWORD_LENGTH.max
		? null
		: `a password is ${PASSWORD_LENGTH.min} to ${PASSWORD_LENGTH.max} characters`;
}

type Cost = Config["passwordCost"];

/**
 * Thrown when a password cannot be hashed or checked now, because too many others are waiting. The caller
 * answers as it does for a wrong password: somebody who floods the sign-in is not told that it worked.
 */
export class PasswordWorkBusy extends Error {}

// One hash takes 64 MiB and a tenth of a second at the cost the build ships with, and whoever can reach the
// sign-in can ask for one without knowing a name. So only this many run at once, and only this many wait:
// 128 MiB at most, and a queue that empties in under two seconds.
const AT_ONCE = 2;
const MAY_WAIT = 32;
let running = 0;
const waiting: (() => void)[] = [];

async function inTurn<T>(work: () => Promise<T>): Promise<T> {
	if (running >= AT_ONCE) {
		if (waiting.length >= MAY_WAIT) throw new PasswordWorkBusy("too many passwords are being checked");
		await new Promise<void>((resolve) => waiting.push(resolve));
	} else running++;
	try {
		return await work();
	} finally {
		// The turn is handed to whoever waits first, so `running` only falls when nobody does.
		const next = waiting.shift();
		if (next) next();
		else running--;
	}
}

/** The argon2id string for a password: the algorithm, its cost, a new salt and the hash, in one text. */
export function hashPassword(password: string, cost: Cost): Promise<string> {
	return inTurn(() => Bun.password.hash(password, { algorithm: "argon2id", ...cost }));
}

/** Whether `password` is the one `stored` was made from. A stored text that is no hash at all matches nothing. */
export function verifyPassword(password: string, stored: string): Promise<boolean> {
	return inTurn(() => Bun.password.verify(password, stored).catch(() => false));
}

const dummies = new Map<string, Promise<string>>();
/**
 * A hash nobody's password matches, at the same cost as a real one. A sign-in for a name that has no password
 * is checked against it, so that it takes as long as a wrong password for a name that has one, and the time
 * of a refusal does not say which names exist.
 */
export function dummyHash(cost: Cost): Promise<string> {
	const key = JSON.stringify(cost ?? null);
	let made = dummies.get(key);
	if (!made) {
		// Random, so no password anybody could send is the one it was made from.
		made = hashPassword(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"), cost);
		// A hash that could not be made is tried again by the next caller, not kept as a failure.
		made.catch(() => dummies.delete(key));
		dummies.set(key, made);
	}
	return made;
}
