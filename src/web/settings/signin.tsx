import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { CredentialRow } from "../../core/people-replies.ts";
import { ApiError } from "../lib/api.ts";
import { listCredentials, removeCredential } from "../lib/people.ts";
import { signInMethods, startOidc } from "../lib/signin.ts";
import { useApp } from "../ui/context.tsx";
import { age, DocLink, SectionHeading } from "../ui/index.tsx";
import { saidBy, useList, withId } from "./list.ts";
import { YourTokens } from "./personal-tokens.tsx";
import { useRecentProof } from "./recent-proof.tsx";
import "./people.css";

const ended = (count: number): string => (count === 0 ? "" : ` ${count} other session${count === 1 ? "" : "s"} ended.`);

/**
 * How the person signs in: the identities of the instance's identity provider linked to them, and their
 * tokens. Shown to a person only; an agent and a pipeline sign in with a token and nothing else.
 */
export function YourSignIn() {
	const { session, refreshSession } = useApp();
	const proof = useRecentProof();
	const credentials = useList("credential", listCredentials);
	// What the instance offers does not change while it runs.
	const methods = useQuery({ queryKey: ["instance", "sign-in-methods"], queryFn: signInMethods, staleTime: Infinity });
	const [removing, setRemoving] = useState<ReadonlySet<number>>(new Set());
	const [refusal, setRefusal] = useState<{ id: number; message: string } | null>(null);
	const [message, setMessage] = useState("");
	const rows = credentials.data ?? [];
	// The server keeps a person's last identity, whoever asks. The button says so before it is pressed.
	const onlyOne = rows.length === 1;
	const provider = methods.data?.oidc?.name ?? null;
	/** The list, and what the session says of it. A session that rested on what was removed ends here. */
	const changed = (): Promise<void> => Promise.all([credentials.refetch(), refreshSession()]).then(() => {});

	function remove(row: CredentialRow): void {
		if (removing.has(row.id)) return;
		setRemoving((ids) => withId(ids, row.id, true));
		setRefusal(null);
		setMessage("");
		void proof
			.run(() => removeCredential(row.id))
			.then(({ sessionsEnded }) => {
				setMessage(`${row.label} was removed.${ended(sessionsEnded)}`);
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
			{proof.prompt}
			<p className="dim">
				How {session.actor} signs in to this instance. <DocLink page="access">People, agents and pipelines</DocLink>
			</p>
			<SectionHeading>{provider ?? "Identities"}</SectionHeading>
			{methods.data && !provider && (
				<p className="dim">
					This instance has no identity provider. Whoever runs it sets one up for people to sign in.
				</p>
			)}
			{credentials.error && <p role="status">{saidBy(credentials.error)}</p>}
			{rows.map((row) => (
				<div className="settings-row" key={row.id}>
					<span>
						<b>{row.label}</b>
						<small>
							identity · added {age(row.createdAt)} ·{" "}
							{row.lastUsedAt === null ? "never used" : `last used ${age(row.lastUsedAt)}`}
						</small>
						<small className="settings-refusal" role="status">
							{refusal?.id === row.id ? refusal.message : ""}
						</small>
					</span>
					<button
						className="out"
						type="button"
						disabled={onlyOne}
						aria-disabled={removing.has(row.id)}
						aria-label={`Remove ${row.label}`}
						onClick={() => remove(row)}
					>
						{removing.has(row.id) ? "Removing…" : "Remove"}
					</button>
				</div>
			))}
			{credentials.data?.length === 0 && <p className="dim">No identity is linked yet. You sign in with a token.</p>}
			{onlyOne && <p className="dim">Your only identity stays. Link another before you remove this one.</p>}
			<p className="settings-message" role="status">
				{message}
			</p>
			{provider && credentials.data && (
				<ProviderLink provider={provider} first={rows.length === 0} browser={session.via === "cookie"} />
			)}
			<YourTokens />
		</>
	);
}

/**
 * Linking an identity of the instance's identity provider to the person signed in here: the browser goes to the
 * provider and comes back to this section. Once linked, the person can sign in with it; it is listed above.
 */
function ProviderLink({ provider, first, browser }: { provider: string; first: boolean; browser: boolean }) {
	const [busy, setBusy] = useState(false);
	const proof = useRecentProof();
	const [problem, setProblem] = useState("");
	if (!browser) return <p className="dim">An identity is linked from a browser that signed in.</p>;
	return (
		<div>
			{proof.prompt}
			<button
				className="out"
				type="button"
				aria-disabled={busy}
				onClick={() => {
					if (busy) return;
					setBusy(true);
					setProblem("");
					void proof
						.run(() => startOidc({ link: true }, "Your sign-in"))
						.catch((error: unknown) => setProblem(saidBy(error)))
						.finally(() => setBusy(false));
				}}
			>
				{busy ? `Opening ${provider}…` : first ? `Link ${provider}` : `Link another ${provider} identity`}
			</button>
			<p className="settings-problem" role="status">
				{problem}
			</p>
		</div>
	);
}
