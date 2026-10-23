import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type RefObject, useRef, useState } from "react";
import { type CredentialRow, whyNotPassword } from "../../core/people-replies.ts";
import { ApiError, UnreadableReply } from "../lib/api.ts";
import { browserName } from "../lib/browser.ts";
import { makePasskey, PasskeyError, passkeysAvailable } from "../lib/passkey.ts";
import { addPasskey, beginPasskey, listCredentials, removeCredential } from "../lib/people.ts";
import { NO_ANSWER, setPassword, signInMethods, startOidc } from "../lib/signin.ts";
import { useApp } from "../ui/context.tsx";
import { age, DocLink, PASSWORD_RULES, PasswordCount, SectionHeading } from "../ui/index.tsx";
import { Authenticator } from "./authenticator.tsx";
import { EmailForm } from "./email.tsx";
import { saidBy, saidOfWrite, useList, withId } from "./list.ts";
import { YourTokens } from "./personal-tokens.tsx";
import "./people.css";

const ended = (count: number): string => (count === 0 ? "" : ` ${count} other session${count === 1 ? "" : "s"} ended.`);

/**
 * How the person signs in: their password and their passkeys. Shown to a person only; an agent and a pipeline
 * sign in with a token and nothing else.
 */
export function YourSignIn({ passwordRef }: { passwordRef: RefObject<HTMLInputElement | null> }) {
	const { session, refreshSession } = useApp();
	const credentials = useList("credential", listCredentials);
	// What the instance offers does not change while it runs.
	const methods = useQuery({ queryKey: ["instance", "sign-in-methods"], queryFn: signInMethods, staleTime: Infinity });
	const [removing, setRemoving] = useState<ReadonlySet<number>>(new Set());
	const [refusal, setRefusal] = useState<{ id: number; message: string } | null>(null);
	const [message, setMessage] = useState("");
	const rows = credentials.data ?? [];
	// The server keeps a person's last way of signing in, whoever asks. The button says so before it is pressed.
	const onlyOne = rows.filter((row) => row.kind !== "totp").length === 1;
	/** The list, and what the session says of it. A session that rested on what was removed ends here. */
	const changed = (): Promise<void> => Promise.all([credentials.refetch(), refreshSession()]).then(() => {});

	function remove(row: CredentialRow): void {
		if (removing.has(row.id)) return;
		setRemoving((ids) => withId(ids, row.id, true));
		setRefusal(null);
		setMessage("");
		void removeCredential(row.id)
			.then(({ sessionsEnded }) => {
				setMessage(`${row.kind === "password" ? "The password" : row.label} was removed.${ended(sessionsEnded)}`);
				return changed();
			})
			.catch((error: unknown) => {
				// Removed already, from another browser: the list is read again and shows it gone.
				if (error instanceof ApiError && error.code === "not_found") void credentials.refetch();
				else {
					setRefusal({ id: row.id, message: saidBy(error) });
					// With no reply it may have been removed all the same: the list says.
					void credentials.refetch();
				}
			})
			.finally(() => setRemoving((ids) => withId(ids, row.id, false)));
	}

	return (
		<>
			<h2>Your sign-in</h2>
			<p className="dim">
				How {session.actor} signs in to this instance. <DocLink page="access">Passwords and passkeys</DocLink>
			</p>
			{session.via === "cookie" && <EmailForm />}
			<SectionHeading>Password</SectionHeading>
			{session.via === "cookie" ? (
				<PasswordForm
					person={session.actor}
					has={session.credentials?.password ?? false}
					nextRef={passwordRef}
					onChanged={changed}
				/>
			) : (
				<p className="dim">
					A password is set from a browser that signed in. On this machine the owner needs no sign-in.
				</p>
			)}
			<SectionHeading>Passkeys</SectionHeading>
			{methods.data && !methods.data.passkey && (
				<p className="dim">
					This instance has no passkeys. Whoever runs it gives it a public address (MAINWORTHY_PUBLIC_URL) to offer
					them.
				</p>
			)}
			{methods.data?.passkey && !passkeysAvailable() && <p className="dim">This browser has no passkeys.</p>}
			{methods.data?.passkey && passkeysAvailable() && <PasskeyForm onAdded={changed} />}
			{methods.data?.oidc && (
				<>
					<SectionHeading>{methods.data.oidc.name}</SectionHeading>
					<ProviderLink
						provider={methods.data.oidc.name}
						linked={rows.some((row) => row.kind === "oidc")}
						browser={session.via === "cookie"}
					/>
				</>
			)}
			<SectionHeading>Authenticator</SectionHeading>
			<Authenticator enrolled={rows.some((row) => row.kind === "totp")} onChanged={changed} />
			<SectionHeading>Ways you sign in</SectionHeading>
			{credentials.error && <p role="status">{saidBy(credentials.error)}</p>}
			{rows.map((row) => {
				const title = row.kind === "password" ? "Password" : row.label;
				return (
					<div className="settings-row" key={row.id}>
						<span>
							<b>{title}</b>
							<small>
								{row.kind === "passkey" && "passkey · "}
								{row.kind === "oidc" && "identity provider · "}added {age(row.createdAt)} ·{" "}
								{row.lastUsedAt === null ? "never used" : `last used ${age(row.lastUsedAt)}`}
							</small>
							<small className="settings-refusal" role="status">
								{refusal?.id === row.id ? refusal.message : ""}
							</small>
						</span>
						<button
							className="out"
							type="button"
							disabled={onlyOne && row.kind !== "totp"}
							aria-disabled={removing.has(row.id)}
							aria-label={`Remove ${row.kind === "password" ? "the password" : row.label}`}
							onClick={() => remove(row)}
						>
							{removing.has(row.id) ? "Removing…" : "Remove"}
						</button>
					</div>
				);
			})}
			{credentials.data?.length === 0 && (
				<p className="dim">No password and no passkey yet. You sign in with a token.</p>
			)}
			{onlyOne && <p className="dim">The only way you sign in stays. Add another way before you remove this one.</p>}
			<p className="settings-message" role="status">
				{message}
			</p>
			<YourTokens />
		</>
	);
}

/**
 * Linking the instance's identity provider to the person signed in here: the browser goes to the provider and
 * comes back to this page. Once linked, the person can sign in through it; it is listed with the other ways in.
 */
function ProviderLink({ provider, linked, browser }: { provider: string; linked: boolean; browser: boolean }) {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState("");
	if (!browser) return <p className="dim">The provider is linked from a browser that signed in.</p>;
	if (linked) return <p className="dim">You can sign in through {provider}. It is listed below.</p>;
	return (
		<div>
			<p>Sign in through {provider} as well.</p>
			<button
				className="out"
				type="button"
				aria-disabled={busy}
				onClick={() => {
					if (busy) return;
					setBusy(true);
					setProblem("");
					void startOidc({ link: true }, "Your sign-in")
						.catch((error: unknown) => setProblem(saidBy(error)))
						.finally(() => setBusy(false));
				}}
			>
				{busy ? `Opening ${provider}…` : `Link ${provider}`}
			</button>
			<p className="settings-problem" role="status">
				{problem}
			</p>
		</div>
	);
}

type Field = "current" | "next" | "again" | "form";

function PasswordForm({
	person,
	has,
	nextRef,
	onChanged,
}: {
	person: string;
	/** Whether the person has a password now: then it is changed, and the current one is asked for. */
	has: boolean;
	/** The field for the new password, which the section's key goes to. */
	nextRef: RefObject<HTMLInputElement | null>;
	onChanged: () => Promise<void>;
}) {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [again, setAgain] = useState("");
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<{ at: Field; message: string } | null>(null);
	const [message, setMessage] = useState("");
	const said = (at: Field): string => (problem?.at === at ? problem.message : "");
	// How many times a password was set here. The fields are made again each time (`key`), because the page
	// empties them itself: a password manager that filled them marks them as filled, takes the mark away only
	// when the person types, and paints the field by it. 1Password left both fields blue.
	const [round, setRound] = useState(0);
	const buttonRef = useRef<HTMLButtonElement | null>(null);

	/** Where a refusal belongs and what it says. The server names the field a message is about before a colon. */
	function refused(error: unknown): { at: Field; message: string } {
		// The request may have arrived though no reply did, or may never have left. The page knows neither,
		// and a refusal of the current password on the next try proves nothing: it may simply be mistyped.
		if (!(error instanceof ApiError))
			return {
				at: "form",
				message:
					"No readable answer came back, so the page cannot tell whether the password was changed. It may or may not have been: sign in with the new password to find out. The list below is read again.",
			};
		if (error.code === "forbidden") return { at: "current", message: "The current password is not right." };
		// Wrong too often. The wait is all that is said, and the right password is refused too until it is over.
		if (error.code === "limited") return { at: has ? "current" : "form", message: error.message };
		if (error.code === "invalid" && error.message.startsWith("current:"))
			return { at: "current", message: error.message };
		if (error.code === "invalid" && error.message.startsWith("next:")) return { at: "next", message: error.message };
		return { at: "form", message: error.message };
	}

	/** What is wrong with the form as it stands, checked in the page before anything is sent. */
	function unfit(): { at: Field; message: string } | null {
		if (has && !current) return { at: "current", message: "Type the password you have now." };
		const why = whyNotPassword(next);
		if (why) return { at: "next", message: why };
		return next === again ? null : { at: "again", message: "The two passwords differ." };
	}

	function submit(event: FormEvent): void {
		event.preventDefault();
		if (busy) return;
		setMessage("");
		const wrong = unfit();
		setProblem(wrong);
		if (wrong) return;
		setBusy(true);
		void setPassword({ current: has ? current : null, next })
			.then(({ sessionsEnded }) => {
				// A password is not left in a field once it is the password.
				setCurrent("");
				setNext("");
				setAgain("");
				// A caret in a field that is about to go moves to the button, which stays and says what was done.
				// In the new field a manager would offer to fill a password again.
				const button = buttonRef.current;
				if (document.activeElement instanceof HTMLInputElement && document.activeElement.form === button?.form)
					button?.focus();
				setRound((count) => count + 1);
				setMessage(has ? `Password changed.${ended(sessionsEnded)}` : "Password set.");
				return onChanged();
			})
			.catch((error: unknown) => {
				setProblem(refused(error));
				// With no reply the password may have changed: the list and the session are read again.
				if (!(error instanceof ApiError)) void onChanged();
			})
			.finally(() => setBusy(false));
	}

	return (
		<form className="settings-form" onSubmit={submit}>
			{/* For a password manager: the name this password is saved under. */}
			<input type="text" name="username" autoComplete="username" value={person} readOnly hidden />
			{has && (
				<>
					<label htmlFor="password-current">Current password</label>
					<input
						key={`current-${round}`}
						className="form-input"
						id="password-current"
						name="current-password"
						type="password"
						autoComplete="current-password"
						value={current}
						onChange={(event) => setCurrent(event.target.value)}
					/>
					<p className="settings-problem" role="status">
						{said("current")}
					</p>
				</>
			)}
			<label htmlFor="password-next">New password</label>
			<input
				key={`next-${round}`}
				className="form-input"
				id="password-next"
				name="new-password"
				ref={nextRef}
				type="password"
				autoComplete="new-password"
				{...PASSWORD_RULES}
				aria-describedby="password-count"
				value={next}
				onChange={(event) => setNext(event.target.value)}
			/>
			<PasswordCount id="password-count" className="settings-count" text={next} />
			<p className="settings-problem" role="status">
				{said("next")}
			</p>
			<label htmlFor="password-again">New password again</label>
			<input
				key={`again-${round}`}
				className="form-input"
				id="password-again"
				name="new-password-again"
				type="password"
				autoComplete="new-password"
				{...PASSWORD_RULES}
				value={again}
				onChange={(event) => setAgain(event.target.value)}
			/>
			<p className="settings-problem" role="status">
				{said("again")}
			</p>
			<p className="settings-problem" role="status">
				{said("form")}
			</p>
			{/* Busy, it keeps the focus and takes no second press: `submit` lets one request through. */}
			<button className="out" type="submit" ref={buttonRef} aria-disabled={busy}>
				{busy ? "Saving…" : has ? "Change password" : "Set password"}
			</button>
			<p className="settings-message" role="status">
				{message}
			</p>
		</form>
	);
}

function PasskeyForm({ onAdded }: { onAdded: () => Promise<void> }) {
	const named = (): string => browserName(navigator.userAgent);
	const [label, setLabel] = useState(named);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState("");
	const [message, setMessage] = useState("");

	function refused(error: unknown): string {
		if (error instanceof PasskeyError || error instanceof UnreadableReply) return error.message;
		if (!(error instanceof ApiError)) return NO_ANSWER;
		// One credential is registered once on the instance. The browser usually says so first.
		if (error.code === "conflict") return "This passkey is already registered.";
		if (error.code === "invalid" && error.message.includes("was not accepted"))
			return "That passkey was not accepted. Try again.";
		return error.message;
	}

	function submit(event: FormEvent): void {
		event.preventDefault();
		if (busy) return;
		const name = label.trim();
		setMessage("");
		setProblem(name ? "" : "Give the passkey a name, such as the device it is on.");
		if (!name) return;
		setBusy(true);
		// The challenge is asked for at each press: it is good for five minutes and for one registration.
		let adding = false;
		void beginPasskey()
			.then(makePasskey)
			.then((made) => {
				adding = true;
				return addPasskey({ made, label: name });
			})
			.then(() => {
				setMessage(`${name} was added.`);
				setLabel(named());
				return onAdded();
			})
			.catch((error: unknown) => {
				if (adding && !(error instanceof ApiError)) {
					setProblem(
						saidOfWrite(
							error,
							"The page cannot tell whether the passkey was added. The credential list is read again; check it before adding another passkey.",
						),
					);
					return onAdded();
				}
				setProblem(refused(error));
			})
			.finally(() => setBusy(false));
	}

	return (
		<form className="settings-form" onSubmit={submit}>
			<label htmlFor="passkey-label">Passkey name</label>
			<input
				className="form-input"
				id="passkey-label"
				maxLength={60}
				value={label}
				onChange={(event) => setLabel(event.target.value)}
			/>
			<p className="settings-problem" role="status">
				{problem}
			</p>
			<button className="out" type="submit" aria-disabled={busy}>
				{busy ? "Waiting for the passkey…" : "Add a passkey"}
			</button>
			<p className="settings-message" role="status">
				{message}
			</p>
		</form>
	);
}
