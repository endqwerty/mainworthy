import { useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api.ts";
import { dateTime } from "../lib/people.ts";
import { NO_ANSWER, refusalOf, type ShownInvitation, showInvitation, signInMethods, startOidc } from "../lib/signin.ts";
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

const GONE = "This invitation does not work any more. Ask whoever sent it for a new one.";
const NOT_ACCEPTED =
	"That did not work. The invitation may have been used or have run out. Open the link again to check.";

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
	/** `provider` is the instance's identity provider, by its name; null on an instance with none. */
	| { kind: "shown"; shown: ShownInvitation; provider: string | null };

/**
 * The page an invitation link opens. It renders with nobody signed in and changes nothing by being opened: it
 * asks the server who the invitation is for, and the person then accepts it by signing in through the
 * instance's identity provider, which links that identity to them and signs them in.
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
		void Promise.all([showInvitation(asked.code), signInMethods()]).then(
			([shown, methods]) => {
				if (current)
					setStage(shown ? { kind: "shown", shown, provider: methods.oidc?.name ?? null } : { kind: "gone" });
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
				// A question answered belongs to one invitation: another link starts without it.
				key={code}
				code={code}
				shown={stage.shown}
				provider={stage.provider}
				who={who}
				onDone={onDone}
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

function Accept({
	code,
	shown,
	provider,
	who,
	onDone,
}: {
	code: string;
	shown: ShownInvitation;
	provider: string | null;
	who: Who;
	onDone: () => Promise<void>;
}) {
	const { name, purpose, expiresAt } = shown.invitation;
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState("");
	// Who the server said holds this browser when it refused to begin an acceptance.
	const [refusedFor, setRefusedFor] = useState<string | null>(null);
	// The person the question was answered for with "Continue": the one whose session in this browser may end.
	// It is the only name an acceptance ever carries, and it is a name that was on the page when the answer
	// was given. The server reads who holds the browser when it accepts, and refuses if it is anybody else.
	const [confirmed, setConfirmed] = useState<string | null>(null);
	// Not known who is signed in here, because the answer is on its way or did not come: the page may be about
	// to sign somebody out, and cannot ask about them. A refusal that named the holder is an answer too.
	const waiting = who.state !== "known" && refusedFor === null;
	const signedInAs = who.state === "known" ? who.name : null;
	const other = refusedFor ?? (signedInAs && signedInAs !== name ? signedInAs : null);
	// Somebody else is signed in here, and the person has not said that this person's session may end. An
	// answer about one person is no answer about another.
	const asking = other !== null && confirmed !== other;
	const held = waiting || asking;
	const acceptRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		// The button is where the keys go: once the page knows who is signed in and has no question, and again
		// when a question is answered.
		if (!held) acceptRef.current?.focus();
	}, [held]);

	/** One request at a time, and whatever fails is said on the page. */
	function run(work: () => Promise<void>): void {
		if (busy) return;
		setBusy(true);
		setProblem("");
		void work()
			.catch((error: unknown) => setProblem(refusalOf(error, NOT_ACCEPTED)))
			.finally(() => setBusy(false));
	}

	/**
	 * Sends the browser to the provider to accept, naming `replace` as the person who may be signed out here.
	 * A refusal that names who holds the browser changes nothing: the page asks about them first.
	 */
	const accept = (replace: string | null): Promise<void> =>
		startOidc({ invitation: code, ...(replace === null ? {} : { replace }) }).catch((error: unknown) => {
			const holder = error instanceof ApiError && error.code === "conflict" ? error.details.signedInAs : null;
			if (typeof holder !== "string") throw error;
			setRefusedFor(holder);
		});

	/** "Continue": the person on the page may be signed out of this browser. An acceptance that waited goes now. */
	function answer(about: string): void {
		if (busy) return;
		setConfirmed(about);
		if (refusedFor === about) run(() => accept(about));
	}

	return (
		<div className="signin">
			<main className="signin-card">
				<h1>You are invited as {name}</h1>
				<p className="dim">This link works once, until {dateTime(expiresAt)}.</p>
				{purpose === "recover" && (
					<p>
						Accepting replaces the identities you sign in with, revokes all your tokens, and signs you out everywhere
						else.
					</p>
				)}
				{provider === null ? (
					<p role="status">
						This instance has no identity provider, so an invitation cannot be accepted here. Ask whoever runs it.
					</p>
				) : (
					<>
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
									<button type="button" className="plain" aria-disabled={busy} onClick={() => run(onDone)}>
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
						<p>Accept by signing in with {provider}. That identity is the one you sign in with from then on.</p>
						{/* Busy, it keeps the focus and takes no second press: `run` lets one request through. */}
						<button
							ref={acceptRef}
							type="button"
							disabled={held}
							aria-disabled={busy}
							onClick={() => {
								if (!held) run(() => accept(confirmed));
							}}
						>
							{busy ? `Opening ${provider}…` : `Accept with ${provider}`}
						</button>
						<div className="signin-problem" role="status">
							{problem}
						</div>
					</>
				)}
			</main>
		</div>
	);
}
