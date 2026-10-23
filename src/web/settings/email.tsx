import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { call } from "../lib/api.ts";
import { signInMethods } from "../lib/signin.ts";
import { useApp } from "../ui/context.tsx";
import { saidBy } from "./list.ts";
import { useRecentProof } from "./recent-proof.tsx";

const Contact = z.object({ email: z.string().nullable(), verified: z.boolean() });
export function EmailForm({ actor }: { actor?: string }) {
	const { project, session } = useApp();
	const proof = useRecentProof();
	const methods = useQuery({ queryKey: ["instance", "sign-in-methods"], queryFn: signInMethods, staleTime: Infinity });
	const contact = useQuery({
		queryKey: [project, "credential-email", actor ?? session.actor],
		queryFn: async ({ signal }) =>
			Contact.parse(await call("credential", { do: "email.get", ...(actor ? { actor } : {}) }, { signal })),
		enabled: methods.data?.mail === true,
		refetchOnMount: "always",
	});
	const [email, setEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const shown = contact.error ? undefined : contact.data;
	function save(value: string | null): void {
		if (busy) return;
		setBusy(true);
		setMessage("");
		void proof
			.run(() => call("credential", { do: "email.set", email: value, ...(actor ? { actor } : {}) }))
			.then((reply) => Contact.parse(reply))
			.then(async () => {
				setEmail("");
				setMessage(
					value === null
						? "Email address removed."
						: "Verification mail requested. Open its link before this address can receive password resets.",
				);
				await contact.refetch();
			})
			.catch((error: unknown) => setMessage(saidBy(error)))
			.finally(() => setBusy(false));
	}
	function submit(event: FormEvent): void {
		event.preventDefault();
		save(email);
	}
	if (!methods.data?.mail) return null;
	return (
		<section aria-label="Email for password reset">
			<h3>Email for password reset</h3>
			{proof.prompt}
			{shown?.email && (
				<p>
					{shown.email} · {shown.verified ? "verified" : "awaiting verification"}
				</p>
			)}
			{contact.error && <p role="status">{saidBy(contact.error)}</p>}
			<form className="settings-form" onSubmit={submit}>
				<label htmlFor={`contact-email-${actor ?? "self"}`}>Email address</label>
				<input
					className="form-input"
					id={`contact-email-${actor ?? "self"}`}
					type="email"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					required
					maxLength={254}
					autoComplete="email"
				/>
				<button className="btn" type="submit" aria-disabled={busy}>
					Send verification link
				</button>
			</form>
			{shown?.email && (
				<button className="btn" type="button" aria-disabled={busy} onClick={() => save(null)}>
					Remove email address
				</button>
			)}
			<p role="status">{message}</p>
		</section>
	);
}
