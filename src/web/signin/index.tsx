import { useEffect, useRef, useState } from "react";
import { type Methods, refusalOf, signInMethods, signInWithToken, startOidc } from "../lib/signin.ts";
import { DocLink } from "../ui/index.tsx";
import "./signin.css";

/** The ways in, in the order the page shows them. */
type Way = "oidc" | "token";

/**
 * The sign-in page of an instance in server mode. A person signs in through the instance's identity provider
 * where it has one. A token is the other way: it is how the owner gets in on an instance with no provider, and
 * how a token handed to somebody is tried in a browser.
 *
 * Both are on the page at once, so each is reached with Tab and neither is behind a click. One request runs at
 * a time, and a refusal is shown under the way that was tried, with what was typed left as it is.
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
	const [methods, setMethods] = useState<Methods | null>(null);
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState<Way | null>(null);
	const [refused, setRefused] = useState<{ way: Way; message: string } | null>(null);
	useEffect(() => {
		let shown = true;
		// Until the instance has said that it has a provider, none is offered. If it cannot be asked, the token
		// still works.
		void signInMethods().then(
			(offered) => {
				if (shown) setMethods(offered);
			},
			() => {},
		);
		return () => {
			shown = false;
		};
	}, []);

	const attempt = (way: Way, notSignedIn: string, prove: () => Promise<void>): void => {
		// The buttons stay focusable while a request runs (`aria-disabled`), so this is what stops a second one.
		if (busy) return;
		setBusy(way);
		setRefused(null);
		void prove()
			.then(onSignedIn)
			.catch((error: unknown) => setRefused({ way, message: refusalOf(error, notSignedIn) }))
			.finally(() => setBusy(null));
	};
	const said = (way: Way): string => (refused?.way === way ? refused.message : "");
	const provider = methods?.oidc?.name ?? null;
	const tokenRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		// With no provider the token is the way in, and typing starts there. The provider's button takes the
		// focus itself when it comes.
		if (methods && !methods.oidc) tokenRef.current?.focus();
	}, [methods]);

	return (
		<div className="signin">
			<main className="signin-card">
				<h1>Mainworthy</h1>
				{provider && (
					<>
						<button
							type="button"
							// biome-ignore lint/a11y/noAutofocus: the page is this button; it is where a person starts.
							autoFocus
							aria-disabled={busy !== null}
							onClick={() =>
								attempt("oidc", "The identity provider could not be reached. Try again.", () => startOidc({}))
							}
						>
							{busy === "oidc" ? `Opening ${provider}…` : `Sign in with ${provider}`}
						</button>
						<div className="signin-problem" role="status">
							{said("oidc")}
						</div>
						<p className="dim signin-note">
							If you cannot sign in with {provider} any more, an admin can send you a new link.
						</p>
					</>
				)}
				<form
					className={provider ? "signin-way" : undefined}
					onSubmit={(event) => {
						event.preventDefault();
						attempt("token", "That token was not accepted. Try again.", () => signInWithToken(token));
					}}
				>
					<h2>Use a token</h2>
					<label htmlFor="token">Sign in with your token</label>
					<input
						id="token"
						ref={tokenRef}
						name="token"
						type="password"
						autoComplete="off"
						// A token is not a password: 1Password offers one wherever a password is typed, whatever
						// `autocomplete` says, and leaves a field with this attribute alone.
						data-1p-ignore
						required
						value={token}
						onChange={(event) => setToken(event.target.value)}
					/>
					<div className="error signin-problem" role="status">
						{said("token")}
					</div>
					<button type="submit" className="plain" aria-disabled={busy !== null}>
						{busy === "token" ? "Signing in…" : "Sign in with the token"}
					</button>
				</form>
				<p className="signin-help">
					New here? <DocLink page="index">Read the docs</DocLink>
				</p>
			</main>
		</div>
	);
}
