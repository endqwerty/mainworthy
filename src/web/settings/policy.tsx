import { useState } from "react";
import { z } from "zod";
import { ANSWER_LABELS, ANSWERS, Ask, Blocks, clauseOf, Kind, Policy, PolicySettings } from "../../core/kinds.ts";
import type { QuestionItem } from "../../core/ops.ts";
import { whoAnswers } from "../../core/policy-guide.ts";
import { policyProblem } from "../../core/presets.ts";
import { call } from "../lib/api.ts";
import { randomId } from "../lib/ids.ts";
import { Select } from "../ui/index.tsx";

export const PolicySnapshot = Policy.extend({ version: z.number().int().positive() });
export type PolicySnapshot = z.infer<typeof PolicySnapshot>;
export type ClauseChange = Pick<Policy, "clauses" | "settings"> & { base: number };
export const policyConflictMessage =
	"The policy changed while you edited. Your draft is kept. Cancel and reopen the editor to start from the current policy.";
const draftOf = (policy: Policy) => ({
	clauses: policy.clauses.map((clause) => ({
		...clause,
		key: randomId(),
		when: clause.when.join("\n"),
		answer: clause.answer === undefined ? "" : JSON.stringify(clause.answer),
	})),
	settings: policy.settings,
	flakyDays: String(policy.settings.holds.flakyDays),
});
type Draft = ReturnType<typeof draftOf>;
type DraftClause = Draft["clauses"][number];

function validate(draft: Draft): { policy: Policy; problem: null } | { policy: null; problem: string } {
	try {
		const policy = Policy.parse({
			preset: "custom",
			clauses: draft.clauses.map(({ when, answer, ...clause }) => ({
				...clause,
				when: when.split(/\r?\n/).map((part) => part.trim()),
				...(answer !== "" ? { answer: JSON.parse(answer) as unknown } : {}),
			})),
			settings: { ...draft.settings, holds: { ...draft.settings.holds, flakyDays: Number(draft.flakyDays) } },
		});
		const ids = new Set<string>();
		for (const clause of policy.clauses) {
			if (ids.has(clause.id)) return { policy: null, problem: `Clause ids must be unique: ${clause.id}` };
			ids.add(clause.id);
			if (clause.ask.who === "rule" && !ANSWERS[clause.kind].safeParse(clause.answer).success)
				return { policy: null, problem: `Clause ${clause.id} needs a valid ${clause.kind} rule answer.` };
		}
		const problem = policyProblem(policy);
		return problem ? { policy: null, problem } : { policy, problem: null };
	} catch (error) {
		return {
			policy: null,
			problem:
				error instanceof z.ZodError
					? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
					: 'Rule answers must be valid JSON, for example {"is":"accept"}.',
		};
	}
}

const Facts = z.array(z.string());
function matching(policy: Policy, question: QuestionItem, answer?: string): string {
	const facts = Facts.parse(question.evidence.facts);
	const clause = clauseOf(policy, { kind: question.kind, facts: new Set(facts), ...(answer ? { answer } : {}) });
	return clause
		? `${clause.id}: ${whoAnswers(clause)}${clause.ask.who === "rule" ? ` ${JSON.stringify(clause.answer)}` : ""} · lists ${clause.blocks === "nothing" ? "no" : clause.blocks} runs`
		: "No matching clause";
}

export function PolicyEditor({
	policy,
	project,
	mayChange,
	busy,
	onApply,
}: {
	policy: PolicySnapshot;
	project: string;
	mayChange: boolean;
	busy: boolean;
	onApply: (change: ClauseChange, reason: string) => Promise<boolean>;
}) {
	const [base, setBase] = useState<PolicySnapshot | null>(null);
	const [draft, setDraft] = useState(() => draftOf(policy));
	const [reason, setReason] = useState("");
	const [working, setWorking] = useState(false);
	const [message, setMessage] = useState("");
	const [sample, setSample] = useState<QuestionItem[] | null>(null);
	const checked = validate(draft);
	const candidate = checked.policy;
	const locked = busy || working || !mayChange;
	const stale = base !== null && base.version !== policy.version;
	const update = (next: Draft) => {
		setDraft(next);
		setSample(null);
		setMessage("");
	};
	const updateClause = (index: number, change: Partial<DraftClause>) =>
		update({
			...draft,
			clauses: draft.clauses.map((clause, at) => (at === index ? { ...clause, ...change } : clause)),
		});
	async function preview() {
		if (!checked.policy || locked) return;
		setWorking(true);
		setMessage("");
		setSample(null);
		try {
			const [open, settled] = await Promise.all([
				call("inbox", { limit: 20 }, { project }),
				call("inbox", { state: "decided", limit: 20 }, { project }),
			]);
			const questions = [...open.items, ...settled.items];
			for (const question of questions) Facts.parse(question.evidence.facts);
			setSample(questions);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "The preview could not be read.");
		} finally {
			setWorking(false);
		}
	}
	async function apply() {
		if (!checked.policy || !base || !reason.trim() || locked) return;
		setWorking(true);
		setMessage("");
		try {
			if (
				await onApply(
					{ base: base.version, clauses: checked.policy.clauses, settings: checked.policy.settings },
					reason.trim(),
				)
			) {
				setBase(null);
				setSample(null);
			}
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "The policy could not be changed. Your draft is kept.");
		} finally {
			setWorking(false);
		}
	}
	if (!base)
		return (
			<button
				type="button"
				className="out"
				disabled={locked}
				onClick={() => {
					setDraft(draftOf(policy));
					setBase(policy);
					setReason("");
					setMessage("");
				}}
			>
				Edit clauses
			</button>
		);
	return (
		<section aria-label="Policy clause editor" className="policy-editor">
			<h3>Edit clauses · first match wins</h3>
			{stale && <p role="status">{policyConflictMessage}</p>}
			<p className="dim">
				Conditions are written one per line and must all match. Every kind must end with an always clause. A rule answer
				is JSON.
			</p>
			<fieldset disabled={locked}>
				<legend>Clause draft</legend>
				<div className="settings-table-scroll">
					<table className="settings-table">
						<thead>
							<tr>
								<th>Clause</th>
								<th>Kind</th>
								<th>When</th>
								<th>Who answers</th>
								<th>Agent answer</th>
								<th>Reason</th>
								<th>Producer</th>
								<th>Blocks</th>
								<th>Rule answer</th>
								<th>Order</th>
							</tr>
						</thead>
						<tbody>
							{draft.clauses.map((clause, index) => (
								<tr key={clause.key} aria-label={`Clause ${clause.id}`}>
									<td>
										<input
											aria-label="Clause id"
											value={clause.id}
											onChange={(event) => updateClause(index, { id: event.target.value })}
										/>
									</td>
									<td>
										<Select
											aria-label="Kind"
											value={clause.kind}
											onChange={(event) => updateClause(index, { kind: Kind.parse(event.target.value) })}
										>
											{Kind.options.map((kind) => (
												<option key={kind}>{kind}</option>
											))}
										</Select>
									</td>
									<td>
										<textarea
											aria-label="Conditions"
											value={clause.when}
											onChange={(event) => updateClause(index, { when: event.target.value })}
										/>
									</td>
									<td>
										<Select
											aria-label="Who answers"
											value={clause.ask.who}
											onChange={(event) =>
												updateClause(index, { ask: { ...clause.ask, who: Ask.shape.who.parse(event.target.value) } })
											}
										>
											{Ask.shape.who.options.map((who) => (
												<option key={who}>{who}</option>
											))}
										</Select>
									</td>
									<td>
										<Select
											aria-label="Agent answer"
											value={clause.ask.agents}
											onChange={(event) =>
												updateClause(index, {
													ask: { ...clause.ask, agents: Ask.shape.agents.parse(event.target.value) },
												})
											}
										>
											{Ask.shape.agents.options.map((agents) => (
												<option key={agents}>{agents}</option>
											))}
										</Select>
									</td>
									<td>
										<Select
											aria-label="Reason"
											value={clause.ask.reason}
											onChange={(event) =>
												updateClause(index, {
													ask: { ...clause.ask, reason: Ask.shape.reason.parse(event.target.value) },
												})
											}
										>
											{Ask.shape.reason.options.map((value) => (
												<option key={value}>{value}</option>
											))}
										</Select>
									</td>
									<td>
										<label>
											<input
												type="checkbox"
												checked={clause.ask.notProducer}
												onChange={(event) =>
													updateClause(index, { ask: { ...clause.ask, notProducer: event.target.checked } })
												}
											/>
											Exclude producer
										</label>
									</td>
									<td>
										<Select
											aria-label="Blocks"
											value={clause.blocks}
											onChange={(event) => updateClause(index, { blocks: Blocks.parse(event.target.value) })}
										>
											{Blocks.options.map((blocks) => (
												<option key={blocks}>{blocks}</option>
											))}
										</Select>
									</td>
									<td>
										<textarea
											aria-label="Rule answer"
											disabled={clause.ask.who !== "rule"}
											value={clause.answer}
											onChange={(event) => updateClause(index, { answer: event.target.value })}
										/>
									</td>
									<td>
										<button
											type="button"
											aria-label="Move up"
											disabled={index === 0}
											onClick={() => {
												const clauses = [...draft.clauses];
												clauses.splice(index - 1, 0, ...clauses.splice(index, 1));
												update({ ...draft, clauses });
											}}
										>
											↑
										</button>
										<button
											type="button"
											aria-label="Move down"
											disabled={index === draft.clauses.length - 1}
											onClick={() => {
												const clauses = [...draft.clauses];
												clauses.splice(index + 1, 0, ...clauses.splice(index, 1));
												update({ ...draft, clauses });
											}}
										>
											↓
										</button>
										<button
											type="button"
											onClick={() => update({ ...draft, clauses: draft.clauses.filter((_, at) => at !== index) })}
										>
											Remove
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<button
					type="button"
					className="out"
					onClick={() =>
						update({
							...draft,
							clauses: [
								...draft.clauses,
								{
									key: randomId(),
									id: `clause-${draft.clauses.length + 1}`,
									kind: "failure",
									when: "always",
									ask: { who: "member", agents: "none", reason: "optional", notProducer: false },
									blocks: "nothing",
									answer: "",
								},
							],
						})
					}
				>
					Add clause
				</button>
				<div className="settings-form">
					<label>
						Flaky hold in days
						<input
							className="form-input"
							type="number"
							min="1"
							max="365"
							value={draft.flakyDays}
							onChange={(event) => update({ ...draft, flakyDays: event.target.value })}
						/>
					</label>
					<label>
						Evidence basis
						<Select
							className="form-input"
							value={draft.settings.basis}
							onChange={(event) =>
								update({
									...draft,
									settings: { ...draft.settings, basis: PolicySettings.shape.basis.parse(event.target.value) },
								})
							}
						>
							{PolicySettings.shape.basis.options.map((value) => (
								<option key={value}>{value}</option>
							))}
						</Select>
					</label>
					<label>
						<input
							type="checkbox"
							checked={draft.settings.holds.infraThisTargetOnly}
							onChange={(event) =>
								update({
									...draft,
									settings: {
										...draft.settings,
										holds: { ...draft.settings.holds, infraThisTargetOnly: event.target.checked },
									},
								})
							}
						/>
						Infrastructure covers this target only
					</label>
					<label>
						Policy change reason
						<textarea className="form-input" value={reason} onChange={(event) => setReason(event.target.value)} />
					</label>
				</div>
			</fieldset>
			<p role="status">{checked.problem ?? "Valid policy. Every kind has a final always clause."}</p>
			<div className="policy-editor-actions">
				<button type="button" className="out" disabled={locked || !checked.policy} onClick={() => void preview()}>
					Preview recent questions
				</button>
				<button
					type="button"
					className="out"
					disabled={locked || !checked.policy || !reason.trim()}
					onClick={() => void apply()}
				>
					Apply policy
				</button>
				<button
					type="button"
					className="out"
					disabled={busy || working}
					onClick={() => {
						setBase(null);
						setSample(null);
					}}
				>
					Cancel
				</button>
			</div>
			<p role="status">{working ? "Reading or recording policy…" : message}</p>
			{sample && candidate && (
				<>
					<h3>Preview recent questions</h3>
					<p className="dim">
						Up to 20 open questions in queue order and 20 most recently settled questions, using their current facts.
						This compares clause matching and applicable answer choices. It does not replay decisions, check a
						particular person's permissions, execute rules, or predict gate results. Existing decisions stay recorded.
						Hold and basis changes affect future decisions and runs.
					</p>
					{sample.length === 0 ? (
						<p>No questions are available to preview.</p>
					) : (
						<div className="settings-table-scroll">
							<table className="settings-table" aria-label="Policy preview">
								<thead>
									<tr>
										<th>Question</th>
										<th>Answer choice</th>
										<th>In force when editing began</th>
										<th>Draft</th>
									</tr>
								</thead>
								<tbody>
									{sample.flatMap((question) =>
										[undefined, ...question.answers].map((answer) => (
											<tr key={`${question.q}:${answer ?? "question"}`}>
												<th scope="row">
													{question.q} · {question.kind} · {question.title} · {question.state}
												</th>
												<td>{answer ? (ANSWER_LABELS[answer] ?? answer) : "No answer chosen"}</td>
												<td>{matching(base, question, answer)}</td>
												<td>{matching(candidate, question, answer)}</td>
											</tr>
										)),
									)}
								</tbody>
							</table>
						</div>
					)}
				</>
			)}
		</section>
	);
}
