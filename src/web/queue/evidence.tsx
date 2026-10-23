import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef } from "react";
import { z } from "zod";
import { SameCodeEvidence } from "../../core/flaky.ts";
import { newStepId } from "../../core/ids.ts";
import { Policy } from "../../core/kinds.ts";
import { CaseBody, ConflictAddress, conflictLabel, emptyBody } from "../../core/model.ts";
import type { QuestionItem } from "../../core/ops.ts";
import { parseOutline } from "../../core/outline.ts";
import { QuarantineEdit } from "../../core/proposals.ts";
import { ResultLocation as LocationSchema, ResultTrail as TrailSchema } from "../../core/results.ts";
import { webUrl } from "../changes/results.tsx";
import { call } from "../lib/api.ts";
import { queryKey, useQueryOp } from "../lib/data.ts";
import { policyChanges } from "../lib/policy-changes.ts";
import { proposalReadMessage, watchProposalShown } from "../lib/proposals.ts";
import { navigate, refUrl } from "../lib/router.ts";
import { ResultAttachments } from "../ui/attachments.tsx";
import { useApp } from "../ui/context.tsx";
import { DiffView, ProducerGlyph } from "../ui/index.tsx";
import { QuarantineList, quarantineExitText } from "../ui/quarantine.tsx";
import { ResultLocation } from "../ui/result-location.tsx";
import { ResultTrail } from "../ui/result-trail.tsx";

/** Only a recognisable assertion gets a comparison; an arbitrary log stays verbatim. */
/** One end of a flip as the detector saw it: a result's attempt, or a runner's try inside it (decision 0129). */
const observed = (end: { outcome: string; attempt: number; try?: number | undefined }): string =>
	`${end.outcome}, attempt ${end.attempt}${end.try === undefined ? "" : `, runner's try ${end.try}`}`;

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
	location: LocationSchema.nullish(),
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
	z.object({
		op: z.literal("create"),
		body: CaseBody,
		folder: z.string(),
		tags: z.array(z.string()),
		covers: z.array(z.string()),
		after: z.string().nullable(),
	}),
	z.object({
		op: z.literal("edit"),
		case: z.string().nullable(),
		base: z.number(),
		head: z.number(),
		body: CaseBody,
		current: CaseBody.nullable(),
		mine: CaseBody,
		conflicts: z.array(z.object({ address: ConflictAddress }).passthrough()),
		refused: z.string().nullable(),
	}),
	z.object({
		op: z.literal("restore"),
		case: z.string().nullable(),
		to: z.number(),
		body: CaseBody,
		current: CaseBody.nullable(),
	}),
	z.object({
		op: z.literal("policy"),
		preset: z.string(),
		clauses: z.number(),
		policy: Policy,
		inForce: Policy,
		stale: z.boolean(),
	}),
	z.object({
		op: z.literal("place"),
		cases: z.array(z.string().nullable()),
		folder: z.string().nullable(),
		tags: z
			.object({
				set: z.array(z.string()).nullish(),
				add: z.array(z.string()).optional(),
				remove: z.array(z.string()).optional(),
			})
			.nullable(),
		after: z.string().optional(),
	}),
	z.object({ op: z.literal("state"), cases: z.array(z.string().nullable()), to: z.string() }),
	z.object({
		op: z.literal("folder"),
		folder: z.string().nullable(),
		name: z.string().nullable(),
		parent: z.string().optional(),
		archive: z.boolean(),
	}),
	z.object({ op: z.literal("cover"), case: z.string().nullable(), requirement: z.string(), on: z.boolean() }),
]);
const Proposal = z.object({
	ref: z.string(),
	author: z.string(),
	kind: z.string(),
	reason: z.string().nullable(),
	count: z.number(),
	cursor: z.string().nullable(),
	edits: z.array(ProposalEdit),
});

/** What a place edit does to its cases' tags: `set` (or their tags with `add`), less `remove`. */
function tagChange(tags: {
	set?: string[] | null | undefined;
	add?: string[] | undefined;
	remove?: string[] | undefined;
}): string {
	const remove = tags.remove ?? [];
	if (tags.set) return `tags become ${tags.set.filter((tag) => !remove.includes(tag)).join(", ") || "none"}`;
	return [
		tags.add?.length ? `adds tags ${tags.add.join(", ")}` : "",
		remove.length ? `removes tags ${remove.join(", ")}` : "",
	]
		.filter(Boolean)
		.join(", ");
}
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
	const parsed = AdoptEvidence.safeParse(question.evidence);
	return (
		<div className={question.producer === "agent" ? "prop" : "ev"}>
			{parsed.success && (
				<p>
					<ProducerGlyph kind={question.producer} /> {parsed.data.author} proposes {parsed.data.proposal}
					{parsed.data.reason && `: ${parsed.data.reason}`}
				</p>
			)}
			<ProposalEdits question={question} />
		</div>
	);
}

/**
 * Every edit of a proposal, wherever it is answered (the Queue, a case's timeline). It is marked read only once all
 * of them have been shown on screen, and `proposalReadMessage` refuses an answer until then.
 */
export function ProposalEdits({ question }: { question: QuestionItem }) {
	const { project } = useApp();
	const parsed = AdoptEvidence.safeParse(question.evidence);
	const input = { refs: [parsed.success ? parsed.data.proposal : ""] };
	const read = useInfiniteQuery({
		queryKey: [...queryKey({ project, op: "get", input }), "pages"],
		initialPageParam: "",
		meta: { restartOnChange: true },
		queryFn: async ({ pageParam, signal }) => {
			const rows = await call("get", { ...input, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal });
			return Proposal.parse(rows.find((row) => row.ref === input.refs[0]));
		},
		getNextPageParam: (page) => page.cursor ?? undefined,
		enabled: parsed.success,
	});
	useEffect(() => {
		if (read.hasNextPage && !read.isFetching && !read.isError) void read.fetchNextPage();
	}, [read.hasNextPage, read.isFetching, read.isError, read.fetchNextPage]);
	const pages = read.data?.pages;
	const first = pages?.[0];
	const edits = pages?.flatMap((page) => page.edits) ?? [];
	const short = first && !read.hasNextPage && edits.length !== first.count;
	const error = !parsed.success
		? "The proposal evidence could not be read."
		: (read.error?.message ??
			(short
				? `This proposal has ${first.count} edits, and a page shows the first ${edits.length}. Accepting applies all of them, so it cannot be answered here.`
				: null));
	const loaded = Boolean(first && !error && !read.isFetching && !read.hasNextPage);
	const signature = JSON.stringify(edits);
	const element = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (read.data && element.current && loaded) return watchProposalShown(element.current);
	}, [loaded, read.data]);
	return (
		<div
			className="proposal-edits"
			// Edits that change while open start again from the top, so what changed is read before an answer.
			key={signature}
			ref={element}
			data-proposal-evidence={question.q}
			data-proposal-loaded={loaded ? "true" : "false"}
			data-proposal-read={loaded ? "loaded" : error ? "error" : "loading"}
			data-proposal-error={error ?? undefined}
		>
			{error && <p role="status">{error}</p>}
			{first
				? edits.map((edit, index) => {
						const editKey = `${index}:${JSON.stringify(edit)}`;
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
												Conflicting fields:{" "}
												{edit.conflicts.map((conflict) => conflictLabel(conflict.address)).join(", ")}. The author must
												resolve both sides.
											</p>
										) : (
											edit.refused && (
												<p className="queue-warning">On its own, this edit would be refused: {edit.refused}.</p>
											)
										)}
									</div>
								);
							case "create":
								return (
									<div key={editKey}>
										<p>
											New case in {edit.folder || "the root"}
											{edit.after && ` · asked to follow ${edit.after}`}
											{edit.tags.length > 0 && ` · tags ${edit.tags.join(", ")}`}
											{edit.covers.length > 0 && ` · covers ${edit.covers.join(", ")}`}
										</p>
										<DiffView before={emptyBody()} after={edit.body} />
									</div>
								);
							case "restore":
								return (
									<div key={editKey}>
										<p>
											Restore {edit.case} from version {edit.to} as a new version.
										</p>
										<DiffView before={edit.current ?? emptyBody()} after={edit.body} />
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
							case "policy": {
								const changes = policyChanges(edit.inForce, edit.policy);
								return (
									<div key={editKey}>
										<p>
											Use {edit.preset}, with {edit.clauses} policy clauses. The proposal and accepting decision are
											both recorded.
										</p>
										{edit.stale && (
											<p className="queue-warning">
												The policy changed after this proposal was made, so accepting refuses it.
											</p>
										)}
										{changes.length ? (
											<ul>
												{changes.map((line) => (
													<li key={line}>{line}</li>
												))}
											</ul>
										) : (
											<p>The policy stays as it is.</p>
										)}
									</div>
								);
							}
							case "place":
								return (
									<p key={editKey}>
										{edit.cases.join(", ")}
										{edit.folder !== null && ` moves to ${edit.folder || "the root"}`}
										{edit.after !== undefined &&
											(edit.after ? ` · asked to follow ${edit.after}` : " · placed at the end of its folder")}
										{edit.tags && ` · ${tagChange(edit.tags)}`}
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
										{edit.folder === null ? `New folder ${edit.name ?? ""}` : `Folder ${edit.folder}`}
										{edit.folder !== null && edit.name !== null && ` is renamed ${edit.name}`}
										{edit.parent !== undefined &&
											` ${edit.folder === null ? "in" : "moves to"} ${edit.parent || "the root"}`}
										{edit.folder !== null && edit.archive && " is archived"}.
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

const SampleResult = z.object({
	id: z.number(),
	detail: z.string().nullable(),
	note: z.string().nullable(),
	steps: TrailSchema.nullable(),
	build: z.string().nullable(),
});

function SampleEvidence({ result }: { result: number }) {
	const { project } = useApp();
	const read = useQueryOp({ project, op: "get", input: { refs: [`result:${result}`] } });
	const parsed = SampleResult.safeParse(read.data?.[0]);
	if (read.isPending || read.isPlaceholderData) return <p className="dim">Reading the sample result…</p>;
	if (read.error || !parsed.success || parsed.data.id !== result)
		return <p className="dim">The sample result could not be read.</p>;
	const sample = parsed.data;
	const build = webUrl(sample.build);
	return (
		<>
			{sample.detail && (
				<details>
					<summary>Diagnostic detail</summary>
					<pre className="queue-log">{sample.detail}</pre>
				</details>
			)}
			{sample.note && <p>{sample.note}</p>}
			{build && (
				<a href={build} target="_blank" rel="noreferrer noopener">
					build
				</a>
			)}
			<ResultTrail result={result} steps={sample.steps} />
			<ResultAttachments result={result} />
		</>
	);
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
					<li key={`${sample.first.id}:${sample.first.try ?? ""}:${sample.second.id}:${sample.second.try ?? ""}`}>
						{sample.location ? <ResultLocation location={sample.location} /> : sample.commit.slice(0, 12)} ·{" "}
						{sample.job || "unnamed job"} · {sample.env || "default environment"} · producer {sample.actor}: result{" "}
						{sample.first.id} ({observed(sample.first)}) to result {sample.second.id} ({observed(sample.second)})
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
					{full && evidence.sample != null && <SampleEvidence result={evidence.sample} />}
					<div className="dim">
						{evidence.location ? (
							<ResultLocation location={evidence.location} />
						) : (
							<>
								{evidence.target} · {evidence.branch ?? evidence.scope}
							</>
						)}{" "}
						· {evidence.count} {evidence.count === 1 ? "test shares" : "tests share"} this cause
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
								<RefLink refValue={test.t} /> {test.name} {test.case && <RefLink refValue={test.case} />}
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
