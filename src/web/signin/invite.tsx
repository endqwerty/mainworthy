import { type FormEvent, useEffect, useRef, useState } from "react";
import { whyNotPassword } from "../../core/people.ts";
import { ApiError } from "../lib/api.ts";
import { browserName } from "../lib/browser.ts";
import { makePasskey, PasskeyError, passkeysAvailable } from "../lib/passkey.ts";
import { dateTime } from "../lib/people.ts";
import {
	type Acceptance,
	acceptInvitation,
	NO_ANSWER,
	refusalOf,
	type ShownInvitation,
	showInvitation,
} from "../lib/signin.ts";
import { PasswordCount } from "../ui/index.tsx";
import "./signin.css";

/** Where the page of an invitation is. The link is this path with the code after a `#`. */
export const INVITE_PATH = "/invite";

/**
 * Reads the code from the address and takes it out of the address bar at once, whatever becomes of it: it is
 * what signs somebody in, and it should not stay in the tab's history or be copied with the address. From here
 * on the code is in the page's memory only, so a reload has none.
 */
function takeCode(): string {
	const code = location.hash.slice(1);
	if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
	return code;
}

/** A passkey's challenge is good for five minutes. One asked for longer ago than this is asked for again. */
const CHALLENGE_FRESH_MS = 4 * 60_000;

const GONE = "This invitation does not work any more. Ask whoever sent it for a new one.";
const NOT_ACCEPTED =
	"That did not work. The invitation may have been used or have run out. Open the link again to check.";

type Stage =
	| { kind: "none" }
	| { kind: "looking" }
	| { kind: "gone" }
	| { kind: "unreachable"; message: string }
	| { kind: "shown"; shown: ShownInvitation; askedAt: number };

/**
 * The page an invitation link opens. It renders with nobody signed in and changes nothing by being opened: it
 * asks the server who the invitation is for, and the person then sets a password, makes a passkey, or both,
 * which accepts the invitation and signs them in.
 *
 * `signedInAs` is who this browser is signed in as already: null for nobody, undefined while that is being
 * found out. `onDone` leaves the page for the app, as whoever the browser is signed in as by then.
 */
export function Invitation({
	signedInAs,
	onDone,
}: {
	signedInAs: string | null | undefined;
	onDone: () => Promise<void>;
}) {
	// One asking of the server. A new object asks again, for another code or for the same one once more.
	const [asked, setAsked] = useState(() => ({ code: takeCode() }));
	const [stage, setStage] = useState<Stage>({ kind: "looking" });
	const { code } = asked;
	useEffect(() => {
		// A second link pasted into the same tab changes only the part after the `#`, and loads nothing.
		const changed = () => {
			const next = takeCode();
			if (next) setAsked({ code: next });
		};
		window.addEventListener("hashchange", changed);
		return () => window.removeEventListener("hashchange", changed);
	}, []);
	useEffect(() => {
		if (!asked.code) {
			setStage({ kind: "none" });
			return;
		}
		let current = true;
		setStage({ kind: "looking" });
		void showInvitation(asked.code).then(
			(shown) => {
				if (current) setStage(shown ? { kind: "shown", shown, askedAt: Date.now() } : { kind: "gone" });
			},
			(error: unknown) => {
				if (current) setStage({ kind: "unreachable", message: error instanceof ApiError ? error.message : NO_ANSWER });
			},
		);
		return () => {
			current = false;
		};
	}, [asked]);

	if (stage.kind === "shown")
		return (
			<Accept
				// A form belongs to one invitation: another link starts with empty fields.
				key={code}
				code={code}
				shown={stage.shown}
				askedAt={stage.askedAt}
				signedInAs={signedInAs}
				onDone={onDone}
				onGone={() => setStage({ kind: "gone" })}
				onShown={(shown) => setStage({ kind: "shown", shown, askedAt: Date.now() })}
			/>
		);
	return (
		<div className="signin">
			<main className="signin-card">
				<h1>Invitation</h1>
				{stage.kind === "looking" && <p className="dim">Checking the invitation…</p>}
				<p role="status">
					{stage.kind === "gone" && GONE}
					{stage.kind === "none" && "This address holds no invitation. Open the link you were given again."}
					{stage.kind === "unreachable" && stage.message}
				</p>
				{stage.kind === "unreachable" && (
					<button type="button" onClick={() => setAsked({ code })}>
						Try again
					</button>
				)}
				{(stage.kind === "gone" || stage.kind === "none") && (
					<p>
						<a href="/">Go to Mainworthy</a>
					</p>
				)}
			</main>
		</div>
	);
}

type Problem = { at: "password" | "again" | "passkey" | "form"; message: string };

function Accept({
	code,
	shown,
	askedAt,
	signedInAs,
	onDone,
	onGone,
	onShown,
}: {
	code: string;
	shown: ShownInvitation;
	askedAt: number;
	signedInAs: string | null | undefined;
	onDone: () => Promise<void>;
	onGone: () => void;
	onShown: (shown: ShownInvitation) => void;
}) {
	const { name, purpose, expiresAt } = shown.invitation;
	const [password, setPassword] = useState("");
	const [again, setAgain] = useState("");
	const [wantPasskey, setWantPasskey] = useState(false);
	const [label, setLabel] = useState(() => browserName(navigator.userAgent));
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<Problem | null>(null);
	// Who the server said this browser is signed in as when it refused an acceptance, and what was sent then.
	const [refusedFor, setRefusedFor] = useState<{ signedInAs: string; sent: Acceptance } | null>(null);
	const [replace, setReplace] = useState(false);
	const passwordRef = useRef<HTMLInputElement>(null);
	const passkeyOffered = shown.passkey !== null && passkeysAvailable();
	const other = refusedFor?.signedInAs ?? (signedInAs && signedInAs !== name ? signedInAs : null);
	// Somebody else is signed in here, and the person has not said yet that their session may end.
	const asking = other !== null && !replace;
	useEffect(() => {
		// The fields are where typing starts, when the page opens and when the question above them is answered.
		if (!asking) passwordRef.current?.focus();
	}, [asking]);
	const said = (at: Problem["at"]): string => (problem?.at === at ? problem.message : "");

	/** Sends an acceptance. What comes back decides: the app, the question about the other session, or a refusal. */
	async function send(acceptance: Acceptance): Promise<void> {
		try {
			await acceptInvitation(acceptance);
		} catch (error) {
			const holder = error instanceof ApiError && error.code === "conflict" ? error.details.signedInAs : null;
			if (typeof holder === "string") {
				// Nothing was changed and the invitation still works. The same acceptance goes again on a yes,
				// passkey included: its challenge is spent only by an acceptance that went through.
				setRefusedFor({ signedInAs: holder, sent: acceptance });
				setReplace(false);
				return;
			}
			setProblem({ at: "form", message: refusalOf(error, NOT_ACCEPTED) });
			return;
		}
		await onDone();
	}

	const typed = password !== "" || again !== "";
	/** What is wrong with the form as it stands, checked in the page before anything is sent. */
	function unfit(): Problem | null {
		if (!typed && !wantPasskey)
			return {
				at: "password",
				message: passkeyOffered ? "Choose a password, a passkey, or both." : "Choose a password.",
			};
		const why = typed ? whyNotPassword(password) : null;
		if (why) return { at: "password", message: why };
		if (typed && password !== again) return { at: "again", message: "The two passwords differ." };
		if (wantPasskey && !label.trim())
			return { at: "passkey", message: "Give the passkey a name, such as the device it is on." };
		return null;
	}

	async function accept(): Promise<void> {
		let passkey: Acceptance["passkey"] = null;
		if (wantPasskey) {
			let offered = shown.passkey;
			if (Date.now() - askedAt > CHALLENGE_FRESH_MS) {
				const fresh = await showInvitation(code);
				if (!fresh) {
					onGone();
					return;
				}
				onShown(fresh);
				offered = fresh.passkey;
			}
			if (!offered) throw new PasskeyError("This instance has no passkeys.");
			passkey = { made: await makePasskey(offered), label: label.trim() };
		}
		await send({ code, password: typed ? password : null, passkey, replace });
	}

	/** One request at a time, and whatever fails is said on the page. */
	function run(work: () => Promise<void>, at: Problem["at"]): void {
		if (busy) return;
		setBusy(true);
		setProblem(null);
		void work()
			.catch((error: unknown) =>
				setProblem({ at, message: error instanceof PasskeyError ? error.message : refusalOf(error, NOT_ACCEPTED) }),
			)
			.finally(() => setBusy(false));
	}
	const submit = (event: FormEvent): void => {
		event.preventDefault();
		if (asking || busy) return;
		const wrong = unfit();
		if (wrong) setProblem(wrong);
		else run(accept, wantPasskey ? "passkey" : "form");
	};

	return (
		<div className="signin">
			<main className="signin-card">
				<h1>You are invited as {name}</h1>
				<p className="dim">This link works once, until {dateTime(expiresAt)}.</p>
				{purpose === "recover" && <p>Accepting replaces every way you sign in and signs you out everywhere else.</p>}
				{asking && (
					<div className="signin-ask">
						<p>
							You are signed in as {other}. This invitation is for {name}. Sign {other} out of this browser and
							continue?
						</p>
						<div>
							<button
								type="button"
								// biome-ignore lint/a11y/noAutofocus: the question stops the page until it is answered, so the answer is where the keys go.
								autoFocus
								disabled={busy}
								onClick={() => {
									setReplace(true);
									// What was already sent goes again, this time to replace. Nothing is typed twice.
									const sent = refusedFor?.sent;
									if (sent) run(() => send({ ...sent, replace: true }), "form");
								}}
							>
								Continue as {name}
							</button>
							<button type="button" className="plain" disabled={busy} onClick={() => run(onDone, "form")}>
								Stay signed in as {other}
							</button>
						</div>
					</div>
				)}
				<form onSubmit={submit}>
					<fieldset disabled={asking}>
						{/* For a password manager: the name this password is saved under. */}
						<input type="text" name="username" autoComplete="username" value={name} readOnly hidden />
						<label htmlFor="invite-password">Password</label>
						<input
							id="invite-password"
							name="password"
							type="password"
							autoComplete="new-password"
							aria-describedby="invite-count"
							ref={passwordRef}
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
						<PasswordCount id="invite-count" className="signin-count" text={password} />
						<div className="signin-problem" role="status">
							{said("password")}
						</div>
						<label htmlFor="invite-password-again">Password again</label>
						<input
							id="invite-password-again"
							name="password-again"
							type="password"
							autoComplete="new-password"
							value={again}
							onChange={(event) => setAgain(event.target.value)}
						/>
						<div className="signin-problem" role="status">
							{said("again")}
						</div>
						{passkeyOffered && (
							<>
								<label className="signin-check">
									<input
										type="checkbox"
										checked={wantPasskey}
										onChange={(event) => setWantPasskey(event.target.checked)}
									/>
									Make a passkey on this device
								</label>
								{wantPasskey && (
									<>
										<label htmlFor="invite-passkey-name">Passkey name</label>
										<input
											id="invite-passkey-name"
											maxLength={60}
											value={label}
											onChange={(event) => setLabel(event.target.value)}
										/>
									</>
								)}
								<div className="signin-problem" role="status">
									{said("passkey")}
								</div>
							</>
						)}
						<div className="signin-problem" role="status">
							{said("form")}
						</div>
						<button type="submit" disabled={busy}>
							{busy ? "Accepting…" : "Accept and sign in"}
						</button>
					</fieldset>
				</form>
			</main>
		</div>
	);
}
