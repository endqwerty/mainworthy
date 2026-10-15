import { type FormEvent, useRef, useState } from "react";
import { PERSONAL_TOKEN_LASTS, type PersonalTokenCreated, type PersonalTokenRow } from "../../core/people.ts";
import { copySecret } from "../lib/clipboard.ts";
import { createPersonalToken, dateTime, listPersonalTokens, listSessions, revokePersonalToken } from "../lib/people.ts";
import { useApp } from "../ui/context.tsx";
import { age, SectionHeading } from "../ui/index.tsx";
import { saidBy, saidOfWrite, useList, withId } from "./list.ts";

export function YourTokens() {
	const { session } = useApp();
	const tokens = useList("personal-token", listPersonalTokens);
	const sessions = useList("session", listSessions);
	const mayCreate = session.via === "local" || sessions.data?.some((row) => row.current && row.openedWith !== "token");
	const [label, setLabel] = useState("");
	const [expires, setExpires] = useState<string>(PERSONAL_TOKEN_LASTS.default);
	const [created, setCreated] = useState<PersonalTokenCreated | null>(null);
	const [busy, setBusy] = useState(false);
	const [revoking, setRevoking] = useState<ReadonlySet<number>>(new Set());
	const [message, setMessage] = useState("");
	const field = useRef<HTMLInputElement>(null);

	function create(event: FormEvent): void {
		event.preventDefault();
		if (busy || created || !mayCreate || !label.trim()) return;
		setBusy(true);
		setMessage("");
		void createPersonalToken(label, expires)
			.then((made) => {
				setCreated(made);
				setLabel("");
				return tokens.refetch();
			})
			.catch((error: unknown) => {
				setMessage(
					saidOfWrite(
						error,
						"No answer came back. If the token was created, its secret is lost. Check the list, revoke that token and make another.",
					),
				);
				void tokens.refetch();
			})
			.finally(() => setBusy(false));
	}

	function revoke(row: PersonalTokenRow): void {
		if (revoking.has(row.id)) return;
		setRevoking((ids) => withId(ids, row.id, true));
		setMessage("");
		void revokePersonalToken(row.id)
			.then(() => {
				setCreated((made) => (made?.id === row.id ? null : made));
				setMessage(`${row.label || `Token ${row.id}`} was revoked.`);
				return tokens.refetch();
			})
			.catch((error: unknown) => {
				setMessage(
					saidOfWrite(
						error,
						"No answer came back, so the page cannot tell whether the token was revoked. Check the list.",
					),
				);
				void tokens.refetch();
			})
			.finally(() => setRevoking((ids) => withId(ids, row.id, false)));
	}

	return (
		<>
			<SectionHeading>Your command-line tokens</SectionHeading>
			<p className="dim">
				A token acts as you on every project you can access, with your current grants. Removing a grant takes it away
				from your tokens too. Password changes do not revoke tokens.
			</p>
			{mayCreate ? (
				<form className="settings-form" onSubmit={create}>
					<label htmlFor="personal-token-label">Token label</label>
					<input
						className="form-input"
						id="personal-token-label"
						value={label}
						maxLength={60}
						required
						onChange={(event) => setLabel(event.target.value)}
					/>
					<label htmlFor="personal-token-expires">Token lifetime</label>
					<select
						className="form-input"
						id="personal-token-expires"
						value={expires}
						onChange={(event) => setExpires(event.target.value)}
					>
						<option value="1d">1 day</option>
						<option value="7d">7 days</option>
						<option value="30d">30 days</option>
						<option value="90d">90 days</option>
						<option value="365d">1 year</option>
					</select>
					<button className="out" type="submit" disabled={busy || created !== null}>
						{busy ? "Creating…" : "Create personal token"}
					</button>
				</form>
			) : (
				<p className="dim">To create a personal token, sign in with your password or a passkey.</p>
			)}
			{sessions.error && <p role="status">{saidBy(sessions.error)}</p>}
			{created && (
				<div className="settings-secret">
					<b>This token is shown once. Store it now. It expires {dateTime(created.expiresAt)}.</b>
					<p>
						Set MAINWORTHY_URL to this instance's address and MAINWORTHY_TOKEN to this token in your shell or script's
						secret store.
					</p>
					<input
						className="form-input"
						type="password"
						readOnly
						value={created.token}
						aria-label="Your new command-line token"
						ref={field}
					/>
					<button
						type="button"
						className="out"
						onClick={() =>
							void copySecret(field.current, created.token).then((done) =>
								setMessage(done ? "Token copied." : "Copy failed. Try again."),
							)
						}
					>
						Copy personal token
					</button>
					<button type="button" className="dim" onClick={() => setCreated(null)}>
						Dismiss personal token
					</button>
				</div>
			)}
			{tokens.error && <p role="status">{saidBy(tokens.error)}</p>}
			{tokens.data?.map((row) => (
				<div className="settings-row settings-personal-token" key={row.id}>
					<span>
						<b>{row.label || `Token ${row.id}`}</b>
						<small>
							Token {row.id} · created {age(row.createdAt)} ·{" "}
							{row.lastUsedAt === null ? "never used" : `last used ${age(row.lastUsedAt)}`} ·{" "}
							{row.revoked
								? "Revoked"
								: row.expired
									? "Expired"
									: row.expiresAt === null
										? "no expiry"
										: `expires ${dateTime(row.expiresAt)}`}
						</small>
					</span>
					{!row.revoked && !row.expired && (
						<button
							type="button"
							className="out"
							disabled={revoking.has(row.id)}
							aria-label={`Revoke personal token ${row.label || row.id}`}
							onClick={() => revoke(row)}
						>
							Revoke
						</button>
					)}
				</div>
			))}
			{tokens.data?.length === 0 && <p className="dim">You have no command-line tokens.</p>}
			<p role="status" className="settings-message">
				{message}
			</p>
		</>
	);
}
