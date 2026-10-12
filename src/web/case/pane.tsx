import { useMemo, useRef, useState } from "react";
import { z } from "zod";
import { mergeBodies } from "../../core/merge3.ts";
import { Automate, CaseBody } from "../../core/model.ts";
import type { QuestionItem } from "../../core/ops.ts";
import { call } from "../lib/api.ts";
import { invalidateProject, queryClient, queryKey, useQueryOp } from "../lib/data.ts";
import { deviceSession, sessionCurrent } from "../lib/device.ts";
import type { Draft } from "../lib/drafts.ts";
import { proposalReadMessage } from "../lib/proposals.ts";
import { navigate, refUrl } from "../lib/router.ts";
import { bodyOf, CaseView, editDraft } from "../suite/model.ts";
import { useApp } from "../ui/context.tsx";
import { age, DiffView, EmptyState, KeyCap, ProducerGlyph, SectionHeading } from "../ui/index.tsx";
import { useCaseBindings } from "./bindings.ts";
import { BodyEditor, type DraftChange } from "./editor.tsx";

export type ConflictState = {
	q: string;
	ref: string;
	mine: CaseBody;
	current: CaseBody;
	merged: CaseBody;
	paths: string[];
	draftId: string;
};
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
	hasDraft = false,
}: {
	view: CaseView | null;
	draft: Draft | null;
	stored: boolean;
	change: DraftChange;
	begin: (field?: string) => void;
	seal: () => void;
	rapid: () => void;
	conflict: ConflictState | null;
	onResolved: (state: ConflictState, body: CaseBody) => void;
	hasDraft?: boolean;
}) {
	const { project, session, setStatus, overlayOpen } = useApp();
	const owner = useRef(deviceSession()).current;
	const ref = draft?.ref ?? view?.ref ?? null;
	const timelineInput = { ref: ref ?? "C-0", limit: 100 };
	const timeline = useQueryOp({ project, op: "timeline", input: timelineInput, enabled: ref !== null });
	const timelineData = timeline.data?.ref === ref ? timeline.data : undefined;
	const entries = useMemo(() => z.array(Entry).parse(timelineData?.entries ?? []), [timelineData]);
	const groups = useMemo(() => grouped(entries), [entries]);
	const [diffVersion, setDiffVersion] = useState<number | null>(null);
	const proposals = timelineData?.questions.filter((q) => q.kind === "adopt" && q.state === "open") ?? [];
	async function answerProposal(answer: "accept" | "reject", question = proposals[0]): Promise<void> {
		if (!question) return;
		const message = proposalReadMessage(question.q);
		if (message) {
			setStatus(message);
			return;
		}
		const key = queryKey({ project, op: "timeline", input: timelineInput });
		const before = queryClient.getQueryData(key);
		queryClient.setQueryData<typeof timeline.data>(key, (previous) =>
			previous ? { ...previous, questions: previous.questions.filter((q) => q.q !== question.q) } : previous,
		);
		try {
			const reply = await call(
				"decide",
				{ q: question.q, onEvidence: question.evidenceHash, answer: { is: answer } },
				{ project, owner },
			);
			if (reply[0]?.status !== "decided" && reply[0]?.status !== "already") {
				queryClient.setQueryData(key, before);
				setStatus(
					reply[0]?.status === "conflict"
						? "The evidence changed. Read the new proposal before answering."
						: (reply[0]?.needs ?? "This proposal needs a person."),
				);
			} else {
				setStatus(`${question.q} ${answer === "accept" ? "adopted" : "rejected"}. The author remains recorded.`);
			}
			void invalidateProject(project);
		} catch (error) {
			if (!sessionCurrent(owner)) return;
			queryClient.setQueryData(key, before);
			setStatus(error instanceof Error ? error.message : "The answer failed");
		}
	}
	useCaseBindings({
		enabled: !overlayOpen && ref !== null,
		diff: () => {
			const version = draft?.base ?? view?.version ?? 1;
			if (version > 1) setDiffVersion(version);
		},
		accept: () => answerByKey("accept"),
		reject: () => answerByKey("reject"),
	});
	/**
	 * A key answers only what is on the screen (decision 0011: nothing a key acts on is clipped). A proposal is
	 * never taller than the pane: its diff scrolls inside it, between its heading and its answer buttons. A press
	 * first brings the whole proposal into view, then pages through a long diff, and answers only once the end
	 * of the diff is showing. Each press that does not answer says what it did.
	 */
	function answerByKey(answer: "accept" | "reject"): void {
		const question = proposals[0];
		if (!question) return;
		const message = proposalReadMessage(question.q);
		if (message) {
			revealProposal(question.q);
			setStatus(message);
			return;
		}
		const key = answer === "accept" ? "a" : "r";
		if (!proposalInView(question.q)) {
			revealProposal(question.q);
			setStatus(`${question.q} is now in view. Read it, then press ${key} again.`);
			return;
		}
		if (pageProposal(question.q)) {
			setStatus(`${question.q} has more below: the next part is now in view. Press ${key} again.`);
			return;
		}
		void answerProposal(answer, question);
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
					{conflict && <ConflictCard key={conflict.q} state={conflict} resolved={onResolved} />}
					{draft ? (
						<BodyEditor draft={draft} change={change} seal={seal} rapid={rapid} />
					) : (
						<ReadBody body={body} tags={view?.tags ?? []} begin={begin} />
					)}
					<CaseProperties
						body={body}
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
											? `${proof.outcome} on v${result?.version ?? version} · basis ${proof.basis}${result ? ` · ${result.by}${result.name ? ` · ${result.name}` : ""}` : ""}`
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
							<button type="button" onClick={() => version > 1 && setDiffVersion(version)}>
								<KeyCap>v</KeyCap> diff another version
							</button>
						</div>
						{draft?.dirty && (
							<div className="ev draft">
								<span>•</span>
								<div>
									Your private draft. Others see version {draft.base}.
									<DiffView
										before={draft.original}
										after={{ ...draft.body, steps: draft.body.steps.filter((step) => step.action) }}
									/>
								</div>
							</div>
						)}
						{proposals.map((question) => (
							<ProposalCard
								key={question.q}
								question={question}
								current={view ? bodyOf(view) : body}
								answer={(answer) => {
									void answerProposal(answer, question);
								}}
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
											<VersionRow key={entry.seq} entry={entry} diff={() => setDiffVersion(entry.version)} />
										))}
									</details>
								) : (
									group.entries.map((entry) => (
										<VersionRow key={entry.seq} entry={entry} diff={() => setDiffVersion(entry.version)} />
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
							.map((q) => (
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
										{q.decision
											? `· ${String(q.decision.answer.is)} by ${q.decision.rule ? `rule ${q.decision.rule}` : q.decision.by.join(", ")}`
											: "· open"}
									</span>
								</a>
							))}
						{entries.length === 0 && (
							<div className="nosteps">Your first version appears here when you leave the case.</div>
						)}
					</section>
				</div>
			</div>
		</section>
	);
}
function ReadBody({ body, tags, begin }: { body: CaseBody; tags: string[]; begin: (field?: string) => void }) {
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
						<button type="button" className="stx" onClick={() => begin(`${step.id}:action`)}>
							{step.action}
						</button>
						{step.expected && (
							<div className="sxw">
								<span className="gt">&gt;</span>
								<button type="button" className="sex" onClick={() => begin(`${step.id}:expected`)}>
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
					{kind === "agent" ? " · agent" : ""}
				</b>{" "}
				<span className="why">{text}</span>
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
function ProposalCard({
	question,
	current,
	answer,
}: {
	question: QuestionItem;
	current: CaseBody;
	answer: (is: "accept" | "reject") => void;
}) {
	const { project } = useApp();
	const proposal = typeof question.evidence.proposal === "string" ? question.evidence.proposal : "P-0";
	const data = useQueryOp({ project, op: "get", input: { refs: [proposal] }, enabled: proposal !== "P-0" });
	const row = data.data?.find((item) => item.ref === proposal);
	const edits = row && Array.isArray(row.edits) ? row.edits : [];
	const body = edits
		.map((edit: unknown) =>
			z
				.object({
					body: CaseBody,
					mine: CaseBody.optional(),
					case: z.string().nullable().optional(),
					base: z.number().optional(),
				})
				.safeParse(edit),
		)
		.find((edit) => edit.success);
	const edit = body?.success ? body.data : null;
	const baseQuery = useQueryOp({
		project,
		op: "get",
		input: { refs: [edit?.case ?? "C-0"], ...(edit?.base ? { version: edit.base } : {}) },
		enabled: Boolean(edit?.case && edit.base),
	});
	const base = CaseView.safeParse(baseQuery.data?.[0]);
	const needsBase = Boolean(edit?.case && edit.base);
	const ready = Boolean(
		edit && (!needsBase || (base.success && base.data.ref === edit.case && base.data.version === edit.base)),
	);
	const error =
		data.error?.message ??
		baseQuery.error?.message ??
		(data.data && !edit ? "The proposal edits could not be read." : null);
	const proposed =
		ready && edit
			? base.success
				? mergeBodies({ base: bodyOf(base.data), mine: edit.mine ?? edit.body, theirs: current }).merged
				: (edit.mine ?? edit.body)
			: null;

	return (
		<div
			className={`ev ${question.producer === "agent" ? "prop" : ""}`}
			data-proposal={question.q}
			data-proposal-read={ready ? "ready" : error ? "error" : "loading"}
			data-proposal-error={error ?? undefined}
		>
			<ProducerGlyph kind={question.producer} />
			<div>
				<b className={question.producer === "agent" ? "agentv" : ""}>
					{question.q} · {typeof question.evidence.author === "string" ? question.evidence.author : "author"}
					{question.producer === "agent" ? " · agent" : ""}
				</b>
				<p className="why">
					Proposed, waiting for a person. {typeof row?.reason === "string" ? row.reason : question.title}
				</p>
				{!ready && <p role="status">{error ?? "Reading the proposed edits…"}</p>}
				{proposed && <DiffView before={current} after={proposed} />}
				<div className="pbtn">
					<button type="button" className="out" onClick={() => answer("accept")}>
						<KeyCap>a</KeyCap> Accept
					</button>
					<button type="button" className="out" onClick={() => answer("reject")}>
						<KeyCap>r</KeyCap> Reject
					</button>
				</div>
			</div>
			<span className="age">{age(question.openedAt)}</span>
		</div>
	);
}
const proposalCard = (q: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-proposal="${CSS.escape(q)}"]`);

/** Whether the whole of a proposal (heading, diff and answer buttons) is inside the visible part of the pane. */
function proposalInView(q: string): boolean {
	const card = proposalCard(q);
	const pane = card?.closest<HTMLElement>(".pane-scroll");
	if (!card || !pane) return false;
	const box = card.getBoundingClientRect();
	const frame = pane.getBoundingClientRect();
	const top = Math.max(frame.top, 0);
	const bottom = Math.min(frame.bottom, window.innerHeight);
	return box.top >= top - 1 && box.bottom <= bottom + 1;
}

function revealProposal(q: string): void {
	const card = proposalCard(q);
	const pane = card?.closest<HTMLElement>(".pane-scroll");
	if (!card || !pane) return;
	const box = card.getBoundingClientRect();
	const frame = pane.getBoundingClientRect();
	if (box.top < frame.top) pane.scrollTop += box.top - frame.top - 8;
	else if (box.bottom > frame.bottom)
		pane.scrollTop += Math.min(box.bottom - frame.bottom + 8, box.top - frame.top - 8);
}

/** Shows the next part of a proposal's diff when it has more below. False when its end is already showing. */
function pageProposal(q: string): boolean {
	const diff = proposalCard(q)?.querySelector<HTMLElement>(".diff");
	if (!diff || diff.scrollTop + diff.clientHeight >= diff.scrollHeight - 2) return false;
	diff.scrollTop += Math.max(40, diff.clientHeight - 32);
	return true;
}

function ConflictCard({
	state,
	resolved,
}: {
	state: ConflictState;
	resolved: (state: ConflictState, body: CaseBody) => void;
}) {
	const { project, setStatus } = useApp();
	const owner = useRef(deviceSession()).current;
	const [choices, setChoices] = useState(new Map<string, (body: CaseBody) => CaseBody>());
	const body = [...choices.values()].reduce((merged, choice) => choice(merged), state.merged);
	function choose(path: string, update: (body: CaseBody) => CaseBody): void {
		setChoices((previous) => new Map(previous).set(path, update));
	}
	const fields: { key: string; mine: string; current: string; set: (text: string) => void }[] = [
		{
			key: "title",
			mine: state.mine.title,
			current: state.current.title,
			set: (title: string) => choose("title", (previous) => ({ ...previous, title })),
		},
		{
			key: "pre",
			mine: state.mine.pre,
			current: state.current.pre,
			set: (pre: string) => choose("pre", (previous) => ({ ...previous, pre })),
		},
	].filter((field) => state.paths.includes(field.key));
	for (const mine of state.mine.steps) {
		const current = state.current.steps.find((step) => step.id === mine.id);
		for (const part of ["action", "expected"] satisfies ("action" | "expected")[]) {
			const a = mine[part] ?? "";
			const b = current?.[part] ?? "";
			if (a !== b && state.paths.includes(`steps.${mine.id}.${part}`))
				fields.push({
					key: `steps.${mine.id}.${part}`,
					mine: a,
					current: b,
					set: (text) =>
						choose(`steps.${mine.id}.${part}`, (previous) => ({
							...previous,
							steps: current
								? previous.steps.map((step) =>
										step.id === mine.id
											? part === "action"
												? { ...step, action: text }
												: { ...step, expected: text || null }
											: step,
									)
								: [...previous.steps.filter((step) => step.id !== mine.id), { ...mine, [part]: text }],
						})),
				});
		}
	}
	const membership = state.paths.filter((path) => /^steps\.[a-z0-9]+$/.test(path));
	function chooseStep(path: string, side: CaseBody): void {
		const id = path.split(".")[1];
		const step = side.steps.find((item) => item.id === id);
		choose(path, (previous) => ({
			...previous,
			steps: step
				? previous.steps.some((item) => item.id === id)
					? previous.steps.map((item) => (item.id === id ? step : item))
					: [...previous.steps, step]
				: previous.steps.filter((item) => item.id !== id),
		}));
	}

	async function resolve(): Promise<void> {
		try {
			const questions = await call("inbox", { on: state.ref, kind: "adopt" }, { project, owner });
			const question = questions.items.find((item) => item.q === state.q);
			if (!question) {
				setStatus("This conflict was answered elsewhere. Your draft is still kept.");
				return;
			}
			const reply = await call(
				"decide",
				{ q: question.q, onEvidence: question.evidenceHash, answer: { is: "merge", body } },
				{ project, owner },
			);
			if (reply[0]?.status === "decided") {
				setStatus("Conflict resolved. Both earlier versions remain in the timeline.");
				resolved(state, body);
			} else setStatus(reply[0]?.needs ?? "The evidence changed. Read both edits again.");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Conflict could not be resolved");
		}
	}
	return (
		<section className="conflict-card" aria-label="Edit conflict">
			<h3>Both edits are kept</h3>
			<div className="dim">
				{state.ref} changed while you were writing. Choose or edit each field, then record the merge.
			</div>
			<DiffView before={state.current} after={state.mine} />
			{fields.map((field) => (
				<div className="conflict-field" key={field.key}>
					<b>{field.key}</b>
					<div className="conflict-sides">
						<div className="conflict-side">
							<h4>Your draft</h4>
							<div>{field.mine}</div>
							<button type="button" className="out" onClick={() => field.set(field.mine)}>
								Use my {field.key}
							</button>
						</div>
						<div className="conflict-side">
							<h4>Current version</h4>
							<div>{field.current}</div>
							<button type="button" className="out" onClick={() => field.set(field.current)}>
								Use current {field.key}
							</button>
						</div>
					</div>
					<label>
						Edit merged {field.key}
						<textarea
							aria-label={`Merged ${field.key}`}
							value={
								field.key === "title"
									? body.title
									: field.key === "pre"
										? body.pre
										: (() => {
												const parts = field.key.split(".");
												const step = body.steps.find((item) => item.id === parts[1]);
												return parts[2] === "expected" ? (step?.expected ?? "") : (step?.action ?? "");
											})()
							}
							onChange={(event) => field.set(event.target.value)}
						/>
					</label>
				</div>
			))}
			{membership.map((path) => (
				<div className="conflict-field" key={path}>
					<b>{path}</b>
					<div className="conflict-sides">
						{[
							{ label: "Your draft", side: state.mine },
							{ label: "Current version", side: state.current },
						].map(({ label, side }) => (
							<div className="conflict-side" key={label}>
								<h4>{label}</h4>
								<p>{side.steps.find((step) => `steps.${step.id}` === path)?.action ?? "Step removed"}</p>
								<button type="button" className="out" onClick={() => chooseStep(path, side)}>
									Use {label.toLowerCase()} step
								</button>
							</div>
						))}
					</div>
				</div>
			))}

			<div className="conflict-actions">
				<button type="button" onClick={() => setChoices(new Map([["all", () => state.mine]]))}>
					Use all my changes
				</button>
				<button type="button" onClick={() => setChoices(new Map([["all", () => state.current]]))}>
					Keep current version
				</button>
				<button
					type="button"
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

function CaseProperties({ body, change }: { body: CaseBody; change: (body: CaseBody) => void }) {
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
							disabled={body.methods.length === 1 && body.methods.includes(kind)}
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
						{kind === "human" ? "Person" : kind === "auto" ? "Pipeline" : "Agent"}
					</label>
				))}
			</div>
			<label className="automation-intent">
				Automation{" "}
				<select
					value={body.automate}
					onChange={(event) => {
						event.currentTarget.blur();
						change({ ...body, automate: Automate.parse(event.target.value) });
					}}
				>
					<option value="none">Not requested</option>
					<option value="wanted">Wanted</option>
					<option value="not-applicable">Not applicable</option>
				</select>
			</label>
			<div className="hintl">An agent's evidence counts only when the run admits it too.</div>
		</details>
	);
}
