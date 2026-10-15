import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { z } from "zod";
import { diffBodies, diffWords } from "../../core/diff.ts";
import { type DocSlug, docUrl } from "../../core/docs.ts";
import { type CaseBody, stepAction } from "../../core/model.ts";
import { PASSWORD_LENGTH } from "../../core/people.ts";

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
		<span id="stat" role="status" aria-live="polite" aria-atomic="true">
			{children}
		</span>
	);
}
/** Opens a page of the documentation beside the app, so what is on the screen stays where it is. */
export const openDocs = (page: DocSlug): void => {
	window.open(docUrl(page), "_blank", "noopener");
};
/** A link to a page of the documentation (`docs/guide`), in a new tab. */
export function DocLink({ page, children }: { page: DocSlug; children: ReactNode }) {
	return (
		<a className="doc-link" href={docUrl(page)} target="_blank" rel="noopener">
			{children} <span aria-hidden="true">↗</span>
		</a>
	);
}
/** What a pane says when it has nothing to show. `doc` adds the page that explains how something gets here. */
export function EmptyState({ children, doc }: { children: ReactNode; doc?: { page: DocSlug; label: string } }) {
	return (
		<div className="empty-state">
			<span>{children}</span>
			{doc && <DocLink page={doc.page}>{doc.label}</DocLink>}
		</div>
	);
}
export function SectionHeading({ children }: { children: ReactNode }) {
	return <div className="sech">{children}</div>;
}
/**
 * How long a new password is, as it is typed, against the shortest and the longest the server takes. A field
 * names it with `aria-describedby`.
 */
/**
 * What a password manager is told about a new password, so that one it makes up is one the server takes. The
 * attribute is Safari's and 1Password reads it; React's types do not know it, so it is spread onto the field.
 */
export const PASSWORD_RULES = {
	passwordrules: `minlength: ${PASSWORD_LENGTH.min}; maxlength: ${PASSWORD_LENGTH.max};`,
};
export function PasswordCount({ id, text, className }: { id: string; text: string; className: string }) {
	// Characters as a person counts them, and as the server does: an emoji is one.
	const length = [...text].length;
	return (
		<div id={id} className={className}>
			{length < PASSWORD_LENGTH.min
				? `${length} of ${PASSWORD_LENGTH.min} characters`
				: length > PASSWORD_LENGTH.max
					? `${length} characters, and ${PASSWORD_LENGTH.max} is the most`
					: `${length} characters`}
		</div>
	);
}
/** The keys that change a closed native select by a step or a jump. */
const STEPS = new Set(["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]);
/** Opens the select's list; false where the browser has no `showPicker` or refuses it. */
function openList(select: HTMLSelectElement): boolean {
	if (typeof select.showPicker !== "function") return false;
	try {
		select.showPicker();
		return true;
	} catch {
		return false;
	}
}
/**
 * The one native select of the app. A select changes once, when a choice is made from its open list, and gives the
 * focus back at that change. A closed native select changes on every arrow key, so a key that would step it opens
 * its list instead (as macOS does); a choice from the list, with the pointer or with Enter, is the one change. A
 * letter typed on the closed select is a choice too. Escape on the closed select gives the focus back and reaches
 * nothing behind it; Enter opens the list. Where the browser cannot open the list, the key changes the select as it
 * would natively, and the change gives the focus back. `src/web/SHELL.md`, "Keyboard and palette".
 */
export function Select({ onChange, onKeyDown, ...rest }: ComponentProps<"select">) {
	return (
		<select
			{...rest}
			onKeyDown={(event) => {
				onKeyDown?.(event);
				if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
				const select = event.currentTarget;
				if (STEPS.has(event.key)) {
					if (openList(select)) event.preventDefault();
				} else if (event.key === "Enter" || event.key === "Escape") {
					// Not the screen's: Escape must not close the pane behind, nor Enter open a row or send a form.
					event.preventDefault();
					event.stopPropagation();
					if (event.key === "Escape" || !openList(select)) select.blur();
				}
			}}
			onChange={(event) => {
				const select = event.currentTarget;
				onChange?.(event);
				select.blur();
			}}
		/>
	);
}
export function ListRow({
	children,
	selected = false,
	checked,
	onClick,
}: {
	children: ReactNode;
	selected?: boolean;
	/**
	 * In a list that selects several rows, whether this one is selected. `selected` then marks the row shown, and a
	 * screen reader hears it as the current one.
	 */
	checked?: boolean;
	/** The event says where the click landed and with which keys held, for a list that selects several rows. */
	onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
	return (
		<button
			type="button"
			className={`row ${selected ? "sel" : ""}`}
			role="option"
			aria-selected={checked ?? selected}
			aria-current={checked === undefined || !selected ? undefined : "true"}
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
									{stepAction(step.after)}
									{step.after.expected && <div className="x">&gt; {step.after.expected}</div>}
								</div>
							</div>
						);
					case "added":
						return (
							<div key={step.id} className="dl add">
								<i>+</i>
								<div>
									{stepAction(step.after)}
									{step.after.expected && <div>&gt; {step.after.expected}</div>}
								</div>
							</div>
						);
					case "removed":
						return (
							<div key={step.id} className="dl del">
								<i>−</i>
								<div>
									{stepAction(step.before)}
									{step.before.expected && <div>&gt; {step.before.expected}</div>}
								</div>
							</div>
						);
					case "changed":
						return (
							<div key={step.id} className="dl chg">
								<i>~</i>
								<div>
									<WordDiff before={stepAction(step.before)} after={stepAction(step.after)} />
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
									{stepAction(step.after)}{" "}
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
