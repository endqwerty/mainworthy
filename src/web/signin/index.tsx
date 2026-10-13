import { useEffect, useState } from "react";
import { PasskeyError, passkeysAvailable, presentPasskey } from "../lib/passkey.ts";
import {
	type Methods,
	passkeySignInOptions,
	refusalOf,
	signInMethods,
	signInWithPasskey,
	signInWithPassword,
	signInWithToken,
} from "../lib/signin.ts";
import { DocLink } from "../ui/index.tsx";
import "./signin.css";

/** The three ways in, in the order the page shows them. */
type Way = "password" | "passkey" | "token";

/**
 * The sign-in page of an instance in server mode. A person signs in with their name and password, or with a
 * passkey where the instance and the browser have them. A token is the third way: it is how the owner gets in
 * before anybody has a password, and how a token handed to somebody is tried in a browser.
 *
 * All three are on the page at once, so each is reached with Tab and none is behind a click. One request runs
 * at a time, and a refusal is shown under the way that was tried, with everything that was typed left as it is.
 */
export function SignIn({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
	const [methods, setMethods] = useState<Methods | null>(null);
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [token, setToken] = useState("");
	const [busy, setBusy] = useState<Way | null>(null);
	const [refused, setRefused] = useState<{ way: Way; message: string } | null>(null);
	useEffect(() => {
		let shown = true;
		// Until the instance has said that it has passkeys, none is offered. If it cannot be asked, the two
		// forms still work.
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
		if (busy) return;
		setBusy(way);
		setRefused(null);
		void prove()
			.then(onSignedIn)
			.catch((error: unknown) =>
				setRefused({ way, message: error instanceof PasskeyError ? error.message : refusalOf(error, notSignedIn) }),
			)
			.finally(() => setBusy(null));
	};
	const said = (way: Way): string => (refused?.way === way ? refused.message : "");

	return (
		<div className="signin">
			<main className="signin-card">
				<h1>Mainworthy</h1>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						attempt("password", "That name and password did not sign you in.", () =>
							signInWithPassword({ name: name.trim(), password }),
						);
					}}
				>
					<label htmlFor="signin-name">Name</label>
					<input
						id="signin-name"
						name="username"
						autoComplete="username"
						autoCapitalize="none"
						spellCheck={false}
						// biome-ignore lint/a11y/noAutofocus: the page is this form; the first field is where typing starts.
						autoFocus
						required
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					<label htmlFor="signin-password">Password</label>
					<input
						id="signin-password"
						name="password"
						type="password"
						autoComplete="current-password"
						required
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
					<div className="signin-problem kept" role="status">
						{said("password")}
					</div>
					<button type="submit" disabled={busy !== null}>
						{busy === "password" ? "Signing in…" : "Sign in"}
					</button>
				</form>
				{methods?.passkey && passkeysAvailable() && (
					<div className="signin-way">
						<button
							type="button"
							className="plain"
							disabled={busy !== null}
							onClick={() =>
								attempt("passkey", "That passkey did not sign you in. Try again.", async () =>
									// The challenge is asked for now and not when the page loaded: it lives five minutes.
									signInWithPasskey(await presentPasskey(await passkeySignInOptions())),
								)
							}
						>
							{busy === "passkey" ? "Waiting for the passkey…" : "Sign in with a passkey"}
						</button>
						<div className="signin-problem" role="status">
							{said("passkey")}
						</div>
					</div>
				)}
				<p className="dim signin-note">If you lost your password or passkey, an admin can send you a new link.</p>
				<form
					className="signin-way"
					onSubmit={(event) => {
						event.preventDefault();
						attempt("token", "That token was not accepted. Try again.", () => signInWithToken(token));
					}}
				>
					<h2>Use a token</h2>
					<label htmlFor="token">Sign in with your token</label>
					<input
						id="token"
						name="token"
						type="password"
						autoComplete="off"
						required
						value={token}
						onChange={(event) => setToken(event.target.value)}
					/>
					<div className="error signin-problem" role="status">
						{said("token")}
					</div>
					<button type="submit" className="plain" disabled={busy !== null}>
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
