import { useMemo, useRef, useState } from "react";
import { z } from "zod";
import { printCase } from "../../core/markdown.ts";
import { applyMergeChoice } from "../../core/merge3.ts";
import {
	Automate,
	type CaseBody,
	type ConflictAddress,
	conflictLabel,
	type ExpandedStep,
	METHOD_LABELS,
} from "../../core/model.ts";
import type { QuestionItem } from "../../core/ops.ts";
import { call } from "../lib/api.ts";
import { invalidateProject, queryClient, queryKey, useQueryOp } from "../lib/data.ts";
import { deviceSession, sessionCurrent } from "../lib/device.ts";
import type { DraftCopy } from "../lib/draft-copies.ts";
import { type Draft, type DraftConflict, draftTags } from "../lib/drafts.ts";
import { answerShown, proposalReadMessage } from "../lib/proposals.ts";
import { navigate, refUrl } from "../lib/router.ts";
import { ProposalEdits } from "../queue/evidence.tsx";
import { takes } from "../queue/selection.ts";
import { bodyOf, CaseView, editDraft } from "../suite/model.ts";
import { AnswerExtra } from "../ui/answer-extra.tsx";
import { ResultAttachments } from "../ui/attachments.tsx";
import { useApp } from "../ui/context.tsx";
import { age, DiffView, EmptyState, KeyCap, ProducerGlyph, SectionHeading, Select } from "../ui/index.tsx";
import { useCaseBindings } from "./bindings.ts";
import { BodyEditor, conflictEditorStatus, type DraftChange, draftEndedStatus, ownershipStatus } from "./editor.tsx";
import { FragmentUsers } from "./fragments.tsx";

export type ConflictState = DraftConflict;
const EntryBase = z.object({ seq: z.number(), at: z.number(), by: z.string() });
const Entry = z.discriminatedUnion("t", [
	EntryBase.extend({
		t: z.literal("version"),
		version: z.number(),
		kind: z.string(),
		reason: z.string().nullable(),
		summary: z.string(),
	}),
	EntryBase.extend({ t: z.literal("placement"), kind: z.string(), what: z.string() }),
	EntryBase.extend({
		t: z.literal("result"),
		model: z.string().nullable(),
		id: z.number(),
		outcome: z.string(),
		method: z.string(),
		basis: z.string(),
		version: z.number().nullable(),
		name: z.string().nullable(),
		note: z.string().nullable(),
		message: z.string().nullable(),
	}),
	EntryBase.extend({
		t: z.literal("finding"),
		kind: z.string(),
		on: z.string(),
		category: z.string(),
		note: z.string(),
		lens: z.string(),
	}),
	EntryBase.extend({
		t: z.literal("review"),
		kind: z.string(),
		lens: z.string(),
		version: z.number(),
		about: z.string().nullable(),
	}),
]);
type Entry = z.infer<typeof Entry>;
type VersionEntry = Extract<Entry, { t: "version" }>;
type TimelineGroup =
	| { kind: "versions"; entries: VersionEntry[] }
	| { kind: "entry"; entry: Exclude<Entry, { t: "version" }> };
function grouped(entries: Entry[]): TimelineGroup[] {
	const groups: TimelineGroup[] = [];
	for (const entry of entries) {
		const previous = groups.at(-1);
		if (entry.t === "version") {
			const latest = previous?.kind === "versions" ? previous.entries.at(-1) : null;
			if (previous?.kind === "versions" && latest && latest.by === entry.by && latest.at - entry.at <= 600_000)
				previous.entries.push(entry);
			else groups.push({ kind: "versions", entries: [entry] });
		} else groups.push({ kind: "entry", entry });
	}
	return groups;
}

export function CasePane({
	view,
	draft,
	stored,
	change,
	begin,
	seal,
	rapid,
	conflict,
	onResolved,
	onConflictChange,
	hasDraft = false,
	ownedElsewhere = false,
	ownerLive = true,
	ending = null,
	onTakeOver,
	copies,
	onDiscardCopy,
}: {
	view: CaseView | null;
	draft: Draft | null;
	stored: boolean;
	change: DraftChange;
	begin: (field?: string) => void;
	seal: () => void;
	rapid: () => void;
	conflict: ConflictState | null;
	onResolved: (state: ConflictState, body: CaseBody) => Promise<void>;
	onConflictChange: (state: ConflictState) => void;
	hasDraft?: boolean;
	ownedElsewhere?: boolean;
	/** Whether the window that owns the draft shown has answered this one (`draftOwnerIsLive`). */
	ownerLive?: boolean;
	/** The other window has removed the draft shown: the case is being read, or could not be. */
	ending?: keyof typeof draftEndedStatus | null;
	onTakeOver: () => void;
	copies: DraftCopy[];
	onDiscardCopy: (copy: DraftCopy) => void;
}) {
	const { project, session, setStatus } = useApp();
	const elsewhereStatus = ending ? draftEndedStatus[ending] : ownershipStatus(ownerLive);
	const owner = useRef(deviceSession()).current;
	const ref = draft?.ref ?? view?.ref ?? null;
	const timelineInput = { ref: ref ?? "C-0", limit: 100 };
	const timeline = useQueryOp({ project, op: "timeline", input: timelineInput, enabled: ref !== null });
	const timelineData = timeline.data?.ref === ref ? timeline.data : undefined;
	const entries = useMemo(() => z.array(Entry).parse(timelineData?.entries ?? []), [timelineData]);
	const groups = useMemo(() => grouped(entries), [entries]);
	const [diffVersion, setDiffVersion] = useState<number | null>(null);
	const [pendingAnswer, setPendingAnswer] = useState<{
		question: QuestionItem;
		answer: "accept" | "reject";
		value: string;
	} | null>(null);
	// A diff belongs to the case it was opened on. The pane stays mounted across a change of case, so it closes
	// the diff while rendering the first frame of the next one, before the card could read that case's versions.
	const [diffOf, setDiffOf] = useState(ref);
	if (diffOf !== ref) {
		setDiffOf(ref);
		setDiffVersion(null);
		setPendingAnswer(null);
	}
	const proposals = timelineData?.questions.filter((q) => q.kind === "adopt" && q.state === "open") ?? [];
	const pendingQuestion = timelineData?.questions.find((q) => q.q === pendingAnswer?.question.q);
	if (pendingAnswer && pendingQuestion && pendingQuestion.state !== "open") setPendingAnswer(null);
	async function answerProposal(answer: "accept" | "reject", question = proposals[0], reason?: string): Promise<void> {
		if (!question) return;
		const message = proposalReadMessage(question.q);
		if (message) {
			setStatus(message);
			return;
		}
		if (question.needs.includes("with a reason") && !reason) {
			setPendingAnswer({ question, answer, value: "" });
			return;
		}
		const key = queryKey({ project, op: "timeline", input: timelineInput });
		const restoreQuestion = (): void => {
			queryClient.setQueryData<typeof timeline.data>(key, (current) =>
				current && !current.questions.some((q) => q.q === question.q)
					? { ...current, questions: [...current.questions, question] }
					: current,
			);
		};
		queryClient.setQueryData<typeof timeline.data>(key, (previous) =>
			previous ? { ...previous, questions: previous.questions.filter((q) => q.q !== question.q) } : previous,
		);
		try {
			const reply = await call(
				"decide",
				{
					q: question.q,
					onEvidence: question.evidenceHash,
					ifOpen: true,
					answer: { is: answer },
					...(reason ? { reason } : {}),
				},
				{ project, owner },
			);
			if (reply[0]?.status !== "decided" && reply[0]?.status !== "already") {
				restoreQuestion();
				setStatus(
					reply[0]?.status === "conflict"
						? reply[0].needs === "the question is no longer open; read it again before answering"
							? "This proposal was settled meanwhile. Read its current decision before answering."
							: "The evidence changed. Read the new proposal before answering."
						: (reply[0]?.needs ?? "This proposal needs a person."),
				);
			} else {
				setPendingAnswer(null);
				setStatus(`${question.q} ${answer === "accept" ? "adopted" : "rejected"}. The author remains recorded.`);
			}
		} catch (error) {
			if (!sessionCurrent(owner)) return;
			restoreQuestion();
			setStatus(error instanceof Error ? error.message : "The answer failed");
		} finally {
			if (sessionCurrent(owner)) void invalidateProject(project);
		}
	}
	/** Shows what a version changed. The first has none before it, and the status line says so. */
	function openDiff(to: number): void {
		if (to > 1) setDiffVersion(to);
		else if (ref) setStatus(`Version 1 of ${ref} is the first. There is no earlier version to compare it with.`);
		else setStatus("This case has no version yet. There is nothing to compare.");
	}
	useCaseBindings({
		enabled: ref !== null,
		canAccept: pendingAnswer === null && Boolean(proposals[0] && takes(proposals[0], "accept")),
		canReject: pendingAnswer === null && Boolean(proposals[0] && takes(proposals[0], "reject")),
		diff: () => openDiff(draft?.base ?? view?.version ?? 1),
		accept: () => answerVisibleProposal("accept", "key"),
		reject: () => answerVisibleProposal("reject", "key"),
	});
	function answerVisibleProposal(answer: "accept" | "reject", via: "key" | "button", question = proposals[0]): void {
		if (!question || pendingAnswer || !takes(question, answer)) return;
		const message = answerShown(question.q, answer, via);
		if (message) setStatus(message);
		else void answerProposal(answer, question);
	}
	if (!view && !draft)
		return (
			<section className="pane" id="detail">
				<EmptyState>Select a case to read its steps and evidence. Press c to start a new one.</EmptyState>
			</section>
		);
	const body = draft?.body ?? (view ? bodyOf(view) : null);
	if (!body) return null;
	const version = draft?.base ?? view?.version ?? 0;
	const versionEntry = entries.find((entry) => entry.t === "version" && entry.version === version);
	return (
		<section className="pane" id="detail">
			<div className="pane-scroll">
				<div className="detail-body">
					<div className="cmeta">
						<span className="cid">{ref ?? "New case"}</span>
						<span className="path">{draft?.folder || view?.folder.path || "All cases"}</span>
					</div>
					<div className={`cstate capture-state ${draft?.dirty || draft?.ref === null ? "draft" : ""}`}>
						<span className={`chip ${draft?.dirty || draft?.ref === null ? "draft" : "ver"}`}>
							{draft?.dirty || draft?.ref === null ? "Draft" : `v${version}`}
						</span>
						<span className="sv">
							{draft?.submission.kind === "waiting" ? (
								<>
									Proposed, waiting for a person ·{" "}
									<a
										href={refUrl({ project, ref: draft.submission.question })}
										onClick={(event) => {
											event.preventDefault();
											navigate(
												refUrl({ project, ref: draft.submission.kind === "waiting" ? draft.submission.question : "" }),
											);
										}}
									>
										{draft.submission.question}
									</a>
								</>
							) : draft?.dirty || draft?.ref === null ? (
								stored ? (
									"Draft, saved on this device"
								) : (
									"Draft, kept in this tab"
								)
							) : versionEntry ? (
								`Version ${version}, by ${versionEntry.by === session.actor ? "you" : versionEntry.by}, ${age(versionEntry.at)}`
							) : (
								`Version ${version}, current`
							)}
						</span>
						{draft && (draft.dirty || draft.ref === null || draft.submission.kind === "waiting") && (
							<span className="draft-public-state">
								{draft.ref === null ? "Private, no version yet" : `Others see version ${view?.version ?? draft.base}`}
							</span>
						)}
						{!draft && hasDraft && (
							<span className="draft-public-state">Draft kept on this device. Press e to continue.</span>
						)}
					</div>
					{ownedElsewhere && (
						<div role="status">
							<p>{elsewhereStatus}</p>
							{ending !== "reading" && (
								<button type="button" onClick={onTakeOver}>
									{ending ? "Read the case again" : "Take over here"}
								</button>
							)}
						</div>
					)}
					{copies.map(({ draft: copy, key, stored: copyStored }) => (
						<details className="preserved-draft" key={key} open>
							<summary>Preserved text</summary>
							<p>
								This text was accepted in a window that lost ownership. Copy any text you need before discarding it.
							</p>
							{!copyStored && <p>Device storage is full. Keep this tab open until you have copied this text.</p>}
							<p>Folder: {copy.folder || "All cases"}</p>
							<textarea
								aria-label="Preserved draft text"
								readOnly
								value={printCase({ ref: copy.ref, body: copy.body, tags: draftTags(copy), covers: copy.covers })}
							/>
							{copy.conflict && (
								<textarea
									aria-label="Preserved merge text"
									readOnly
									value={printCase({
										ref: copy.ref,
										body: copy.conflict.merged,
										tags: draftTags(copy),
										covers: copy.covers,
									})}
								/>
							)}
							<button type="button" onClick={() => onDiscardCopy({ key, draft: copy, stored: copyStored })}>
								Discard preserved copy
							</button>
						</details>
					))}
					{conflict && (
						<ConflictCard
							key={conflict.q}
							state={conflict}
							resolved={onResolved}
							changed={onConflictChange}
							readOnlyStatus={ownedElsewhere ? elsewhereStatus : null}
						/>
					)}
					{draft ? (
						<BodyEditor
							draft={draft}
							tags={draftTags({ ...draft, originalTags: view?.tags ?? draft.originalTags })}
							change={change}
							seal={seal}
							rapid={rapid}
							readOnlyStatus={ownedElsewhere ? elsewhereStatus : conflict ? conflictEditorStatus : null}
						/>
					) : (
						<ReadBody body={{ ...body, steps: view?.steps ?? body.steps }} tags={view?.tags ?? []} begin={begin} />
					)}
					{!draft && view?.kind === "fragment" && <FragmentUsers key={view.ref} view={view} />}
					<CaseProperties
						body={body}
						readOnly={ownedElsewhere || Boolean(conflict)}
						change={(next) => {
							const base = draft ?? (view ? editDraft(view) : null);
							if (base)
								change({
									...base,
									body: next,
									dirty: true,
									caret: draft?.caret ?? { field: "properties", start: 0, end: 0 },
								});
						}}
					/>
					<section className="proof-block">
						<SectionHeading>Proof</SectionHeading>
						{(["human", "auto", "agent"] satisfies (keyof CaseView["proof"])[]).map((method) => {
							const proof = view?.proof[method];
							const latest = entries.find((entry) => entry.t === "result" && entry.method === method);
							const result = latest?.t === "result" ? latest : null;
							const mark = !proof
								? "·"
								: proof.outcome === "pass"
									? proof.current
										? "✓"
										: "~"
									: proof.outcome === "fail" || proof.outcome === "error"
										? "✗"
										: "·";
							return (
								<div
									className={`prow ${mark === "✓" ? "ps" : mark === "✗" ? "fl" : mark === "~" ? "st2" : "nv"}`}
									key={method}
								>
									<ProducerGlyph kind={method} />
									<span className="m">{mark}</span>
									<span className="pt">
										{method === "human" ? "person" : method === "auto" ? "pipeline" : "agent"} ·{" "}
										{proof
											? `${proof.outcome} on v${result?.version ?? version} · basis ${proof.basis}${result ? ` · ${result.by}${result.model ? ` · ${result.model}` : ""}${result.name ? ` · ${result.name}` : ""}` : ""}`
											: "no result yet"}
									</span>
									<span className="age">{proof ? age(proof.at) : ""}</span>
								</div>
							);
						})}
					</section>
					<section className="timeline-block">
						<div className="history-title">
							<SectionHeading>Timeline</SectionHeading>
							<button type="button" onClick={() => openDiff(version)}>
								<KeyCap>v</KeyCap> diff another version
							</button>
						</div>
						{draft?.dirty && (
							<div className="ev draft">
								<span>•</span>
								<div>
									Your private draft. {draft.base ? `Based on version ${draft.base}.` : "No version yet."}
									<DiffView
										before={draft.original}
										after={{ ...draft.body, steps: draft.body.steps.filter((step) => step.use || step.action) }}
									/>
								</div>
							</div>
						)}
						{proposals.map((question) => (
							<ProposalCard
								key={question.q}
								question={question}
								disabled={pendingAnswer !== null}
								answer={(answer) => answerVisibleProposal(answer, "button", question)}
							/>
						))}
						{diffVersion && ref && <VersionDiff refName={ref} to={diffVersion} close={() => setDiffVersion(null)} />}{" "}
						{groups.map((group) =>
							group.kind === "versions" ? (
								group.entries.length > 1 ? (
									<details className="timeline-group" key={`versions:${group.entries[0]?.seq}`}>
										<summary>
											<ProducerGlyph kind={group.entries[0]?.kind ?? "human"} />
											<span className={group.entries[0]?.kind === "agent" ? "agentv" : ""}>
												<ProducerGlyph kind={group.entries[0]?.kind ?? "human"} />{" "}
												<span className={group.entries[0]?.kind === "agent" ? "agentv" : ""}>
													{group.entries.length} versions by {group.entries[0]?.by}
													{group.entries[0]?.kind === "agent" ? " · agent" : ""}
												</span>
												{group.entries[0]?.kind === "agent" ? " · agent" : ""} ·{" "}
												{age(group.entries[0]?.at ?? Date.now())}
											</span>
										</summary>
										{group.entries.map((entry) => (
											<VersionRow key={entry.seq} entry={entry} diff={() => openDiff(entry.version)} />
										))}
									</details>
								) : (
									group.entries.map((entry) => (
										<VersionRow key={entry.seq} entry={entry} diff={() => openDiff(entry.version)} />
									))
								)
							) : (
								<TimelineRow
									key={`${group.entry.t}:${group.entry.seq}:${group.entry.t === "result" ? group.entry.id : group.entry.t === "finding" ? `${group.entry.on}:${group.entry.note}` : group.entry.by}`}
									entry={group.entry}
								/>
							),
						)}
						{timelineData?.questions
							.filter((q) => q.kind !== "adopt" || q.state !== "open")
							.map((q) => {
								const decision = q.decision?.supersedes ?? q.decision;
								return (
									<a
										className="question-card"
										key={q.q}
										href={refUrl({ project, ref: q.q })}
										onClick={(event) => {
											event.preventDefault();
											navigate(refUrl({ project, ref: q.q }));
										}}
									>
										<ProducerGlyph kind={q.producer} /> {q.q} · {q.title}{" "}
										<span className="dim">
											{decision
												? `· ${String(decision.answer.is)} by ${decision.rule ? `rule ${decision.rule}` : decision.by.join(", ")}`
												: `· ${q.state}`}
										</span>
										{q.decision?.supersedes && (
											<p>
												Ended by {q.decision.rule ? `rule ${q.decision.rule}` : q.decision.by.join(", ")}
												{q.decision.reason && ` · ${q.decision.reason}`}
											</p>
										)}
										{q.decision?.trackerError && (
											<p role="status" className="hintbox">
												{q.decision.trackerError}
											</p>
										)}
									</a>
								);
							})}
						{entries.length === 0 && (
							<div className="nosteps">Your first version appears here when you leave the case.</div>
						)}
					</section>
				</div>
			</div>
			{pendingAnswer && (
				<AnswerExtra
					kind="answer"
					label={`${pendingAnswer.answer === "accept" ? "Accept" : "Reject"}: reason required by policy`}
					field="reason"
					value={pendingAnswer.value}
					onChange={(value) => setPendingAnswer({ ...pendingAnswer, value })}
					onCancel={() => setPendingAnswer(null)}
					onSubmit={(reason) => void answerProposal(pendingAnswer.answer, pendingAnswer.question, reason)}
				/>
			)}
		</section>
	);
}
function ReadBody({
	body,
	tags,
	begin,
}: {
	body: Omit<CaseBody, "steps"> & { steps: ExpandedStep[] };
	tags: string[];
	begin: (field?: string) => void;
}) {
	return (
		<div className="read-body">
			<button type="button" className="ctitle" onClick={() => begin()}>
				{body.title || "Untitled case"}
			</button>
			<div className="ctags">
				{tags.map((tag) => (
					<span key={tag}>#{tag}</span>
				))}
			</div>
			{body.pre && (
				<>
					<SectionHeading>Preconditions</SectionHeading>
					<button type="button" className="pre-input" onClick={() => begin("pre")}>
						{body.pre}
					</button>
				</>
			)}
			<SectionHeading>Steps</SectionHeading>
			{body.steps.map((step, index) => (
				<div className={`st ${step.expected ? "hasx" : ""}`} key={step.id}>
					<span className="sn">{index + 1}</span>
					<div>
						<button type="button" className="stx" onClick={() => begin(`${step.source?.use ?? step.id}:action`)}>
							{step.action}
						</button>
						{step.source && (
							<div className="dim">
								From {step.source.fragment} v{step.source.version}
							</div>
						)}
						{step.expected && (
							<div className="sxw">
								<span className="gt">&gt;</span>
								<button type="button" className="sex" onClick={() => begin(`${step.source?.use ?? step.id}:expected`)}>
									{step.expected}
								</button>
							</div>
						)}
					</div>
				</div>
			))}
			{body.steps.length === 0 && <div className="nosteps">No steps yet. Press e and start typing.</div>}
			<div className="hintl">
				<KeyCap>e</KeyCap> edit in place <KeyCap>↵</KeyCap> next step <KeyCap>Tab</KeyCap> expected result
			</div>
		</div>
	);
}
function VersionRow({ entry, diff }: { entry: VersionEntry; diff: () => void }) {
	return (
		<button
			type="button"
			data-version={entry.version}
			className={`ev v ${entry.kind === "agent" ? "prop" : ""}`}
			onClick={diff}
		>
			<ProducerGlyph kind={entry.kind} />
			<span>
				<b className={entry.kind === "agent" ? "agentv" : ""}>
					v{entry.version} · {entry.by}
					{entry.kind === "agent" ? " · agent" : ""}
				</b>
				<span className="why"> · {entry.summary}</span>
				{entry.reason && <span className="why"> · {entry.reason}</span>}
			</span>
			<span className="age">{age(entry.at)}</span>
		</button>
	);
}
function TimelineRow({ entry }: { entry: Exclude<Entry, { t: "version" }> }) {
	const kind = entry.t === "result" ? entry.method : entry.kind;
	let text = "";
	switch (entry.t) {
		case "placement":
			text = entry.what;
			break;
		case "finding":
			text = `${entry.category}: ${entry.note} · ${entry.on}`;
			break;
		case "review":
			text = `Reviewed v${entry.version} · ${entry.lens}`;
			break;
		case "result":
			text = `${entry.outcome} on v${entry.version ?? "?"} · basis ${entry.basis}${entry.note || entry.message ? ` · ${entry.note ?? entry.message}` : ""}`;
			break;
		default: {
			const exhaustive: never = entry;
			return exhaustive;
		}
	}
	return (
		<div className={`ev ${kind === "agent" ? "prop" : ""}`}>
			<ProducerGlyph kind={kind} />
			<div>
				<b className={kind === "agent" ? "agentv" : ""}>
					{entry.by}
					{entry.t === "result" && entry.model && ` · ${entry.model}`}
					{kind === "agent" ? " · agent" : ""}
				</b>{" "}
				<span className="why">{text}</span>
				{entry.t === "result" && <ResultAttachments result={entry.id} />}
			</div>
			<span className="age">{age(entry.at)}</span>
		</div>
	);
}
function VersionDiff({ refName, to, close }: { refName: string; to: number; close: () => void }) {
	const { project } = useApp();
	const from = Math.max(1, to - 1);
	const history = useQueryOp({ project, op: "history", input: { ref: refName, from, to } });
	const before = useQueryOp({ project, op: "get", input: { refs: [refName], version: from } });
	const after = useQueryOp({ project, op: "get", input: { refs: [refName], version: to } });
	const a = CaseView.safeParse(before.data?.[0]);
	const b = CaseView.safeParse(after.data?.[0]);
	return (
		<div className="question-card">
			<div className="history-title">
				<b>
					v{from} → v{to} · {typeof history.data?.summary === "string" ? history.data.summary : "Version diff"}
				</b>
				<button type="button" onClick={close}>
					Close
				</button>
			</div>
			{a.success && b.success && <DiffView before={bodyOf(a.data)} after={bodyOf(b.data)} />}
		</div>
	);
}
/** A proposal in a case's timeline. It may change other cases too, and accepting it accepts all of it: it shows all. */
function ProposalCard({
	question,
	answer,
	disabled,
}: {
	question: QuestionItem;
	answer: (is: "accept" | "reject") => void;
	disabled: boolean;
}) {
	return (
		<div className={`ev ${question.producer === "agent" ? "prop" : ""}`} data-proposal={question.q}>
			<ProducerGlyph kind={question.producer} />
			<div>
				<b className={question.producer === "agent" ? "agentv" : ""}>
					{question.q} · {typeof question.evidence.author === "string" ? question.evidence.author : "author"}
					{question.producer === "agent" ? " · agent" : ""}
				</b>
				<p className="why">
					Proposed, waiting for a person.{" "}
					{typeof question.evidence.reason === "string" ? question.evidence.reason : question.title}
				</p>
				<ProposalEdits question={question} />
				<div className="pbtn">
					{takes(question, "accept") && (
						<button type="button" className="out" disabled={disabled} onClick={() => answer("accept")}>
							<KeyCap>a</KeyCap> Accept
						</button>
					)}
					{takes(question, "reject") && (
						<button type="button" className="out" disabled={disabled} onClick={() => answer("reject")}>
							<KeyCap>r</KeyCap> Reject
						</button>
					)}
				</div>
			</div>
			<span className="age">{age(question.openedAt)}</span>
		</div>
	);
}

function ConflictCard({
	state,
	resolved,
	changed,
	readOnlyStatus,
}: {
	state: ConflictState;
	resolved: (state: ConflictState, body: CaseBody) => Promise<void>;
	changed: (state: ConflictState) => void;
	readOnlyStatus: string | null;
}) {
	const { setStatus } = useApp();
	const pendingStatus = "Wait for the merge reply before editing the card. Your merge is kept.";
	const [resolving, setResolving] = useState(false);
	const refusal = readOnlyStatus ?? (resolving ? pendingStatus : null);
	const body = state.merged;
	function choose(address: ConflictAddress, source: CaseBody, side?: "mine" | "current"): void {
		if (refusal) {
			setStatus(refusal);
			return;
		}
		const stepOrder = address.kind === "step-order" ? side : state.stepOrder;
		changed({
			...state,
			stepOrder,
			merged: applyMergeChoice({
				merged: body,
				source,
				address,
				order: stepOrder ? state[stepOrder].steps : undefined,
			}),
		});
	}
	const fields: { key: string; mine: string; current: string; value: string; set: (text: string) => void }[] = [];
	for (const address of state.addresses) {
		if (address.kind === "field" && (address.name === "title" || address.name === "pre")) {
			const name = address.name;
			fields.push({
				key: conflictLabel(address),
				mine: state.mine[name],
				current: state.current[name],
				value: body[name],
				set: (text) => choose(address, { ...state.mine, [name]: text }),
			});
		} else if (address.kind === "step-field") {
			const { id, name } = address;
			fields.push({
				key: conflictLabel(address),
				mine: state.mine.steps.find((step) => step.id === id)?.[name] ?? "",
				current: state.current.steps.find((step) => step.id === id)?.[name] ?? "",
				value: body.steps.find((step) => step.id === id)?.[name] ?? "",
				set: (text) =>
					choose(address, {
						...state.mine,
						steps: state.mine.steps.map((step) =>
							step.id === id
								? name === "action"
									? { ...step, action: text }
									: { ...step, expected: text || null }
								: step,
						),
					}),
			});
		}
	}
	const membership = state.addresses.filter((address) => address.kind === "step-order" || address.kind === "step");

	async function resolve(): Promise<void> {
		if (refusal) {
			setStatus(refusal);
			return;
		}
		setResolving(true);
		try {
			await resolved(state, body);
		} finally {
			setResolving(false);
		}
	}
	return (
		<section className="conflict-card" aria-label="Edit conflict">
			<h3>Both edits are kept</h3>
			<div className="dim">
				{state.ref} changed while you were writing. Choose or edit each field, then record the merge.
			</div>
			{resolving && <p role="status">{pendingStatus}</p>}
			<DiffView before={state.current} after={state.mine} />
			{fields.map((field) => (
				<div className="conflict-field" key={field.key}>
					<b>{field.key}</b>
					<div className="conflict-sides">
						<div className="conflict-side">
							<h4>Your draft</h4>
							<div>{field.mine}</div>
							<button type="button" className="out" disabled={Boolean(refusal)} onClick={() => field.set(field.mine)}>
								Use my {field.key}
							</button>
						</div>
						<div className="conflict-side">
							<h4>Current version</h4>
							<div>{field.current}</div>
							<button
								type="button"
								className="out"
								disabled={Boolean(refusal)}
								onClick={() => field.set(field.current)}
							>
								Use current {field.key}
							</button>
						</div>
					</div>
					<label>
						Edit merged {field.key}
						<textarea
							aria-label={`Merged ${field.key}`}
							readOnly={Boolean(refusal)}
							onKeyDown={(event) => {
								if (refusal && (event.key.length === 1 || ["Enter", "Backspace", "Delete"].includes(event.key))) {
									event.preventDefault();
									setStatus(refusal);
								}
							}}
							onBeforeInput={(event) => {
								if (refusal) {
									event.preventDefault();
									setStatus(refusal);
								}
							}}
							onPaste={(event) => {
								if (refusal) {
									event.preventDefault();
									setStatus(refusal);
								}
							}}
							onCut={(event) => {
								if (refusal) {
									event.preventDefault();
									setStatus(refusal);
								}
							}}
							value={field.value}
							onChange={(event) => field.set(event.target.value)}
						/>
					</label>
				</div>
			))}
			{membership.map((address) => (
				<div className="conflict-field" key={JSON.stringify(address)}>
					<b>{conflictLabel(address)}</b>
					<div className="conflict-sides">
						{[
							{ label: "Your draft", side: state.mine },
							{ label: "Current version", side: state.current },
						].map(({ label, side }) => (
							<div className="conflict-side" key={label}>
								<h4>{label}</h4>
								<p>
									{address.kind === "step-order"
										? side.steps.map((step) => step.action).join(" → ")
										: (side.steps.find((step) => step.id === address.id)?.action ?? "Step removed")}
								</p>
								<button
									type="button"
									className="out"
									disabled={Boolean(refusal)}
									onClick={() => choose(address, side, label === "Your draft" ? "mine" : "current")}
								>
									Use {label.toLowerCase()} {address.kind === "step-order" ? "order" : "step"}
								</button>
							</div>
						))}
					</div>
				</div>
			))}

			<div className="conflict-actions">
				<button
					type="button"
					disabled={Boolean(refusal)}
					onClick={() => changed({ ...state, merged: state.mine, stepOrder: undefined })}
				>
					Use all my changes
				</button>
				<button
					type="button"
					disabled={Boolean(refusal)}
					onClick={() => changed({ ...state, merged: state.current, stepOrder: undefined })}
				>
					Keep current version
				</button>
				<button
					type="button"
					disabled={Boolean(refusal)}
					onClick={() => {
						void resolve();
					}}
				>
					Resolve conflict
				</button>
			</div>
		</section>
	);
}

function CaseProperties({
	body,
	change,
	readOnly = false,
}: {
	body: CaseBody;
	change: (body: CaseBody) => void;
	readOnly?: boolean;
}) {
	return (
		<details className="case-properties">
			<summary>
				Can be exercised by{" "}
				{body.methods
					.map((kind) => (kind === "human" ? "people" : kind === "auto" ? "the pipeline" : "agents"))
					.join(", ")}
			</summary>
			<div className="case-methods">
				{(["human", "auto", "agent"] satisfies CaseBody["methods"]).map((kind) => (
					<label key={kind}>
						<input
							type="checkbox"
							checked={body.methods.includes(kind)}
							disabled={readOnly || (body.methods.length === 1 && body.methods.includes(kind))}
							onChange={(event) =>
								change({
									...body,
									methods: event.target.checked
										? [...body.methods, kind]
										: body.methods.filter((item) => item !== kind),
								})
							}
						/>
						<ProducerGlyph kind={kind} />
						{METHOD_LABELS[kind]}
					</label>
				))}
			</div>
			<label className="automation-intent">
				Automation{" "}
				<Select
					value={body.automate}
					disabled={readOnly}
					onChange={(event) => {
						change({ ...body, automate: Automate.parse(event.target.value) });
					}}
				>
					<option value="none">Not requested</option>
					<option value="wanted">Wanted</option>
					<option value="not-applicable">Not applicable</option>
				</Select>
			</label>
			<div className="hintl">An agent's evidence counts only when the run admits it too.</div>
		</details>
	);
}
