import { useState } from "react";
import type { TotpEnrolment } from "../../core/people.ts";
import { ApiError } from "../lib/api.ts";
import { beginTotp, confirmTotp } from "../lib/people.ts";
import { saidOfWrite } from "./list.ts";

type Setup = { kind: "idle" } | { kind: "enrol"; enrolment: TotpEnrolment } | { kind: "recovery"; codes: string[] };

export function Authenticator({ enrolled, onChanged }: { enrolled: boolean; onChanged: () => Promise<void> }) {
	const [setup, setSetup] = useState<Setup>({ kind: "idle" });
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState("");
	const failed = (error: unknown): void => {
		setProblem(
			saidOfWrite(
				error,
				"No readable answer came back. The page cannot tell whether enrolment completed. Read the credential list again before beginning another enrolment. Recovery codes cannot be shown again.",
			),
		);
		if (!(error instanceof ApiError)) void onChanged();
	};
	if (setup.kind === "recovery")
		return (
			<div>
				<p>
					Authenticator added. Save these recovery codes somewhere private. Each works once with your password, and this
					list is shown once.
				</p>
				<ul aria-label="Recovery codes">
					{setup.codes.map((recovery) => (
						<li key={recovery}>
							<code>{recovery}</code>
						</li>
					))}
				</ul>
				<button className="out" type="button" onClick={() => setSetup({ kind: "idle" })}>
					I saved the recovery codes
				</button>
			</div>
		);
	if (enrolled)
		return (
			<p>Your password sign-in also needs an authenticator code or a recovery code. A passkey needs no extra code.</p>
		);
	if (setup.kind === "idle")
		return (
			<div>
				<p>Add a second factor for password sign-in. Use an authenticator app that supports TOTP.</p>
				<button
					className="out"
					type="button"
					aria-disabled={busy}
					onClick={() => {
						if (busy) return;
						setBusy(true);
						setProblem("");
						void beginTotp()
							.then((enrolment) => setSetup({ kind: "enrol", enrolment }))
							.catch(failed)
							.finally(() => setBusy(false));
					}}
				>
					Add an authenticator
				</button>
				<p className="settings-problem" role="status">
					{problem}
				</p>
			</div>
		);
	const { enrolment } = setup;
	return (
		<form
			className="settings-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (busy) return;
				setBusy(true);
				setProblem("");
				void confirmTotp(enrolment.challenge, code.trim())
					.then(async (confirmed) => {
						setCode("");
						setSetup({ kind: "recovery", codes: confirmed.recoveryCodes });
						await onChanged();
					})
					.catch(failed)
					.finally(() => setBusy(false));
			}}
		>
			<p>
				Scan this QR code, or enter the setup key in your authenticator. Confirm a code within five minutes. Other
				sessions end when you confirm.
			</p>
			<svg
				role="img"
				aria-label="Authenticator QR code"
				width="220"
				height="220"
				viewBox={`0 0 ${enrolment.qr.size} ${enrolment.qr.size}`}
				shapeRendering="crispEdges"
			>
				<title>Authenticator QR code</title>
				<rect width="100%" height="100%" fill="white" />
				<path d={enrolment.qr.path} fill="black" />
			</svg>
			<p>
				Setup key: <code data-testid="totp-setup-key">{enrolment.secret}</code>
			</p>
			<label htmlFor="totp-confirm">Authenticator code</label>
			<input
				className="form-input"
				id="totp-confirm"
				autoComplete="one-time-code"
				inputMode="numeric"
				pattern="[0-9]{6}"
				required
				value={code}
				onChange={(event) => setCode(event.target.value)}
			/>
			<button className="out" type="submit" aria-disabled={busy}>
				Confirm authenticator
			</button>
			<button
				className="out"
				type="button"
				aria-disabled={busy}
				onClick={() => {
					if (!busy) {
						setSetup({ kind: "idle" });
						setCode("");
						setProblem("");
					}
				}}
			>
				Cancel enrolment
			</button>
			<p className="settings-problem" role="status">
				{problem}
			</p>
		</form>
	);
}
