import { z } from "zod";
import { SameCodeEvidence } from "../../core/flaky.ts";
import { newStepId } from "../../core/ids.ts";
import { CaseBody, emptyBody } from "../../core/model.ts";
import type { QuestionItem } from "../../core/ops.ts";
import { QuarantineEdit } from "../../core/ops.ts";
import { parseOutline } from "../../core/outline.ts";
import { useQueryOp } from "../lib/data.ts";
import { proposalReadMessage } from "../lib/proposals.ts";
import { navigate, refUrl } from "../lib/router.ts";
import { useApp } from "../ui/context.tsx";
import { DiffView, ProducerGlyph } from "../ui/index.tsx";
import { QuarantineList, quarantineExitText } from "../ui/quarantine.tsx";

/** Only a recognisable assertion gets a comparison; an arbitrary log stays verbatim. */
export function assertionComparison(message: string): { expected: string; observed: string } | null {
	const got = /\bexpected\s+(.+?),?\s+(?:but\s+)?(?:got|received)\s+(.+)/i.exec(message);
	if (got?.[1] && got[2]) return { expected: got[1].trim().replace(/,$/, ""), observed: got[2].trim() };
	const equal = /\bexpected\s+(.+?)\s+to\s+(?:equal|be)\s+(.+)/i.exec(message);
	if (equal?.[1] && equal[2]) return { expected: equal[2].trim(), observed: equal[1].trim() };
	const unequal = /^\s*(.+?)\s*!==\s*(.+?)\s*$/.exec(message);
	return unequal?.[1] && unequal[2] ? { expected: unequal[2].trim(), observed: unequal[1].trim() } : null;
}

const Test = z.object({ t: z.string(), name: z.string(), case: z.string().nullable().optional() });
export const MapEvidence = z.object({ file: z.string(), tests: z.array(Test), count: z.number() });
export const FailureEvidence = z.object({
	message: z.string().nullable(),
	sample: z.number().nullable().optional(),
	tests: z.array(Test.extend({ sameCode: SameCodeEvidence.optional() })),
	count: z.number(),
	target: z.string(),
	branch: z.string().nullable(),
	hints: z.array(z.string()),
	scope: z.string(),
});
const Suggestion = z.union([
	z.object({ case: z.object({ title: z.string(), folder: z.string().optional(), steps: z.array(z.string()) }) }),
	z.object({ step: z.string().optional(), action: z.string().optional(), expected: z.string().optional() }),
]);
export const FindingEvidence = z.object({
	on: z.string(),
	case: z.string().nullable(),
	category: z.string(),
	note: z.string(),
	finder: z.string(),
	step: z.string().nullable(),
	repro: z.string().nullable(),
	suggest: Suggestion.nullable(),
});
const AdoptEvidence = z.object({ proposal: z.string(), author: z.string(), reason: z.string().nullable() });
const ProposalEdit = z.discriminatedUnion("op", [
	QuarantineEdit,
	z.object({ op: z.literal("create"), body: CaseBody, folder: z.string(), tags: z.array(z.string()) }),
	z.object({
		op: z.literal("edit"),
		case: z.string().nullable(),
		base: z.number(),
		head: z.number(),
		body: CaseBody,
		current: CaseBody.nullable(),
		mine: CaseBody,
		conflicts: z.array(z.object({ path: z.string() }).passthrough()),
		refused: z.string().nullable(),
	}),
	z.object({ op: z.literal("restore"), case: z.string().nullable(), to: z.number(), body: CaseBody }),
	z.object({ op: z.literal("policy"), preset: z.string(), clauses: z.number() }),
	z.object({
		op: z.literal("place"),
		cases: z.array(z.string().nullable()),
		folder: z.string().nullable(),
		tags: z
			.object({
				set: z.array(z.string()).optional(),
				add: z.array(z.string()).optional(),
				remove: z.array(z.string()).optional(),
			})
			.nullable(),
	}),
	z.object({ op: z.literal("state"), cases: z.array(z.string().nullable()), to: z.string() }),
	z.object({ op: z.literal("folder"), name: z.string().optional(), archive: z.boolean().optional() }),
	z.object({ op: z.literal("cover"), case: z.string().nullable(), requirement: z.string(), on: z.boolean() }),
]);
const Proposal = z.object({
	ref: z.string(),
	author: z.string(),
	kind: z.string(),
	reason: z.string().nullable(),
	edits: z.array(ProposalEdit),
});
const Document = CaseBody.extend({
	fields: z.record(z.string(), z.string()).default({}),
	ref: z.string(),
	version: z.number(),
});

export function RefLink({ refValue }: { refValue: string }) {
	const { project } = useApp();
	const href = refUrl({ project, ref: refValue });
	return (
		<a
			className="ref"
			href={href}
			onClick={(event) => {
				event.preventDefault();
				navigate(href);
			}}
		>
			{refValue}
		</a>
	);
}

function ProposalEvidence({ question }: { question: QuestionItem }) {
	const { project } = useApp();
	const parsed = AdoptEvidence.safeParse(question.evidence);
	const read = useQueryOp({
		project,
		op: "get",
		input: { refs: [parsed.success ? parsed.data.proposal : ""] },
		enabled: parsed.success,
	});
	const proposal = Proposal.safeParse(read.data?.find((row) => parsed.success && row.ref === parsed.data.proposal));
	const error = !parsed.success
		? "The proposal evidence could not be read."
		: (read.error?.message ?? (read.data && !proposal.success ? "The proposal edits could not be read." : null));
	return (
		<div
			className={question.producer === "agent" ? "prop" : "ev"}
			data-proposal-evidence={question.q}
			data-proposal-read={proposal.success ? "ready" : error ? "error" : "loading"}
			data-proposal-error={error ?? undefined}
		>
			{parsed.success && (
				<p>
					<ProducerGlyph kind={question.producer} /> {parsed.data.author} proposes {parsed.data.proposal}
					{parsed.data.reason && `: ${parsed.data.reason}`}
				</p>
			)}
			{error && <p role="status">{error}</p>}
			{proposal.success
				? proposal.data.edits.map((edit) => {
						const editKey = JSON.stringify(edit);
						switch (edit.op) {
							case "edit":
								return (
									<div key={editKey}>
										<p>
											{edit.case && <RefLink refValue={edit.case} />} · version {edit.head} → proposed version{" "}
											{edit.head + 1}
										</p>
										<DiffView
											before={edit.current ?? emptyBody()}
											after={edit.conflicts.length ? edit.mine : edit.body}
										/>
										{edit.conflicts.length > 0 ? (
											<p className="queue-warning">
												Conflicting fields: {edit.conflicts.map((conflict) => conflict.path).join(", ")}. The author
												must resolve both sides.
											</p>
										) : (
											edit.refused && <p className="queue-warning">Accepting is refused now: {edit.refused}.</p>
										)}
									</div>
								);
							case "create":
								return (
									<div key={editKey}>
										<p>New case in {edit.folder || "the root"}</p>
										<DiffView before={emptyBody()} after={edit.body} />
									</div>
								);
							case "restore":
								return (
									<div key={editKey}>
										<p>
											Restore {edit.case} from version {edit.to} as a new version.
										</p>
										<h3>{edit.body.title}</h3>
										{edit.body.steps.map((step) => (
											<p key={step.id}>
												{step.action}
												{step.expected && ` > ${step.expected}`}
											</p>
										))}
									</div>
								);
							case "quarantine":
								return (
									<p key={editKey}>
										{edit.test}:{" "}
										{edit.exit === null ? "End quarantine" : `Quarantine. Exit rule: ${quarantineExitText(edit.exit)}`}.
										A person must decide with a reason.
									</p>
								);
							case "policy":
								return (
									<p key={editKey}>
										Use {edit.preset}, with {edit.clauses} policy clauses. The proposal and accepting decision are both
										recorded.
									</p>
								);
							case "place":
								return (
									<p key={editKey}>
										{edit.cases.join(", ")}
										{edit.folder !== null && ` moves to ${edit.folder || "the root"}`}
										{edit.tags &&
											` · tags: ${[...(edit.tags.set ?? []), ...(edit.tags.add ?? [])].join(", ") || "removed"}`}
									</p>
								);
							case "state":
								return (
									<p key={editKey}>
										{edit.cases.join(", ")} becomes {edit.to}.
									</p>
								);
							case "folder":
								return (
									<p key={editKey}>
										Folder {edit.name ?? "change"}
										{edit.archive ? " is archived" : " is updated"}.
									</p>
								);
							case "cover":
								return (
									<p key={editKey}>
										{edit.case} {edit.on ? "covers" : "stops covering"} {edit.requirement}.
									</p>
								);
							default: {
								const exhaustive: never = edit;
								return exhaustive;
							}
						}
					})
				: !error && <p className="dim">Reading the proposed edits…</p>}
		</div>
	);
}

function FindingSuggestion({ evidence, q }: { evidence: z.infer<typeof FindingEvidence>; q: string }) {
	const { project } = useApp();
	const read = useQueryOp({
		project,
		op: "get",
		input: { refs: [evidence.case ?? ""] },
		enabled: Boolean(evidence.case && evidence.suggest),
	});
	const current = Document.safeParse(read.data?.[0]);
	const suggest = evidence.suggest;
	if (!suggest) return null;
	if ("case" in suggest) {
		const outline = parseOutline([suggest.case.title, ...suggest.case.steps.map((step) => `  ${step}`)].join("\n"));
		return (
			<DiffView
				before={emptyBody()}
				after={{
					...emptyBody(suggest.case.title),
					steps: outline.steps.map((step, index) => ({
						...step,
						id: newStepId(new Set(), () => index / outline.steps.length),
					})),
				}}
			/>
		);
	}
	if (!current.success || current.data.ref !== evidence.case) {
		const error =
			read.error?.message ?? (!read.isFetching && read.data ? "The suggested edit could not be read." : null);
		return (
			<div
				data-finding-evidence={q}
				data-finding-read={error ? "error" : "loading"}
				data-finding-error={error ?? undefined}
			>
				<p className="dim">{error ?? "Reading the suggested edit…"}</p>
			</div>
		);
	}
	const after = {
		...current.data,
		steps: current.data.steps.map((step) =>
			step.id === (suggest.step ?? evidence.step)
				? { ...step, action: suggest.action ?? step.action, expected: suggest.expected ?? step.expected }
				: step,
		),
	};
	return (
		<div data-finding-evidence={q} data-finding-read="ready">
			<DiffView before={current.data} after={after} />
		</div>
	);
}

const SignoffEvidence = z.object({
	run: z.string(),
	name: z.string(),
	verdict: z.string(),
	tally: z.record(z.string(), z.number()),
});
export function evidenceMessage(question: QuestionItem): string | null {
	const parsed =
		question.kind === "failure"
			? FailureEvidence.safeParse(question.evidence)
			: question.kind === "finding"
				? FindingEvidence.safeParse(question.evidence)
				: question.kind === "map"
					? MapEvidence.safeParse(question.evidence)
					: question.kind === "signoff"
						? SignoffEvidence.safeParse(question.evidence)
						: AdoptEvidence.safeParse(question.evidence);
	return parsed.success ? null : "The evidence could not be read. Refresh before answering.";
}

/** Whether `questionReadMessage` waits for the question's content to be on screen, as only the question shown is. */
export function readOnScreen(question: Pick<QuestionItem, "kind" | "evidence">): boolean {
	if (question.kind === "adopt") return true;
	if (question.kind !== "finding") return false;
	const parsed = FindingEvidence.safeParse(question.evidence);
	return Boolean(parsed.success && parsed.data.suggest && !("case" in parsed.data.suggest));
}

export function questionReadMessage(question: QuestionItem): string | null {
	const error = evidenceMessage(question);
	if (error) return error;
	if (question.kind === "adopt") return proposalReadMessage(question.q);
	if (question.kind === "finding") {
		const parsed = FindingEvidence.safeParse(question.evidence);
		if (parsed.success && parsed.data.suggest && !("case" in parsed.data.suggest)) {
			const card = document.querySelector<HTMLElement>(`[data-finding-evidence="${CSS.escape(question.q)}"]`);
			if (card?.dataset.findingRead !== "ready")
				return card?.dataset.findingError ?? "Still reading the suggested edit. Read it before answering.";
		}
	}
	return null;
}

function SameCodeSignals({ evidence }: { evidence: SameCodeEvidence }) {
	return evidence.signals.map((signal) => (
		<details key={signal.signature.id} className="same-code-evidence">
			<summary>
				{signal.class === "infra" ? "Infrastructure" : signal.class === "timeout" ? "Timeout" : "Assertion"}:{" "}
				{signal.flips} same-code outcome changes in {evidence.windowDays} days.
				{signal.suggested
					? signal.class === "infra"
						? " Review infrastructure."
						: " Review for flakiness."
					: ` Suggestion threshold: ${evidence.minFlips}.`}
			</summary>
			<p>{signal.signature.text}</p>
			<p>This evidence alone excuses no failure. Most recent examples:</p>
			<ul>
				{signal.samples.map((sample) => (
					<li key={sample.second.id}>
						{sample.commit.slice(0, 12)} · {sample.job || "unnamed job"} · {sample.env || "default environment"} ·
						producer {sample.actor}: result {sample.first.id} ({sample.first.outcome}, attempt {sample.first.attempt})
						to result {sample.second.id} ({sample.second.outcome}, attempt {sample.second.attempt})
					</li>
				))}
			</ul>
		</details>
	));
}

export function QuestionEvidence({ question, full }: { question: QuestionItem; full: boolean }) {
	switch (question.kind) {
		case "failure": {
			const parsed = FailureEvidence.safeParse(question.evidence);
			if (!parsed.success) return <p className="dim">The failure evidence could not be read. Refresh to try again.</p>;
			const evidence = parsed.data;
			const comparison = assertionComparison(evidence.message ?? question.title);
			return (
				<>
					{comparison && (
						<div className="assertion-comparison">
							<div>
								<span>Expected</span>
								<strong>{comparison.expected}</strong>
							</div>
							<div>
								<span>Observed</span>
								<strong>{comparison.observed}</strong>
							</div>
						</div>
					)}
					<pre className="queue-log">{evidence.message ?? question.title}</pre>
					<div className="dim">
						{evidence.target} · {evidence.branch ?? evidence.scope} · {evidence.count}{" "}
						{evidence.count === 1 ? "test shares" : "tests share"} this cause
					</div>
					{evidence.hints.includes("fails-on-base") && (
						<p className="hintbox">The same cause also fails on the base of this change.</p>
					)}
					{evidence.hints.includes("disputed") && (
						<p className="hintbox">A counted pass and fail disagree. A decision must settle the dispute.</p>
					)}
					<ul className="queue-tests">
						{evidence.tests.slice(0, full ? undefined : 3).map((test) => (
							<li key={test.t}>
								<span className="ref">{test.t}</span> {test.name} {test.case && <RefLink refValue={test.case} />}
								{test.sameCode && <SameCodeSignals evidence={test.sameCode} />}
							</li>
						))}
					</ul>
					{full && <QuarantineList testRef={evidence.tests[0]?.t ?? ""} />}
				</>
			);
		}
		case "adopt":
			return <ProposalEvidence question={question} />;
		case "finding": {
			const parsed = FindingEvidence.safeParse(question.evidence);
			if (!parsed.success) return <p className="dim">The finding evidence could not be read.</p>;
			const evidence = parsed.data;
			return (
				<div className={question.producer === "agent" ? "prop" : "ev"}>
					<p className="dim">
						{evidence.finder} · {evidence.category} · {evidence.on}
					</p>
					<p>{evidence.note}</p>
					{evidence.case && <RefLink refValue={evidence.case} />}
					{evidence.repro && <pre className="queue-log">{evidence.repro}</pre>}
					<FindingSuggestion evidence={evidence} q={question.q} />
				</div>
			);
		}
		case "map": {
			const parsed = MapEvidence.safeParse(question.evidence);
			if (!parsed.success) return <p className="dim">The unlinked tests could not be read.</p>;
			return (
				<>
					<p className="mono">{parsed.data.file}</p>
					<p className="dim">{parsed.data.count} tests without a case.</p>
					<ul className="queue-tests">
						{parsed.data.tests.map((test) => (
							<li key={test.t}>
								<span className="ref">{test.t}</span> {test.name}
							</li>
						))}
					</ul>
				</>
			);
		}
		case "signoff": {
			const parsed = z
				.object({ run: z.string(), name: z.string(), verdict: z.string(), tally: z.record(z.string(), z.number()) })
				.safeParse(question.evidence);
			return parsed.success ? (
				<>
					<p>
						<RefLink refValue={parsed.data.run} /> {parsed.data.name}
					</p>
					<h3>{parsed.data.verdict}</h3>
					<div className="queue-tally">
						{Object.entries(parsed.data.tally).map(([label, count]) => (
							<span key={label}>
								{count} {label}
							</span>
						))}
					</div>
				</>
			) : (
				<p>The sign-off evidence could not be read.</p>
			);
		}
		default: {
			const exhaustive: never = question.kind;
			return exhaustive;
		}
	}
}
