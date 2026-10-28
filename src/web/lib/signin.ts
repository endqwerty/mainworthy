// The routes by which somebody signs in and out, one function each. They are not operations: nobody is signed
// in yet when most of them are called (decision 0017). What a refusal means to the page is for the page to say;
// these throw the `ApiError` as the server sent it.
import { z } from "zod";
import { nullableText as schemaNullableText, number as schemaNumber, text as schemaText } from "../../core/schema.ts";
import { ApiError, exchange, session } from "./api.ts";
import { clearDevicePerson, type DeviceSession, deviceSession } from "./device.ts";

const Methods = z.object({
	/** The identity provider people sign in through, by the name the operator gave it; null for none. */
	oidc: z.object({ name: schemaText }).nullable().default(null),
});
export type Methods = z.infer<typeof Methods>;

/** What this instance offers on its sign-in page besides a token, which every instance takes. */
export async function signInMethods(): Promise<Methods> {
	return Methods.parse(await exchange("/api/login/methods"));
}

/** With a token: the owner, an instance with no provider, and whoever was handed one. */
export const signInWithToken = async (token: string): Promise<void> => {
	await exchange("/api/login", { body: { token } });
};

/** Where the page goes back to once the provider sends the browser back, kept for that one return. */
const OIDC_RETURN = "mainworthy:oidc-return";

/**
 * Sends the browser to the identity provider: to sign in (`{}`), to accept an invitation, to link the provider
 * to the person signed in here, or for that person to confirm it is them before a change to how they sign in.
 * The provider sends it back to `/signin/oidc` (`finishOidc`). It does not return unless the server refused to
 * begin; a browser signed in as somebody other than an invitation's person is refused `conflict`, with who it
 * is in `details.signedInAs`.
 */
export async function startOidc(
	body: Record<string, never> | { invitation: string; replace?: string } | { link: true } | { proof: true },
	/** The section of Settings to open again when the browser comes back. */
	section: string | null = null,
): Promise<void> {
	const { url } = z
		.object({ url: schemaText })
		.parse(await exchange("/api/login/oidc", { body, signedIn: "link" in body || "proof" in body }));
	sessionStorage.setItem(OIDC_RETURN, JSON.stringify({ path: location.pathname + location.search, section }));
	location.assign(url);
	await new Promise(() => {});
}

const Back = z.object({ path: schemaText.startsWith("/"), section: schemaNullableText });
export type Back = z.infer<typeof Back>;

/** What the provider's answer did: signed somebody in, linked an identity, or confirmed it is the person. */
export type Finished = "signed-in" | "linked" | "proven";

/**
 * Finishes with the query the provider sent the browser back with. `back` is where the page was when it began,
 * for a link or a confirmation to return to.
 */
export async function finishOidc(query: string): Promise<{ finished: Finished; back: Back | null }> {
	let back: Back | null = null;
	try {
		back = Back.parse(JSON.parse(sessionStorage.getItem(OIDC_RETURN) ?? "null"));
	} catch {}
	sessionStorage.removeItem(OIDC_RETURN);
	const result = z
		.union([
			z.object({ signedIn: z.literal(true) }),
			z.object({ linked: z.literal(true) }),
			z.object({ proven: z.literal(true) }),
		])
		.parse(await exchange("/api/login", { body: { oidc: query } }));
	return { finished: "linked" in result ? "linked" : "proven" in result ? "proven" : "signed-in", back };
}

const Shown = z.object({
	invitation: z.object({ name: schemaText, purpose: z.enum(["join", "recover"]), expiresAt: schemaNumber }),
});
export type ShownInvitation = z.infer<typeof Shown>;

/**
 * Who an invitation is for and until when. Asking changes nothing and may be repeated. Null for a code that
 * accepts nothing: used, revoked, run out or wrong, which the server does not tell apart.
 */
export async function showInvitation(code: string): Promise<ShownInvitation | null> {
	try {
		return Shown.parse(await exchange("/api/login/invitation", { body: { invitation: code } }));
	} catch (error) {
		if (error instanceof ApiError && error.code === "not_found") return null;
		throw error;
	}
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
