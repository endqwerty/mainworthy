import { useEffect, useRef, useState } from "react";
import { type Back, type Finished, finishOidc, refusalOf } from "../lib/signin.ts";
import "./signin.css";

/** Where the identity provider sends the browser back to, with a code and a state in the query. */
export const OIDC_PATH = "/signin/oidc";

/**
 * The provider's answer, handed over once per page load. React runs an effect twice in development, and the
 * server takes an answer only once, so the second run waits for the first instead of sending it again.
 */
let handing: { query: string; done: Promise<{ finished: Finished; back: Back | null }> } | null = null;

/**
 * The page the identity provider sends the browser back to. It hands the provider's answer to the server from
 * this origin, which is how the browser's cookies go with it, and then opens the app: signed in, or back where
 * a person was when they linked an identity or confirmed it is them. The app asks who is signed in only once
 * `onDone` is called. The query leaves the address bar at once.
 */
export function OidcReturn({ onDone }: { onDone: (to: Back, finished: Finished) => void }) {
	const [problem, setProblem] = useState<string | null>(null);
	// The app's callback may be a new function on each render; the answer is handed over once all the same.
	const done = useRef(onDone);
	done.current = onDone;
	useEffect(() => {
		const query = handing?.query ?? location.search;
		history.replaceState(null, "", OIDC_PATH);
		if (!query) {
			setProblem("There is nothing to finish here. Start again from the sign-in page.");
			return;
		}
		if (handing?.query !== query) handing = { query, done: finishOidc(query) };
		let shown = true;
		handing.done.then(
			({ finished, back }) => {
				if (shown) done.current(finished !== "signed-in" && back ? back : { path: "/", section: null }, finished);
			},
			(error: unknown) => {
				if (shown) setProblem(refusalOf(error, "That did not sign you in. Start again from the sign-in page."));
			},
		);
		return () => {
			shown = false;
		};
	}, []);
	return (
		<div className="signin">
			<main className="signin-card">
				<h1>Mainworthy</h1>
				{problem === null ? (
					<p className="dim" role="status">
						Finishing…
					</p>
				) : (
					<>
						<p role="alert">{problem}</p>
						<p>
							<a href="/">Back to Mainworthy</a>
						</p>
					</>
				)}
			</main>
		</div>
	);
}
