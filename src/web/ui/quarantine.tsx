import { useState } from "react";
import { z } from "zod";
import { QuarantineExit as ExitSchema, Quarantine, type QuarantineExit } from "../../core/flaky.ts";
import { call } from "../lib/api.ts";
import { invalidateProject, useQueryOp } from "../lib/data.ts";
import { dateTime } from "../lib/people.ts";
import { navigate, refUrl } from "../lib/router.ts";
import { useApp } from "./context.tsx";

const Test = z.object({ ref: z.string(), name: z.string(), quarantine: Quarantine.nullable() });
const Page = z.object({ count: z.number(), items: z.array(Test), cursor: z.string().nullable() });

export function quarantineExitText(exit: QuarantineExit | null): string {
	if (exit === null) return "Ended by a person";
	switch (exit.kind) {
		case "person":
			return "A person's decision";
		case "expiry":
			return `Expires ${dateTime(exit.at)}`;
		case "passes":
			return `${exit.count} consecutive passing trunk commits`;
	}
}

export function QuarantineList({ testRef = "" }: { testRef?: string }) {
	const { project, setStatus } = useApp();
	const [cursor, setCursor] = useState<string>();
	const [test, setTest] = useState(testRef);
	const [reason, setReason] = useState("");
	const [endReason, setEndReason] = useState("");
	const [kind, setKind] = useState<"person" | "passes" | "expiry">("passes");
	const [passes, setPasses] = useState("3");
	const [expiry, setExpiry] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const list = useQueryOp({
		project,
		op: "find",
		input: { in: "tests", state: "quarantined", limit: 20, ...(cursor ? { cursor } : {}) },
	});
	const page = Page.safeParse(list.data);
	async function propose(ref: string, exit: QuarantineExit | null, reason: string, base?: number) {
		setBusy(true);
		setError(null);
		try {
			const rows = await call("get", { refs: [ref] }, { project });
			const read = Test.parse(rows[0]);
			if (base !== undefined && base !== read.quarantine?.decision)
				throw new Error("Quarantine changed. Refresh the list before proposing its end. Your reason is kept.");
			const proposal = await call(
				"propose",
				{ edits: [{ op: "quarantine", test: ref, base: read.quarantine?.decision ?? null, exit }], reason },
				{ project },
			);
			await invalidateProject(project);
			setStatus(`Quarantine proposal ${proposal.proposal} waits for a person's decision.`);
			if (proposal.question) navigate(refUrl({ project, ref: proposal.question }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="quarantine-list" aria-label="Quarantined tests">
			<h3>Quarantined tests</h3>
			<p className="dim">
				Failures stay recorded and visible. A person decides when they stop blocking, with a reason and an exit rule.
			</p>
			{list.error && <p role="alert">{list.error.message}</p>}
			{!list.error && !list.data && <p>Loading quarantined tests…</p>}
			{list.data && !page.success && <p role="alert">The quarantine list could not be read. Refresh to try again.</p>}
			{page.success && (
				<>
					<p>
						{page.data.count} quarantined {page.data.count === 1 ? "test" : "tests"}
					</p>
					<p className="dim">To propose an end, enter a reason below, then choose the test's end button.</p>
					{page.data.items.length > 0 && (
						<label>
							Reason to end quarantine{" "}
							<input
								className="form-input"
								value={endReason}
								maxLength={500}
								onChange={(event) => setEndReason(event.target.value)}
							/>
						</label>
					)}
					<ul>
						{page.data.items.map((row) => (
							<li key={row.ref}>
								<strong>
									{row.ref} · {row.name}
								</strong>
								{row.quarantine && (
									<>
										<p>{row.quarantine.reason}</p>
										<p className="dim">
											Since {dateTime(row.quarantine.since)} · {row.quarantine.by} ·{" "}
											{quarantineExitText(row.quarantine.exit)}
										</p>
										<button
											className="out"
											type="button"
											disabled={busy || !endReason.trim()}
											onClick={() => void propose(row.ref, null, endReason, row.quarantine?.decision)}
										>
											Propose ending {row.ref} quarantine
										</button>
									</>
								)}
							</li>
						))}
					</ul>
					{cursor && (
						<button className="out" type="button" onClick={() => setCursor(undefined)}>
							First page
						</button>
					)}
					{page.data.cursor && (
						<button className="out" type="button" onClick={() => setCursor(page.data.cursor ?? undefined)}>
							More quarantined tests
						</button>
					)}
				</>
			)}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					const parsed = ExitSchema.safeParse(
						kind === "passes"
							? { kind, count: Number(passes) }
							: kind === "expiry"
								? { kind, at: Date.parse(expiry) }
								: { kind },
					);
					if (!parsed.success) {
						setError("Choose a valid exit rule, pass count or expiry date.");
						return;
					}
					void propose(test, parsed.data, reason);
				}}
			>
				<label>
					Test ref{" "}
					<input
						className="form-input"
						value={test}
						placeholder="T-1"
						required
						pattern="T-[0-9]+"
						onChange={(event) => setTest(event.target.value)}
					/>
				</label>
				<label>
					Quarantine reason{" "}
					<input
						className="form-input"
						value={reason}
						required
						maxLength={500}
						onChange={(event) => setReason(event.target.value)}
					/>
				</label>
				<label>
					Exit rule{" "}
					<select
						aria-label="Exit rule"
						className="form-input"
						value={kind}
						onChange={(event) => {
							const parsed = z.enum(["person", "passes", "expiry"]).parse(event.target.value);
							setKind(parsed);
						}}
					>
						<option value="passes">Consecutive passing trunk commits</option>
						<option value="person">A person's decision</option>
						<option value="expiry">Expiry date</option>
					</select>
				</label>
				{kind === "passes" && (
					<label>
						Passing trunk commits{" "}
						<input
							className="form-input"
							type="number"
							min="1"
							max="100"
							required
							value={passes}
							onChange={(event) => setPasses(event.target.value)}
						/>
					</label>
				)}
				{kind === "expiry" && (
					<label>
						Expiry date{" "}
						<input
							className="form-input"
							type="datetime-local"
							required
							value={expiry}
							onChange={(event) => setExpiry(event.target.value)}
						/>
					</label>
				)}
				<button className="out" type="submit" disabled={busy || !reason.trim()}>
					Propose quarantine
				</button>
			</form>
			{error && <p role="alert">{error}</p>}
		</section>
	);
}
