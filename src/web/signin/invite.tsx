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
import { PASSWORD_RULES, PasswordCount } from "../ui/index.tsx";
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

/**
 * A passkey's challenge is good for five minutes. Before a passkey is made, one asked for longer ago than four
 * is asked for again; a passkey that was made and then waited for an answer is sent while the five last.
 */
const CHALLENGE_LASTS_MS = 5 * 60_000;
const CHALLENGE_FRESH_MS = 4 * 60_000;

const GONE = "This invitation does not work any more. Ask whoever sent it for a new one.";
const NOT_ACCEPTED =
	"That did not work. The invitation may have been used or have run out. Open the link again to check.";
/** The request went and no reply came back: the server may have accepted, and a second acceptance is refused. */
const MAYBE_ACCEPTED =
	"No answer came back, so the page cannot tell whether the invitation was accepted. Before you try again, go to the sign-in page and sign in with what you chose here.";
const PASSKEY_RAN_OUT =
	'The passkey was made too long ago to be taken now. Press "Accept and sign in" to make it again.';

/**
 * Who this browser is signed in as, as far as the app has found out: somebody, nobody (`name` null), still
 * being asked, or not found out because the asking failed. The last two are not "nobody": the page may be
 * about to sign somebody out, and has not been able to ask about them.
 */
export type Holder = { kind: "known"; name: string | null } | { kind: "asking" } | { kind: "failed" };

/**
 * How long the page waits to be told who is signed in before it says that it could not find out and offers to
 * ask again. The answer is one small reply, which a slow connection brings in a second or two; twenty seconds
 * without it is a connection that stalled. The first asking is not given up: if its answer comes after all,
 * the page takes it.
 */
const LOOKUP_WAITS_MS = 20_000;

type Who = { state: "known"; name: string | null } | { state: "asking" } | { state: "unknown"; retry: () => void };

/** What the page knows of who is signed in, with a wait that ends and a way to ask again. */
function useWho(holder: Holder, askAgain: () => Promise<void>): Who {
	// The asking this page started itself with "Try again" and has no answer to yet. Each is an object of its
	// own, so that a new one starts a new wait and an old one that ends late does not end the new one's.
	const [again, setAgain] = useState<object | null>(null);
	const [overdue, setOverdue] = useState(false);
	const first = holder.kind === "asking";
	useEffect(() => {
		if (!first && again === null) return;
		const timer = setTimeout(() => setOverdue(true), LOOKUP_WAITS_MS);
		return () => clearTimeout(timer);
	}, [first, again]);
	if (holder.kind === "known") return { state: "known", name: holder.name };
	if ((first || again !== null) && !overdue) return { state: "asking" };
	return {
		state: "unknown",
		retry: () => {
			const mine = {};
			setOverdue(false);
			setAgain(mine);
			void askAgain().finally(() => setAgain((now) => (now === mine ? null : now)));
		},
	};
}

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
 * `holder` is who this browser is signed in as already, as far as the app knows, and `askAgain` asks the
 * server once more. `onDone` leaves the page for the app, as whoever the browser is signed in as by then.
 */
export function Invitation({
	holder,
	askAgain,
	onDone,
}: {
	holder: Holder;
	askAgain: () => Promise<void>;
	onDone: () => Promise<void>;
}) {
	const who = useWho(holder, askAgain);
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
				who={who}
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
	who,
	onDone,
	onGone,
	onShown,
}: {
	code: string;
	shown: ShownInvitation;
	askedAt: number;
	who: Who;
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
	// Who the server said holds this browser when it refused an acceptance, what was sent then, and when the
	// challenge was asked for that a passkey in it answers.
	const [refusedFor, setRefusedFor] = useState<{
		signedInAs: string;
		sent: Acceptance;
		challengeAt: number;
	} | null>(null);
	// The person the question was answered for with "Continue": the one whose session in this browser may end.
	// It is the only name an acceptance ever carries, and it is a name that was on the page when the answer
	// was given. The server reads who holds the browser when it accepts, and refuses if it is anybody else.
	const [confirmed, setConfirmed] = useState<string | null>(null);
	const passwordRef = useRef<HTMLInputElement>(null);
	const passkeyOffered = shown.passkey !== null && passkeysAvailable();
	// Not known who is signed in here, because the answer is on its way or did not come: the page may be about
	// to sign somebody out, and cannot ask about them. A refusal that named the holder is an answer too.
	const waiting = who.state !== "known" && refusedFor === null;
	const signedInAs = who.state === "known" ? who.name : null;
	const other = refusedFor?.signedInAs ?? (signedInAs && signedInAs !== name ? signedInAs : null);
	// Somebody else is signed in here, and the person has not said that this person's session may end. An
	// answer about one person is no answer about another.
	const asking = other !== null && confirmed !== other;
	const held = waiting || asking;
	useEffect(() => {
		// The fields are where typing starts: once the page knows who is signed in and has no question, and
		// again when a question is answered.
		if (!held) passwordRef.current?.focus();
	}, [held]);
	const said = (at: Problem["at"]): string => (problem?.at === at ? problem.message : "");

	/**
	 * Sends an acceptance. What comes back decides: the app, the question about whoever holds the browser, or a
	 * refusal. `challengeAt` is when the challenge of the passkey in it was asked for.
	 */
	async function send(acceptance: Acceptance, challengeAt: number): Promise<void> {
		try {
			await acceptInvitation(acceptance);
		} catch (error) {
			const holder = error instanceof ApiError && error.code === "conflict" ? error.details.signedInAs : null;
			if (typeof holder === "string") {
				// Nothing was changed and the invitation still works. The page asks about the person the server
				// named, and sends nothing until that question is answered. What was typed, and a passkey that
				// was made, are kept for then: a challenge is spent only by an acceptance that went through.
				setRefusedFor({ signedInAs: holder, sent: acceptance, challengeAt });
				return;
			}
			setProblem({ at: "form", message: error instanceof ApiError ? refusalOf(error, NOT_ACCEPTED) : MAYBE_ACCEPTED });
			return;
		}
		await onDone();
	}

	/** "Continue": the person on the page may be signed out of this browser. What waited for the answer goes now. */
	function answer(about: string): void {
		if (busy) return;
		setConfirmed(about);
		const refused = refusedFor;
		// Asked before anything was sent: the form is next, and its acceptance will carry the name.
		if (!refused || refused.signedInAs !== about) return;
		if (refused.sent.passkey && Date.now() > refused.challengeAt + CHALLENGE_LASTS_MS) {
			// The passkey's challenge ran out while the question stood. The form is open again to make another.
			setProblem({ at: "passkey", message: PASSKEY_RAN_OUT });
			return;
		}
		run(() => send({ ...refused.sent, replace: about }, refused.challengeAt), "form");
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
		let challengeAt = askedAt;
		if (wantPasskey) {
			let offered = shown.passkey;
			if (Date.now() - askedAt > CHALLENGE_FRESH_MS) {
				// Asked again with the same code: a passkey for an invitation is finished with the code it began with.
				const fresh = await showInvitation(code);
				if (!fresh) {
					onGone();
					return;
				}
				onShown(fresh);
				offered = fresh.passkey;
				challengeAt = Date.now();
			}
			if (!offered) throw new PasskeyError("This instance has no passkeys.");
			passkey = { made: await makePasskey(offered), label: label.trim() };
		}
		await send({ code, password: typed ? password : null, passkey, replace: confirmed }, challengeAt);
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
		if (held || busy) return;
		const wrong = unfit();
		if (wrong) setProblem(wrong);
		else run(accept, wantPasskey ? "passkey" : "form");
	};

	return (
		<div className="signin">
			<main className="signin-card">
				<h1>You are invited as {name}</h1>
				<p className="dim">This link works once, until {dateTime(expiresAt)}.</p>
				{purpose === "recover" && (
					<p>
						Accepting replaces every password and passkey, revokes all your tokens, and signs you out everywhere else.
					</p>
				)}
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
								aria-disabled={busy}
								onClick={() => answer(other)}
							>
								Continue as {name}
							</button>
							<button type="button" className="plain" aria-disabled={busy} onClick={() => run(onDone, "form")}>
								Stay signed in as {other}
							</button>
						</div>
					</div>
				)}
				{waiting && who.state === "asking" && (
					<p className="dim" role="status">
						Checking who is signed in to this browser…
					</p>
				)}
				{waiting && who.state === "unknown" && (
					<div className="signin-ask">
						<p role="status">
							The page could not find out whether somebody is signed in to this browser, so it cannot tell whether
							accepting would sign them out.
						</p>
						<div>
							<button type="button" onClick={who.retry}>
								Try again
							</button>
						</div>
					</div>
				)}
				<form onSubmit={submit}>
					<fieldset disabled={held}>
						{/* For a password manager: the name this password is saved under. */}
						<input type="text" name="username" autoComplete="username" value={name} readOnly hidden />
						<label htmlFor="invite-password">Password</label>
						<input
							id="invite-password"
							name="password"
							type="password"
							autoComplete="new-password"
							{...PASSWORD_RULES}
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
							{...PASSWORD_RULES}
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
						{/* Busy, it keeps the focus and takes no second press: `run` lets one request through. */}
						<button type="submit" aria-disabled={busy}>
							{busy ? "Accepting…" : "Accept and sign in"}
						</button>
					</fieldset>
				</form>
			</main>
		</div>
	);
}
