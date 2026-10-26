import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { ApiError, exchange } from "../lib/api.ts";
import { authenticationGeneration, authenticationUnchanged } from "../lib/device.ts";
import { presentPasskey, RequestOptions } from "../lib/passkey.ts";
import { listCredentials } from "../lib/people.ts";
import { routeUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { saidBy } from "./list.ts";

/** Keeps the refused action in this component until this session proves a credential or cancels. */
export function useRecentProof() {
	const { project } = useApp();
	const pending = useRef<((accepted: boolean) => void) | null>(null);
	const [open, setOpen] = useState(false);
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState("");
	const field = useRef<HTMLInputElement>(null);
	const setupLink = useRef<HTMLAnchorElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	const passkeyButton = useRef<HTMLButtonElement>(null);
	const credentials = useQuery({
		queryKey: [project, "credential", { do: "list" }],
		queryFn: ({ signal }) => listCredentials({ signal }),
		enabled: open,
		staleTime: 0,
	});
	const rows = credentials.data ?? [];
	const hasPassword = rows.some((row) => row.kind === "password");
	const hasTotp = rows.some((row) => row.kind === "totp");
	const hasPasskey = rows.some((row) => row.kind === "passkey");
	const guidance = credentials.isPending
		? "loading"
		: credentials.isError && credentials.data === undefined
			? "error"
			: rows.length === 0
				? "first"
				: rows.every((row) => row.kind === "oidc")
					? "recovery"
					: "proof";
	useEffect(() => () => pending.current?.(false), []);
	useEffect(() => {
		if (!open) return;
		if (guidance === "first") setupLink.current?.focus();
		else if (guidance === "proof") {
			if (hasPassword || hasTotp) field.current?.focus();
			else passkeyButton.current?.focus();
		} else cancel.current?.focus();
	}, [open, guidance, hasPassword, hasTotp]);
	function finish(accepted: boolean) {
		setOpen(false);
		setPassword("");
		setCode("");
		pending.current?.(accepted);
		pending.current = null;
	}
	async function run<T>(work: () => Promise<T>): Promise<T> {
		const generation = authenticationGeneration();
		try {
			return await work();
		} catch (error) {
			if (!(error instanceof ApiError) || error.code !== "recent_proof_required") throw error;
			pending.current?.(false);
			setProblem("");
			setOpen(true);
			const accepted = await new Promise<boolean>((resolve) => {
				pending.current = resolve;
			});
			if (!accepted)
				throw new ApiError("recent_proof_required", "Credential confirmation cancelled. Nothing was changed.");
			if (!authenticationUnchanged(generation))
				throw new ApiError("unauthenticated", "The session changed. Try the action again.");
			return work();
		}
	}
	async function prove(passkey: boolean) {
		if (busy) return;
		setBusy(true);
		setProblem("");
		try {
			let body: { password: string } | { code: string } | { passkey: unknown };
			if (passkey) {
				const options = await exchange("/api/account/proof", { body: { begin: true }, signedIn: true });
				const parsed = z.object({ passkey: RequestOptions }).parse(options).passkey;
				body = { passkey: await presentPasskey(parsed) };
			} else body = password ? { password } : { code: code.trim() };
			await exchange("/api/account/proof", { body, signedIn: true });
			finish(true);
		} catch (error) {
			setProblem(saidBy(error));
		} finally {
			setBusy(false);
		}
	}
	const prompt = open && (
		<section
			className="settings-proof"
			aria-label="Confirm your sign-in"
			onKeyDown={(event) => {
				if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
					event.preventDefault();
					event.stopPropagation();
					void prove(false);
				}
			}}
		>
			<h3>Confirm your sign-in</h3>
			{guidance === "loading" ? (
				<p role="status">Reading your sign-in methods…</p>
			) : guidance === "error" ? (
				<p role="status">
					{saidBy(credentials.error)} Cancel confirmation and retry the action to read your sign-in methods again.
				</p>
			) : guidance === "first" ? (
				<p>
					Add your first password or passkey in{" "}
					<a ref={setupLink} href={`${routeUrl({ project, screen: "settings" })}?section=signin`}>
						Your sign-in
					</a>
					. Then return here, retry the action and confirm that credential.
				</p>
			) : guidance === "recovery" ? (
				<p>
					Provider sign-in does not count as proof. Ask the owner for a recovery link, accept it with a password or
					passkey, then retry this action.
				</p>
			) : (
				<>
					<p>Prove your own credential to continue. This proof lasts ten minutes in this session.</p>
					{(hasPassword || hasTotp) && (
						<div className="settings-form">
							{hasPassword && (
								<label>
									Password
									<input
										ref={field}
										className="form-input"
										type="password"
										autoComplete="current-password"
										value={password}
										onChange={(event) => setPassword(event.target.value)}
									/>
								</label>
							)}
							{hasTotp && (
								<label>
									{hasPassword ? "Or authenticator code" : "Authenticator code"}
									<input
										ref={hasPassword ? undefined : field}
										className="form-input"
										autoComplete="one-time-code"
										inputMode="numeric"
										maxLength={6}
										value={code}
										onChange={(event) => setCode(event.target.value)}
									/>
								</label>
							)}
							<button className="out" type="button" aria-disabled={busy} onClick={() => void prove(false)}>
								Confirm credential
							</button>
						</div>
					)}
					{hasPasskey && (
						<button
							ref={passkeyButton}
							className="out"
							type="button"
							aria-disabled={busy}
							onClick={() => void prove(true)}
						>
							Use a passkey
						</button>
					)}
				</>
			)}
			<button ref={cancel} className="out" type="button" disabled={busy} onClick={() => finish(false)}>
				Cancel confirmation
			</button>
			<p role="status">{problem}</p>
		</section>
	);
	return { run, prompt };
}
