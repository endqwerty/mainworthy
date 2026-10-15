import { useState } from "react";
import type { SessionRow } from "../../core/people.ts";
import { ApiError } from "../lib/api.ts";
import { browserName } from "../lib/browser.ts";
import { endSession, listSessions, until } from "../lib/people.ts";
import { useApp } from "../ui/context.tsx";
import { age, DocLink } from "../ui/index.tsx";
import { saidBy, useList, withId } from "./list.ts";
import "./people.css";

/**
 * " from 203.0.113.7": the address a session was opened or last used from, as the server determined it. Nothing
 * where the server could not tell.
 */
const from = (address: string | null): string => (address === null ? "" : ` from ${address}`);

/** What proved who the person was when the session was opened, as a phrase after "opened with". */
function proof(row: SessionRow): string {
	switch (row.openedWith) {
		case "password":
			return "the password";
		case "passkey":
			return `the passkey ${row.label}`;
		case "token":
			return `a token (${row.label})`;
		default: {
			const _exhaustive: never = row.openedWith;
			return _exhaustive;
		}
	}
}

/**
 * The browsers the person is signed in on, each with a way to end it. Ending this browser's own session is
 * signing out here.
 */
export function YourSessions() {
	const { session, requestSignOut } = useApp();
	const sessions = useList("session", listSessions);
	const [ending, setEnding] = useState<ReadonlySet<number>>(new Set());
	const [refusal, setRefusal] = useState<{ id: number; message: string } | null>(null);
	const [message, setMessage] = useState("");

	function end(row: SessionRow): void {
		if (ending.has(row.id)) return;
		if (row.current) {
			requestSignOut();
			return;
		}
		setEnding((ids) => withId(ids, row.id, true));
		setRefusal(null);
		setMessage("");
		void endSession(row.id)
			.then(() => {
				setMessage("Session ended.");
				return sessions.refetch().then(() => {});
			})
			.catch((error: unknown) => {
				if (error instanceof ApiError && error.code === "not_found") {
					setMessage("That session has already ended.");
					void sessions.refetch();
				} else {
					setRefusal({ id: row.id, message: saidBy(error) });
					// With no reply the session may have ended all the same: the list says.
					void sessions.refetch();
				}
			})
			.finally(() => setEnding((ids) => withId(ids, row.id, false)));
	}

	return (
		<>
			<h2>Your sessions</h2>
			<p className="dim">
				Each browser {session.actor} is signed in on. A session ends by itself after a time without use.{" "}
				<DocLink page="access">Sessions and signing in</DocLink>
			</p>
			{sessions.error && <p role="status">{saidBy(sessions.error)}</p>}
			{sessions.data?.map((row) => (
				<div className="settings-row" key={row.id}>
					<span>
						<b>{browserName(row.userAgent)}</b>
						{row.current && <em className="settings-tag">this browser</em>}
						<small>
							opened with {proof(row)}
							{from(row.createdFrom)} · {age(row.createdAt)} · last used {age(row.lastUsedAt)}
							{from(row.lastUsedFrom)} · ends in {until(row.expiresAt)} at the latest
						</small>
						{/* What the browser called itself at sign-in, as the server recorded it. Nothing checked it. */}
						{row.userAgent && (
							<small className="settings-agent" title={row.userAgent}>
								{row.userAgent}
							</small>
						)}
						<small className="settings-refusal" role="status">
							{refusal?.id === row.id ? refusal.message : ""}
						</small>
					</span>
					<button
						className="out"
						type="button"
						aria-disabled={ending.has(row.id)}
						aria-label={`End the session of ${browserName(row.userAgent)}, opened ${age(row.createdAt)}${row.current ? ", this browser" : ""}`}
						onClick={() => end(row)}
					>
						{ending.has(row.id) ? "Ending…" : "End"}
					</button>
				</div>
			))}
			{sessions.data?.length === 0 && (
				<p className="dim">
					{session.via === "local"
						? "No browser is signed in. On this machine the owner needs no sign-in."
						: "No browser is signed in."}
				</p>
			)}
			<p className="settings-message" role="status">
				{message}
			</p>
		</>
	);
}
