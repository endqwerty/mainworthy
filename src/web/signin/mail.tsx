import { type FormEvent, useEffect, useRef, useState } from "react";
import { PASSWORD_LENGTH, whyNotPassword } from "../../core/people-replies.ts";
import { refusalOf, requestReset, resetPassword, signInMethods, verifyEmail } from "../lib/signin.ts";
import "./signin.css";

export function MailEntry({ onDone }: { onDone: () => Promise<void> }) {
	const [code, setCode] = useState(() => location.hash.slice(1));
	const [verifying] = useState(() => location.pathname === "/email");
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [done, setDone] = useState(false);
	const generation = useRef(0);
	useEffect(() => {
		if (location.hash) history.replaceState(null, "", location.pathname);
		const changed = () => {
			generation.current++;
			setBusy(false);
			setCode(location.hash.slice(1));
			setDone(false);
			setMessage("");
			setPassword("");
			history.replaceState(null, "", location.pathname);
		};
		window.addEventListener("hashchange", changed);
		let active = true;
		void signInMethods()
			.then((methods) => {
				if (active) setEnabled(methods.mail);
			})
			.catch(() => {
				if (active) setMessage("Mainworthy did not answer. Reload to try again.");
			});
		return () => {
			generation.current++;
			active = false;
			window.removeEventListener("hashchange", changed);
		};
	}, []);
	function submit(event: FormEvent): void {
		event.preventDefault();
		if (busy || !enabled || done) return;
		const why = code && !verifying ? whyNotPassword(password) : null;
		if (why) {
			setMessage(why);
			return;
		}
		setBusy(true);
		const attempt = ++generation.current;
		setMessage("");
		const request = verifying ? verifyEmail(code) : code ? resetPassword(code, password) : requestReset(email);
		void request
			.then(() => {
				if (generation.current !== attempt) return;
				setDone(true);
				setPassword("");
				setMessage(
					verifying
						? "Your email address is verified."
						: code
							? "Your password was reset and your existing sessions ended. Sign in with your new password and your authenticator if enrolled."
							: "If this address is verified for an account, a reset link will arrive. Check your inbox.",
				);
			})
			.catch((error: unknown) => {
				if (generation.current === attempt) setMessage(refusalOf(error, "This link does not work. Request another."));
			})
			.finally(() => {
				if (generation.current === attempt) setBusy(false);
			});
	}
	return (
		<div className="signin">
			<main className="signin-card">
				<h1>{verifying ? "Verify your email" : code ? "Choose a new password" : "Reset your password"}</h1>
				{enabled === false && <p>Mail is off on this instance. Ask an admin for a recovery link.</p>}
				{enabled && !done && (
					<form onSubmit={submit}>
						{verifying ? (
							<p>Confirm that you want to use this address for password reset and sign-in notices.</p>
						) : code ? (
							<>
								<label htmlFor="reset-password">New password</label>
								<input
									className="form-input"
									id="reset-password"
									type="password"
									autoComplete="new-password"
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									required
								/>
								<p className="dim">
									Use {PASSWORD_LENGTH.min} to {PASSWORD_LENGTH.max} characters. If you use an authenticator, it stays
									enrolled.
								</p>
							</>
						) : (
							<>
								<p>Enter the verified email address for your account.</p>
								<label htmlFor="reset-email">Email address</label>
								<input
									className="form-input"
									id="reset-email"
									type="email"
									autoComplete="email"
									value={email}
									onChange={(event) => setEmail(event.target.value)}
									required
									maxLength={254}
								/>
							</>
						)}
						<button className="btn btn-primary" type="submit" aria-disabled={busy}>
							{busy ? "Sending…" : verifying ? "Verify email" : code ? "Reset password" : "Send reset link"}
						</button>
					</form>
				)}
				<p role="status">{message}</p>
				<button type="button" className="btn" onClick={() => void onDone()}>
					Back to sign-in
				</button>
			</main>
		</div>
	);
}
