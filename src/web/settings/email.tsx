import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { call } from "../lib/api.ts";
import { signInMethods } from "../lib/signin.ts";
import { useApp } from "../ui/context.tsx";
import { SectionHeading } from "../ui/index.tsx";
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
		enabled: methods.data !== undefined,
		refetchOnMount: "always",
	});
	const [email, setEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const shown = contact.error ? undefined : contact.data;
	// Without mail nothing is sent to the address: it is kept unverified, and signs the person in.
	const mail = methods.data?.mail === true;
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
						: mail
							? "Verification mail requested. Open its link before this address can receive password resets."
							: "Email address saved. Sign in with it or with the name.",
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
	if (!methods.data) return null;
	return (
		<section aria-label="Email">
			<SectionHeading>Email</SectionHeading>
			{proof.prompt}
			<p className="dim">
				{mail
					? "Sign in with it or with the name. Once verified, password resets are mailed to it."
					: "Sign in with it or with the name. This instance sends no mail, so the address stays unverified and no password reset is mailed to it."}
			</p>
			{shown?.email && (
				<p>
					{shown.email}
					{mail && (shown.verified ? " · verified" : " · awaiting verification")}
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
				<button className="out" type="submit" aria-disabled={busy}>
					{mail ? "Send verification link" : "Save email address"}
				</button>
			</form>
			{shown?.email && (
				<button className="out" type="button" aria-disabled={busy} onClick={() => save(null)}>
					Remove email address
				</button>
			)}
			<p role="status">{message}</p>
		</section>
	);
}
