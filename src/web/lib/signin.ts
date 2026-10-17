// The routes by which somebody signs in and out, one function each. They are not operations: nobody is signed
// in yet when most of them are called, and a password never goes through an operation (decision 0017). What a
// refusal means to the page is for the page to say; these throw the `ApiError` as the server sent it.
import { z } from "zod";
import { PasswordEntry } from "../../core/people.ts";
import { ApiError, exchange, session } from "./api.ts";
import { clearDevicePerson, type DeviceSession, deviceSession } from "./device.ts";
import { type Assertion, CreationOptions, type Registration, RequestOptions } from "./passkey.ts";

const Methods = z.object({
	password: z.boolean(),
	passkey: z.boolean(),
	mail: z.boolean().default(false),
	/** The identity provider people may sign in through, by the name the operator gave it; null for none. */
	oidc: z.object({ name: z.string() }).nullable().default(null),
});
export type Methods = z.infer<typeof Methods>;

/** What this instance offers on its sign-in page. `passkey` is false on an instance with no public address. */
export async function signInMethods(): Promise<Methods> {
	return Methods.parse(await exchange("/api/login/methods"));
}

type SignIn =
	| { token: string }
	| { name: string; password: string }
	| { passkey: Assertion }
	| { invitation: string; password?: string; passkey?: Registration; label?: string; replace?: string };

/**
 * `POST /api/login`. The body is exactly one of the four shapes, and the server refuses a member that does not
 * belong to its shape, so each function below builds its own and nothing is spread into one.
 */
const signIn = async (body: SignIn): Promise<void> => {
	await exchange("/api/login", { body });
};

/** With a token: the owner, an instance with no people yet, and whoever was handed one. */
export const signInWithToken = (token: string): Promise<void> => signIn({ token });

export const signInWithPassword = async (input: { name: string; password: string }): Promise<PasswordEntry> =>
	PasswordEntry.parse(await exchange("/api/login", { body: { name: input.name, password: input.password } }));
export const signInWithTotp = async (challenge: string, code: string): Promise<void> => {
	await exchange("/api/login", { body: { challenge, code } });
};

/** With what `presentPasskey` returned for the options of `passkeySignInOptions`. */
export const signInWithPasskey = (passkey: Assertion): Promise<void> => signIn({ passkey });

export type Acceptance = {
	code: string;
	/** At least one of a password and a passkey. */
	password: string | null;
	passkey: { made: Registration; label: string } | null;
	/**
	 * The person whose session in this browser may end with the acceptance: the name the page asked about and
	 * was told yes for, and never one it did not show. Null when it asked about nobody.
	 */
	replace: string | null;
};

/**
 * Accepts an invitation, which signs the person in. A browser that is signed in as somebody other than the
 * invited person and other than `replace` is answered `conflict`, with who it is in `details.signedInAs`, and
 * nothing is changed: the server reads who holds the browser when it accepts, so an answer about one person
 * ends nobody else's session.
 */
export const acceptInvitation = (accepted: Acceptance): Promise<void> =>
	signIn({
		invitation: accepted.code,
		...(accepted.password === null ? {} : { password: accepted.password }),
		...(accepted.passkey ? { passkey: accepted.passkey.made, label: accepted.passkey.label } : {}),
		...(accepted.replace === null ? {} : { replace: accepted.replace }),
	});

/** Where the page goes back to once the provider sends the browser back, kept for that one return. */
const OIDC_RETURN = "mainworthy:oidc-return";

/**
 * Sends the browser to the identity provider: to sign in (`{}`), to accept an invitation, or to link the
 * provider to the person signed in here. The provider sends it back to `/signin/oidc` (`finishOidc`). It does
 * not return unless the server refused to begin.
 */
export async function startOidc(
	body: Record<string, never> | { invitation: string; replace?: string } | { link: true },
	/** The section of Settings to open again when the browser comes back. */
	section: string | null = null,
): Promise<void> {
	const { url } = z
		.object({ url: z.string() })
		.parse(await exchange("/api/login/oidc", { body, signedIn: "link" in body }));
	sessionStorage.setItem(OIDC_RETURN, JSON.stringify({ path: location.pathname + location.search, section }));
	location.assign(url);
	await new Promise(() => {});
}

const Back = z.object({ path: z.string().startsWith("/"), section: z.string().nullable() });
export type Back = z.infer<typeof Back>;

/**
 * Finishes with the query the provider sent the browser back with: signed in, or the provider linked to the
 * person signed in here. `back` is where the page was when it began, for a link to return to.
 */
export async function finishOidc(query: string): Promise<{ linked: boolean; back: Back | null }> {
	let back: Back | null = null;
	try {
		back = Back.parse(JSON.parse(sessionStorage.getItem(OIDC_RETURN) ?? "null"));
	} catch {}
	sessionStorage.removeItem(OIDC_RETURN);
	const result = z
		.union([z.object({ signedIn: z.literal(true) }), z.object({ linked: z.literal(true) })])
		.parse(await exchange("/api/login", { body: { oidc: query } }));
	return { linked: "linked" in result, back };
}

/**
 * The options to sign in with a passkey. They hold a challenge that lives five minutes and is good for one
 * sign-in, so they are asked for when the button is pressed and not when the page loads.
 */
export async function passkeySignInOptions(): Promise<RequestOptions> {
	return z.object({ passkey: RequestOptions }).parse(await exchange("/api/login/challenge", { body: {} })).passkey;
}

const Shown = z.object({
	invitation: z.object({ name: z.string(), purpose: z.enum(["join", "recover"]), expiresAt: z.number() }),
	/** Null on an instance with no public address: the invitation is accepted with a password. */
	passkey: CreationOptions.nullable(),
});
export type ShownInvitation = z.infer<typeof Shown>;

/**
 * Who an invitation is for and until when, with the options to make a passkey for it. Asking changes nothing
 * and may be repeated; each asking has a challenge of its own. Null for a code that accepts nothing: used,
 * revoked, run out or wrong, which the server does not tell apart.
 */
export async function showInvitation(code: string): Promise<ShownInvitation | null> {
	try {
		return Shown.parse(await exchange("/api/login/challenge", { body: { invitation: code } }));
	} catch (error) {
		if (error instanceof ApiError && error.code === "not_found") return null;
		throw error;
	}
}

/**
 * Sets the password of the person this browser is signed in as, or replaces it. `current` is sent when they
 * have one. The reply says how many other sessions rested on the old password and ended with it.
 */
export async function setPassword(input: { current: string | null; next: string }): Promise<{ sessionsEnded: number }> {
	return z.object({ sessionsEnded: z.number() }).parse(
		await exchange("/api/account/password", {
			body: { ...(input.current === null ? {} : { current: input.current }), next: input.next },
			signedIn: true,
		}),
	);
}

function clearSignedOutData(owner: DeviceSession): void {
	try {
		clearDevicePerson(owner);
	} catch {
		window.alert(
			"You are signed out, but this browser could not clear all your data. Clear this site's data in your browser settings before leaving a shared computer.",
		);
	}
}

/** The choice to clear belongs only to this attempt, including its two checks after a lost reply. */
export const signOut = async ({ clear }: { clear: boolean }): Promise<"signed-out" | "signed-in" | "unknown"> => {
	const owner = clear ? deviceSession() : null;
	try {
		await exchange("/api/logout", { body: {} });
	} catch {
		let ended = false;
		for (let check = 0; check < 2; check++) {
			try {
				await session();
				return "signed-in";
			} catch (error) {
				if (error instanceof ApiError && error.code === "unauthenticated" && error.status === 401) {
					ended = true;
					break;
				}
			}
		}
		if (!ended) return "unknown";
	}
	if (owner) clearSignedOutData(owner);
	return "signed-out";
};

/** What to show for a failure that is not the server's refusal: the request did not get there, or no reply came back. */
export const NO_ANSWER = "Mainworthy did not answer. Check the connection and try again.";

export const requestReset = async (email: string): Promise<void> => {
	await exchange("/api/login", { body: { resetRequest: email } });
};
export const verifyEmail = async (code: string): Promise<void> => {
	await exchange("/api/login", { body: { emailVerification: code } });
};
export const resetPassword = async (code: string, password: string): Promise<void> => {
	await exchange("/api/login", { body: { reset: code, password } });
};

/**
 * The sentence for a refused sign-in. The server answers 401 with one sentence whatever was wrong, and the page
 * says which way of signing in that was (`notSignedIn`). Any other refusal is shown as it came: a request that
 * took too long to arrive, in the server's words, and a limit on attempts as the wait `exchange` read from the
 * reply. The status decides, not the code, so that a refusal which is not "this did not sign you in" is never
 * replaced by that sentence.
 */
export function refusalOf(error: unknown, notSignedIn: string): string {
	if (!(error instanceof ApiError)) return NO_ANSWER;
	return error.status === 401 ? notSignedIn : error.message;
}
