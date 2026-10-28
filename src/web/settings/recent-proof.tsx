import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api.ts";
import { listSessions } from "../lib/people.ts";
import { signInMethods, startOidc } from "../lib/signin.ts";
import { useApp } from "../ui/context.tsx";
import { saidBy } from "./list.ts";

/**
 * The section of Settings this page shows, as Settings keeps it in the page's history entry: a confirmation
 * comes back to it from the identity provider.
 */
const shownSection = (): string | null => {
	const section = (history.state as { settingsSection?: unknown } | null)?.settingsSection;
	return typeof section === "string" ? section : null;
};

/**
 * Runs a change to how somebody signs in, or one that the server guards the same way. When the server answers
 * that this session must confirm it is the person first, the refused change waits in this component while the
 * prompt says how: through the identity provider, which brings the page back here to repeat the change, or by
 * signing in with the token again. Cancelling refuses the change with nothing changed.
 */
export function useRecentProof() {
	const { project, session } = useApp();
	const pending = useRef<(() => void) | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState("");
	const confirm = useRef<HTMLButtonElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	const identities = session.credentials?.identities ?? 0;
	// What the instance offers does not change while it runs.
	const methods = useQuery({
		queryKey: ["instance", "sign-in-methods"],
		queryFn: signInMethods,
		staleTime: Infinity,
		enabled: open && identities > 0,
	});
	// A session opened with a token may confirm with the token as well as through the provider.
	const sessions = useQuery({
		queryKey: [project, "session", { do: "list" }],
		queryFn: ({ signal }) => listSessions({ signal }),
		enabled: open && identities > 0,
		staleTime: 0,
	});
	const provider = identities > 0 ? (methods.data?.oidc?.name ?? null) : null;
	const byToken = identities === 0 || sessions.data?.some((row) => row.current && row.openedWith === "token");
	const guidance =
		identities === 0
			? "token"
			: methods.isPending
				? "loading"
				: methods.isError
					? "error"
					: provider
						? "provider"
						: "token";
	useEffect(() => () => pending.current?.(), []);
	useEffect(() => {
		if (!open || guidance === "loading") return;
		(guidance === "provider" ? confirm : cancel).current?.focus();
	}, [open, guidance]);
	function finish() {
		setOpen(false);
		pending.current?.();
		pending.current = null;
	}
	async function run<T>(work: () => Promise<T>): Promise<T> {
		try {
			return await work();
		} catch (error) {
			if (!(error instanceof ApiError) || error.code !== "recent_proof_required") throw error;
			pending.current?.();
			setProblem("");
			setOpen(true);
			// Confirming leaves the page for the provider; only cancelling, or leaving the screen, ends the wait.
			await new Promise<void>((resolve) => {
				pending.current = resolve;
			});
			throw new ApiError("recent_proof_required", "Confirmation cancelled. Nothing was changed.");
		}
	}
	function prove() {
		if (busy) return;
		setBusy(true);
		setProblem("");
		startOidc({ proof: true }, shownSection())
			.catch((error: unknown) => setProblem(saidBy(error)))
			.finally(() => setBusy(false));
	}
	const prompt = open && (
		<section className="settings-proof" aria-label="Confirm it is you">
			<h3>Confirm it is you</h3>
			{guidance === "loading" ? (
				<p role="status">Reading how this instance confirms it is you…</p>
			) : guidance === "error" ? (
				<p role="status">{saidBy(methods.error)} Cancel confirmation and repeat the change to try again.</p>
			) : (
				<>
					<p>
						{guidance === "provider"
							? `Sign in with ${provider} again to confirm it is you. This page then opens again here: repeat the change. The confirmation lasts ten minutes in this session.`
							: "Sign out, and sign in with your token again, to confirm it is you. Then repeat the change. The confirmation lasts ten minutes in this session."}
					</p>
					{guidance === "provider" && byToken && (
						<p className="dim">You opened this session with a token: signing in with it again confirms too.</p>
					)}
					{guidance === "provider" && (
						<button ref={confirm} className="out" type="button" aria-disabled={busy} onClick={prove}>
							{busy ? `Opening ${provider}…` : `Confirm with ${provider}`}
						</button>
					)}
				</>
			)}
			<button ref={cancel} className="out" type="button" disabled={busy} onClick={finish}>
				Cancel confirmation
			</button>
			<p role="status">{problem}</p>
		</section>
	);
	return { run, prompt };
}
