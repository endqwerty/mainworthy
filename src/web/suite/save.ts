import type { Dispatch, RefObject, SetStateAction } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import type { Api } from "../../core/api.ts";
import { canonicalJson } from "../../core/hash.ts";
import { mergeBodies } from "../../core/merge3.ts";
import { CaseBody, fieldErrors } from "../../core/model.ts";
import type { Edit } from "../../core/ops.ts";
import { ProposeReply } from "../../core/replies.ts";
import { optionalFlag as schemaOptionalFlag, text as schemaText, texts as schemaTexts } from "../../core/schema.ts";
import type { ConflictState } from "../case/pane.tsx";
import { ApiError, call } from "../lib/api.ts";
import { invalidateProject, queryClient } from "../lib/data.ts";
import type { DeviceSession } from "../lib/device.ts";
import { sessionCurrent } from "../lib/device.ts";
import {
	cleanTitle,
	type Draft,
	draftTags,
	promoteStepIds,
	readDraft,
	remainingTagChanges,
	TagChanges,
} from "../lib/drafts.ts";
import { randomId } from "../lib/ids.ts";
import { asTyped, carried, carriedCovers, holdsUnfinishedStep, recordable, sameBody } from "../lib/merges.ts";
import type { Route } from "../lib/router.ts";
import { navigate, type navigationToken, refUrl } from "../lib/router.ts";
import { bodyOf, CaseView } from "./model.ts";
import type { SaveCommands } from "./save-state.ts";

const errorMessage = (error: unknown, fallback: string): string => (error instanceof Error ? error.message : fallback);
const waitingStatus = (action: string, question: string | null): string =>
	`${action}, waiting for a person${question === null ? "" : ` · ${question}`}`;
const draftKept = "Your draft is kept on this device.";
const keptFailure = (reason: string): string => `${reason}${/[.!?]$/.test(reason) ? "" : "."} ${draftKept}`;
const obsoleteProject = (error: unknown): boolean =>
	error instanceof ApiError && error.details.projectIdentity === "obsolete";
const ResolvedEdit = z.object({
	op: z.literal("edit"),
	case: schemaText,
	mine: CaseBody,
	current: CaseBody,
	body: CaseBody,
});

const CardQuestion = z.object({
	q: schemaText,
	state: schemaText,
	evidenceHash: schemaText,
	decision: z.object({ answer: z.object({ is: schemaText }) }).nullable(),
});
const AdoptionQuestion = CardQuestion.extend({
	decision: z
		.object({
			answer: z.object({ is: schemaText }),
			effects: z.object({ cases: ProposeReply.shape.cases.optional(), rejected: schemaOptionalFlag }),
		})
		.nullable(),
});
const SubmittedText = z.object({
	body: CaseBody,
	tags: schemaTexts,
	covers: schemaTexts,
	tagChanges: TagChanges.optional(),
});

type SaveContext = {
	project: string;
	owner: DeviceSession;
	windowId: string;
	navigation: ReturnType<typeof navigationToken>;
	route: Route;
	draftStored: boolean;
	fieldDefinitions: Parameters<typeof fieldErrors>[1] | undefined;
	draftRef: RefObject<Draft | null>;
	liveDrafts: RefObject<Map<string, Draft>>;
	setCaptures: Dispatch<SetStateAction<Map<string, Draft>>>;
	setDraftState: Dispatch<SetStateAction<Draft | null>>;
	setSelected: Dispatch<SetStateAction<string | null>>;
	commands: SaveCommands;
	endingDraft: () => Draft | null;
	mayRecover: (draft: Draft) => boolean;
	mayWrite: (id: string, allowMissing?: boolean) => boolean;
	dropEmpty: (draft: Draft) => boolean;
	removeOwnedDraft: (id: string) => void;
	readForDraft: (draft: Draft, input: Api["get"]["input"]) => Promise<Api["get"]["reply"]>;
	forgetRequest: (id: string) => void;
	writeOwnedDraft: (draft: Draft) => boolean;
	preserveRejectedDraft: (draft: Draft) => void;
	storeConflict: (state: ConflictState) => void;
	putDraft: (draft: Draft) => boolean;
	holdCase: (input: { ref: string; rows: Api["get"]["reply"] }) => void;
	stepIdFor: (id: string) => (taken: ReadonlySet<string>) => string;
	focusDraft: (draft: Draft) => void;
	setStatus: (text: string) => unknown;
};

export function createSaveWorkflow(context: SaveContext) {
	const {
		project,
		owner,
		windowId,
		navigation,
		route,
		draftStored,
		fieldDefinitions,
		draftRef,
		liveDrafts,
		setCaptures,
		setDraftState,
		setSelected,
		commands,
		endingDraft,
		mayRecover,
		mayWrite,
		dropEmpty,
		removeOwnedDraft,
		readForDraft,
		forgetRequest,
		writeOwnedDraft,
		preserveRejectedDraft,
		storeConflict,
		putDraft,
		holdCase,
		stepIdFor,
		focusDraft,
		setStatus,
	} = context;
	/**
	 * Records a draft: sends what it holds, and carries what is typed later onto the version that makes. For a save
	 * whose reply never came (a reload, a closed tab, a dropped connection) the server is asked what became of it
	 * (`command`) first (issue #71). Recorded: its recorded reply is taken, and it is never sent again. Not recorded
	 * (yet: it may still be on its way): that same request goes again under its own id, which the server records
	 * once however many copies arrive. Either way, what was typed since goes out after it under a new id. With
	 * `settleOnly`, only that save is settled, and nothing typed since is sent.
	 */
	async function sealDraft({
		keepalive = false,
		saved,
		settleOnly = false,
	}: {
		keepalive?: boolean;
		saved?: Draft;
		settleOnly?: boolean;
	} = {}): Promise<void> {
		const snapshot = saved ?? draftRef.current;
		if (!sessionCurrent(owner)) return;
		if (snapshot && snapshot === endingDraft() && snapshot.owner !== windowId) return;
		if (snapshot && !mayRecover(snapshot)) return;
		if (!snapshot || !mayWrite(snapshot.id, !snapshot.dirty || !draftStored) || dropEmpty(snapshot)) return;
		if (snapshot.ref && readDraft({ project, id: snapshot.id })?.conflict) return;
		if (!snapshot.dirty) {
			removeOwnedDraft(snapshot.id);
			return;
		}
		liveDrafts.current.set(snapshot.id, snapshot);
		setCaptures((previous) => new Map(previous).set(snapshot.id, snapshot));
		const existing = commands.pending.get(snapshot.id);
		if (existing !== undefined) {
			await existing;
			const latest = liveDrafts.current.get(commands.adoptedRef(snapshot.id) ?? snapshot.id);
			if (sessionCurrent(owner) && latest?.dirty) await sealDraft({ keepalive, saved: latest });
			return;
		}
		let cleaned = cleanTitle(snapshot);
		let body = recordable(cleaned.body);
		if (settleOnly && !snapshot.sent && snapshot.submission.kind !== "waiting") return;
		// All the draft holds beyond its version is a step still without an action, which no version can take.
		// Nothing is sent, and the draft stays on the device as it is (issue #86).
		if (
			snapshot.ref !== null &&
			!snapshot.sent &&
			holdsUnfinishedStep(cleaned.body) &&
			sameBody(body, snapshot.original) &&
			cleaned.tagChanges.add.length === 0 &&
			cleaned.tagChanges.remove.length === 0 &&
			canonicalJson(cleaned.covers) === canonicalJson(snapshot.originalCovers)
		)
			return;
		if (!snapshot.sent && snapshot.submission.kind === "none") {
			if (!fieldDefinitions) {
				setStatus("Custom field definitions are unavailable. Wait for the Suite to load before saving.");
				return;
			}
			const errors = fieldErrors(body.fields, fieldDefinitions, snapshot.ref ? snapshot.original.fields : undefined);
			if (errors.length) {
				setStatus(errors.join("; "));
				return;
			}
		}
		const source = snapshot;
		commands.restore(snapshot);
		const recovered = snapshot.sent;
		const waitingText =
			!recovered && snapshot.submission.kind === "waiting"
				? SubmittedText.parse(JSON.parse(snapshot.submission.fingerprint))
				: null;
		const submitted = recovered ?? waitingText;
		if (submitted) {
			body = submitted.body;
			cleaned = { ...cleaned, covers: submitted.covers };
		}
		const sentTags = recovered?.tags ?? waitingText?.tags ?? draftTags(cleaned);
		const sentTagChanges =
			recovered?.tagChanges ??
			(waitingText
				? (waitingText.tagChanges ?? {
						add: sentTags.filter((tag) => !source.originalTags.includes(tag)),
						remove: source.originalTags.filter((tag) => !sentTags.includes(tag)),
					})
				: cleaned.tagChanges);
		const tagsToPlace = {
			add: sentTagChanges.add.filter((tag) => !source.originalTags.includes(tag)),
			remove: sentTagChanges.remove.filter((tag) => source.originalTags.includes(tag)),
		};
		// What the reply handled below was given for: the draft's text, or the save of unknown fate it is about.
		const proposed = JSON.stringify({ body, tags: sentTags, covers: cleaned.covers, folder: snapshot.folder });
		let moreToSend = false;
		let reply: Api["propose"]["reply"] | null = commands.reply(snapshot.id);
		const task = (async () => {
			try {
				let recorded = reply !== null;
				if (snapshot.submission.kind === "waiting") {
					const question = AdoptionQuestion.parse(
						(await readForDraft(snapshot, { refs: [snapshot.submission.question] }))[0],
					);
					if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
					if (question.state === "open") {
						setStatus(waitingStatus("Proposed", question.q));
						return;
					}
					if (question.decision?.answer.is !== "accept" || question.decision.effects.rejected) {
						forgetRequest(snapshot.id);
						setStatus(`The proposal was not accepted. ${draftKept}`);
						return;
					}
					reply = {
						status: "adopted",
						proposal: null,
						question: question.q,
						needs: null,
						cases: question.decision.effects.cases ?? [],
						placements: [],
						conflicts: [],
					};
					recorded = true;
				}
				let after = snapshot.after;
				if (after?.startsWith("draft:")) {
					const predecessor = after;
					const request = commands.pending.get(predecessor);
					if (request !== undefined) await request;
					if (!sessionCurrent(owner)) return;
					after = commands.adoptedRef(predecessor) ?? null;
				}
				const edits: Edit[] =
					snapshot.ref === null
						? [
								{
									op: "create",
									kind: snapshot.kind ?? "case",
									body,
									...(snapshot.folder ? { folder: snapshot.folder } : {}),
									tags: draftTags(cleaned),
									covers: cleaned.covers,
									...(after ? { after } : {}),
								},
							]
						: [
								{
									op: "edit",
									case: snapshot.ref,
									base: snapshot.base,
									body: {
										...body,
										fields:
											canonicalJson(body.fields) === canonicalJson(snapshot.original.fields) ? undefined : body.fields,
									},
								},
								...(tagsToPlace.add.length || tagsToPlace.remove.length
									? [
											{
												op: "place",
												cases: [source.ref ?? ""],
												tags: tagsToPlace,
											} satisfies Edit,
										]
									: []),
								...cleaned.covers
									.filter((requirement) => !source.originalCovers.includes(requirement))
									.map(
										(requirement) => ({ op: "cover", case: source.ref ?? "", requirement, on: true }) satisfies Edit,
									),
								...source.originalCovers
									.filter((requirement) => !cleaned.covers.includes(requirement))
									.map(
										(requirement) => ({ op: "cover", case: source.ref ?? "", requirement, on: false }) satisfies Edit,
									),
							];
				// The reply was given to the save of unknown fate, and is read now (`command`), not just received.
				if (recovered && !reply) {
					if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
					let fate: Api["command"]["reply"];
					try {
						fate = await call("command", { cmd: recovered.input.cmd ?? "" }, { project, owner });
					} catch (error) {
						// Nothing is known, so nothing is sent. The draft keeps the save, and the next leave asks again.
						if (sessionCurrent(owner) && mayWrite(source.id, !draftStored)) {
							const reason = errorMessage(error, "Could not ask what became of the last save");
							setStatus(keptFailure(reason));
						}
						return;
					}
					if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
					if (fate.state === "begun") {
						setStatus(`Your last save of this draft is still being recorded. ${draftKept}`);
						return;
					}
					if (fate.state === "done") {
						reply = ProposeReply.parse(fate.reply);
						recorded = true;
					}
					// `none` is "not recorded yet": the save may still be on its way. The one request that cannot be
					// recorded twice is that save itself, under its own id, so it goes again unchanged, and what was
					// typed since follows it under a new id (the review of the first fix for #71, B1).
				}
				if (!reply) {
					const request = recovered?.input ?? { cmd: source.cmd, edits, projectIdentity: source.projectIdentity };
					if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
					const sent = recovered ?? {
						input: request,
						body,
						tags: sentTags,
						covers: cleaned.covers,
						tagChanges: sentTagChanges,
					};
					const outgoing = liveDrafts.current.get(source.id);
					if (outgoing?.id === source.id) {
						const sending = {
							...cleanTitle(outgoing),
							body: recovered
								? outgoing.body
								: mergeBodies({
										base: snapshot.body,
										mine: outgoing.body,
										theirs: asTyped({ typed: snapshot.body, stored: cleaned.body }),
									}).merged,
							sent,
						};
						liveDrafts.current.set(sending.id, sending);
						if (draftRef.current?.id === sending.id) {
							draftRef.current = sending;
							setDraftState(sending);
						}
						try {
							if (!writeOwnedDraft(sending)) return;
						} catch {}
					}
					try {
						commands.sent(source.id, request);
						reply = await call("propose", request, { project, keepalive, owner });
					} catch (error) {
						if (obsoleteProject(error)) {
							preserveRejectedDraft(source);
							return;
						}
						if (
							error instanceof ApiError &&
							error.status !== null &&
							error.code !== "internal" &&
							error.code !== "busy" &&
							sessionCurrent(owner) &&
							mayWrite(source.id, !draftStored)
						) {
							commands.clear(source.id);
							forgetRequest(source.id);
						}
						throw error;
					}
					if (!sessionCurrent(owner) || !mayWrite(source.id, !draftStored)) return;
				}
				commands.succeeded(snapshot.id, reply);
				if (reply.status === "conflict" || reply.status === "rejected") {
					commands.clear(snapshot.id);
					forgetRequest(snapshot.id);
				}
				if (reply.status === "conflict" && reply.question && snapshot.ref && reply.proposal) {
					const proposal = (await readForDraft(snapshot, { refs: [reply.proposal] }))[0];
					if (!mayWrite(source.id, !draftStored)) return;
					const rawEdits = proposal && Array.isArray(proposal.edits) ? proposal.edits : [];
					const edit = rawEdits
						.map((item: unknown) => ResolvedEdit.safeParse(item))
						.find((item) => item.success && item.data.case === snapshot.ref);
					const currentBody = edit?.success ? CaseBody.parse(edit.data.current) : body;
					const latest = liveDrafts.current.get(snapshot.id) ?? snapshot;
					const mine = recordable(cleanTitle(latest).body);
					const merged = mergeBodies({ base: latest.original, mine, theirs: currentBody });
					const conflict: ConflictState = {
						q: reply.question,
						proposal: reply.proposal,
						base: latest.original,
						ref: snapshot.ref,
						mine,
						current: currentBody,
						merged: merged.merged,
						addresses: merged.conflicts.map((conflict) => conflict.address),
						metadata: {
							tagChanges: sentTagChanges,
							covers: {
								add: cleaned.covers.filter((link) => !source.originalCovers.includes(link)),
								remove: source.originalCovers.filter((link) => !cleaned.covers.includes(link)),
							},
						},
						sentMerges: [],
						draftId: snapshot.id,
					};
					storeConflict(conflict);
					if (draftRef.current?.id === snapshot.id) {
						setStatus("Both edits are kept. Choose each field to resolve the conflict.");
					} else setStatus(`${snapshot.ref} has a conflict. Its draft is kept; return to the case to resolve it.`);
					return;
				}
				if (reply.status === "open") {
					commands.clear(snapshot.id);
					if (reply.question) {
						const latest = liveDrafts.current.get(snapshot.id) ?? snapshot;
						const next: Draft = {
							...latest,
							cmd: randomId(),
							submission: { kind: "waiting", question: reply.question, fingerprint: proposed },
						};
						if (!putDraft(next)) return;
					}
					setStatus(waitingStatus("Proposed", reply.question));
					return;
				}
				if (reply.status === "rejected") {
					setStatus(`The proposal was rejected. ${draftKept}`);
					return;
				}
				const stamp = reply.cases.find((item) => snapshot.ref === null || item.ref === snapshot.ref);
				const ref = stamp?.ref ?? snapshot.ref;
				let version = stamp?.version ?? snapshot.base;
				let adopted = body;
				let adoptedTags = sentTags;
				let adoptedCovers = cleaned.covers;
				if (ref) {
					const rows = await readForDraft(snapshot, { refs: [ref], ...(stamp ? { version } : {}) });
					if (!sessionCurrent(owner)) return;
					if (!mayWrite(source.id, !draftStored)) return;
					const received = CaseView.parse(rows[0]);
					version = received.version;
					adopted = bodyOf(received);
					adoptedTags = received.tags;
					adoptedCovers = received.covers;
					holdCase({ ref, rows: [received] });
					void queryClient.cancelQueries({
						queryKey: [project, "find"],
						predicate: (query) => query.state.data !== undefined,
					});
					queryClient.setQueriesData<{
						pages: { items: Record<string, unknown>[]; count: number | null; cursor: string | null }[];
						pageParams: unknown[];
					}>({ queryKey: [project, "find"] }, (cached) =>
						cached && "pages" in cached
							? {
									...cached,
									pages: cached.pages.map((page) => ({
										...page,
										items: page.items.map((row) =>
											row.ref === ref && (typeof row.version !== "number" || row.version < received.version)
												? {
														...row,
														title: received.title,
														version: received.version,
														hash: received.hash,
														tags: received.tags,
														steps: received.steps.length,
														proof: received.proof,
														updatedAt: received.updated.at,
													}
												: row,
										),
									})),
								}
							: cached,
					);
				}
				if (ref) {
					promoteStepIds({ project, from: snapshot.id, to: ref });
					commands.adopt(snapshot.id, ref, version);
					setCaptures((previous) => {
						if (!previous.has(snapshot.id)) return previous;
						const next = new Map(previous);
						next.set(snapshot.id, {
							...snapshot,
							ref,
							base: version,
							body: adopted,
							original: adopted,
							dirty: false,
							submission: { kind: "none" },
						});
						return next;
					});
				}
				removeOwnedDraft(snapshot.id);
				const latest = liveDrafts.current.get(snapshot.id);
				let unfinished = false;
				if (latest && ref) {
					const normalized = cleanTitle(latest);
					const normalizedBody = recordable(normalized.body);
					const tagChanges = remainingTagChanges({ sent: sentTagChanges, current: normalized.tagChanges });
					const more =
						tagChanges.add.length > 0 ||
						tagChanges.remove.length > 0 ||
						JSON.stringify({ body: normalizedBody, covers: normalized.covers }) !==
							JSON.stringify({ body, covers: cleaned.covers });
					const merged = carried({ sent: body, live: latest.body, recorded: adopted, newId: stepIdFor(ref) });
					// A step with an expected result and no action yet is in no version. Its draft stays on the device,
					// and is not sent again for it: `more` is only what a version can take.
					unfinished = holdsUnfinishedStep(merged);
					const keepTitleFocus =
						document.activeElement instanceof HTMLElement && document.activeElement.dataset.field === "capture-title";
					const next: Draft = {
						...latest,
						id: ref,
						ref,
						base: version,
						body: merged,
						original: adopted,
						submission: { kind: "none" },
						tagChanges,
						covers: carriedCovers({ original: cleaned.covers, mine: normalized.covers, recorded: adoptedCovers }),
						originalTags: adoptedTags,
						originalCovers: adoptedCovers,
						sent: null,
						dirty: more || unfinished,
						cmd: randomId(),
						caret: latest.caret.field === "capture-title" ? { ...latest.caret, field: "title" } : latest.caret,
					};
					liveDrafts.current.delete(snapshot.id);
					liveDrafts.current.set(next.id, next);
					setCaptures((previous) => {
						const captures = new Map(previous);
						captures.delete(snapshot.id);
						if (next.dirty) captures.set(next.id, next);
						return captures;
					});
					if (draftRef.current?.id === snapshot.id) {
						draftRef.current = next;
						// Events from the old editor must not put the draft back on its earlier version.
						flushSync(() => setDraftState(next));
						if (keepTitleFocus) focusDraft(next);
						setSelected(ref);
						if (route.screen === "case" || snapshot.ref === null)
							navigate(`${refUrl({ project, ref })}${location.search}`, {
								replace: true,
								seal: false,
								ifCurrent: navigation,
							});
					}
					moreToSend = more;
					if (next.dirty && !writeOwnedDraft(next)) return;
				}
				const held = unfinished
					? ". A step with no action yet is not in it, and stays in your draft on this device."
					: "";
				setStatus(
					!recorded
						? `Version ${version}, by you, just now${held}`
						: stamp
							? `Your last save is recorded as version ${version}${held}`
							: `Your last save changed nothing: the case already held it${held}`,
				);
				void invalidateProject(project);
			} catch (error) {
				if (!sessionCurrent(owner) || !mayWrite(snapshot.id, !draftStored)) return;
				const reason = errorMessage(error, "Could not record this version");
				setStatus(keptFailure(reason));
			}
		})();
		commands.pending.set(snapshot.id, task);
		await task;
		commands.pending.delete(snapshot.id);
		if (moreToSend && !settleOnly && sessionCurrent(owner)) {
			const latest = liveDrafts.current.get(commands.adoptedRef(snapshot.id) ?? snapshot.id);
			if (latest?.dirty) await sealDraft({ keepalive, saved: latest });
		}
	}
	return sealDraft;
}
