import type { ReactNode } from "react";
import { z } from "zod";
import { diffBodies, diffWords } from "../../core/diff.ts";
import type { CaseBody } from "../../core/model.ts";

export function KeyCap({ children }: { children: ReactNode }) {
	return <kbd>{children}</kbd>;
}
export function ProducerGlyph({ kind }: { kind: string }) {
	const k = kind === "ci" || kind === "auto" ? "c" : kind === "agent" ? "a" : "h";
	return (
		<i className={`pg pg-${k}`} title={k === "c" ? "pipeline" : k === "a" ? "agent" : "person"}>
			{k === "c" ? "C" : k === "a" ? "A" : "H"}
		</i>
	);
}
export function age(at: number): string {
	const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
	return minutes < 1
		? "now"
		: minutes < 60
			? `${minutes}m`
			: minutes < 1440
				? `${Math.floor(minutes / 60)}h`
				: `${Math.floor(minutes / 1440)}d`;
}
const Proof = z.object({ outcome: z.string(), current: z.boolean(), at: z.number(), basis: z.string() }).nullable();
export const Proofs = z.object({ human: Proof, auto: Proof, agent: Proof });
export type Proofs = z.infer<typeof Proofs>;
export function ProofStrip({ proof }: { proof?: unknown }) {
	const parsed = Proofs.safeParse(proof);
	const values = parsed.success ? parsed.data : { human: null, auto: null, agent: null };
	return (
		<span className="pfs">
			{(["human", "auto", "agent"] satisfies (keyof Proofs)[]).map((kind) => {
				const p = values[kind];
				const mark = !p
					? "·"
					: p.outcome === "pass"
						? p.current
							? "✓"
							: "~"
						: p.outcome === "fail" || p.outcome === "error"
							? "✗"
							: "·";
				return (
					<span
						key={kind}
						className={`pf ${mark === "✓" ? "ps" : mark === "✗" ? "fl" : mark === "~" ? "st2" : "nv"}`}
						title={
							p
								? `${kind}: ${p.outcome}, ${p.current ? "current version" : "older version"}, basis ${p.basis}, ${age(p.at)}`
								: `${kind}: never exercised`
						}
					>
						<ProducerGlyph kind={kind} />
						<b>{mark}</b>
						<u>{p ? age(p.at) : ""}</u>
					</span>
				);
			})}
		</span>
	);
}
export function StatusLine({ children }: { children: ReactNode }) {
	return (
		<span id="stat" role="status" aria-live="polite">
			{children}
		</span>
	);
}
export function EmptyState({ children }: { children: ReactNode }) {
	return <div className="empty-state">{children}</div>;
}
export function SectionHeading({ children }: { children: ReactNode }) {
	return <div className="sech">{children}</div>;
}
export function ListRow({
	children,
	selected = false,
	onClick,
}: {
	children: ReactNode;
	selected?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={`row ${selected ? "sel" : ""}`}
			role="option"
			aria-selected={selected}
			onClick={onClick}
		>
			{children}
		</button>
	);
}
export function WordDiff({ before, after }: { before: string; after: string }) {
	let offset = 0;
	return (
		<>
			{diffWords({ before, after }).map((part) => {
				const key = `${offset}:${part.op}`;
				offset += part.text.length;
				return part.op === "del" ? (
					<del key={key}>{part.text}</del>
				) : part.op === "ins" ? (
					<ins key={key}>{part.text}</ins>
				) : (
					<span key={key}>{part.text}</span>
				);
			})}
		</>
	);
}
/** Stable step ids align edits; the pure core diff owns additions, removals and moves. */
export function DiffView({ before, after }: { before: CaseBody; after: CaseBody }) {
	const diff = diffBodies(before, after);
	return (
		<section className="diff" aria-label="Case diff">
			{diff.title.kind === "changed" && (
				<div className="dl chg">
					<i>~</i>
					<div>
						<WordDiff before={before.title} after={after.title} />
					</div>
				</div>
			)}
			{diff.pre.kind === "changed" && (
				<div className="dl chg">
					<i>~</i>
					<div>
						Preconditions: <WordDiff before={before.pre} after={after.pre} />
					</div>
				</div>
			)}
			{diff.methods.kind === "changed" && (
				<div className="dl chg">
					<i>~</i>
					<div>
						Evidence from:{" "}
						<WordDiff
							before={before.methods
								.map((method) => (method === "human" ? "person" : method === "auto" ? "pipeline" : "agent"))
								.join(", ")}
							after={after.methods
								.map((method) => (method === "human" ? "person" : method === "auto" ? "pipeline" : "agent"))
								.join(", ")}
						/>
					</div>
				</div>
			)}
			{diff.automate.kind === "changed" && (
				<div className="dl chg">
					<i>~</i>
					<div>
						Automation: <WordDiff before={before.automate} after={after.automate} />
					</div>
				</div>
			)}
			{diff.fields.kind === "changed" &&
				[...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])]
					.filter((key) => before.fields[key] !== after.fields[key])
					.map((key) => (
						<div className="dl chg" key={key}>
							<i>~</i>
							<div>
								{key}: <WordDiff before={before.fields[key] ?? ""} after={after.fields[key] ?? ""} />
							</div>
						</div>
					))}
			{diff.steps.map((step) => {
				switch (step.kind) {
					case "same":
						return (
							<div key={step.id} className="dl same">
								<i>{step.to + 1}</i>
								<div>
									{step.after.action}
									{step.after.expected && <div className="x">&gt; {step.after.expected}</div>}
								</div>
							</div>
						);
					case "added":
						return (
							<div key={step.id} className="dl add">
								<i>+</i>
								<div>
									{step.after.action}
									{step.after.expected && <div>&gt; {step.after.expected}</div>}
								</div>
							</div>
						);
					case "removed":
						return (
							<div key={step.id} className="dl del">
								<i>−</i>
								<div>
									{step.before.action}
									{step.before.expected && <div>&gt; {step.before.expected}</div>}
								</div>
							</div>
						);
					case "changed":
						return (
							<div key={step.id} className="dl chg">
								<i>~</i>
								<div>
									<WordDiff before={step.before.action} after={step.after.action} />
									{(step.before.expected || step.after.expected) && (
										<div>
											&gt; <WordDiff before={step.before.expected ?? ""} after={step.after.expected ?? ""} />
										</div>
									)}
								</div>
							</div>
						);
					case "moved":
						return (
							<div key={step.id} className="dl chg">
								<i>↕</i>
								<div>
									{step.after.action}{" "}
									<span className="dim">
										step {step.from + 1} to {step.to + 1}
									</span>
								</div>
							</div>
						);
					default: {
						const exhaustive: never = step;
						return exhaustive;
					}
				}
			})}
		</section>
	);
}
