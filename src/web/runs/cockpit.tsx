import { type InfiniteData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { Api } from "../../core/api.ts";
import { ATTACHMENT_LIMITS, AttachmentInput, attachmentBytes } from "../../core/attachments.ts";
import type { ReportReceipt } from "../../core/ops.ts";
import { REPLIES } from "../../core/replies.ts";
import { workHeldByOther } from "../../core/runs.ts";
import { ApiError, call, UnreadableReply } from "../lib/api.ts";
import { invalidateProject, queryClient, queryKey, useQueryOp } from "../lib/data.ts";
import { type DeviceSession, deviceKey, deviceSession, sessionCurrent } from "../lib/device.ts";
import { randomId } from "../lib/ids.ts";
import { type Binding, useBindings } from "../lib/keys.ts";
import { navigate, refUrl, routeUrl } from "../lib/router.ts";
import { ResultAttachments } from "../ui/attachments.tsx";
import { useApp } from "../ui/context.tsx";
import { age, EmptyState, KeyCap, ListRow, ProducerGlyph } from "../ui/index.tsx";
import { ResultTrail } from "../ui/result-trail.tsx";
import { type Fill, outcomeName, Run, RunCase, type RunOutcome, Slot, tallyText } from "./models.ts";
import { useWorkExpiry } from "./work.ts";

/**
 * Notes typed for the slots of one run and not yet on the server, by slot id. Each note has its own key, so two
 * tabs on one run never write over each other's notes. Storage may be full or off.
 */
function readNotes(prefix: string): Record<string, string> {
	const notes: Record<string, string> = {};
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key?.startsWith(prefix)) continue;
			const text = localStorage.getItem(key);
			if (text) notes[key.slice(prefix.length)] = text;
		}
	} catch {}
	return notes;
}
function storeNote(key: string, text: string): void {
	try {
		if (text) localStorage.setItem(key, text);
		else localStorage.removeItem(key);
	} catch {}
}
function storedNote(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

const outcomes = [
	["p", "pass"],
	["f", "fail"],
	["b", "blocked"],
	["s", "skip"],
] as const;
const changedResult = "This result has changed since it was recorded. No correction was recorded.";

type LocalFill = { fill: Fill; questions: ReportReceipt["questions"]; pending: boolean };
type PendingAttachment = AttachmentInput & { key: string };
type RecordedResult = { fill: Fill; previous: Fill | null };
type LastResult = { slot: Slot; outcome: RunOutcome; ready: Promise<RecordedResult> };
type PendingReport = Api["report"]["input"] & Required<Pick<Api["report"]["input"], "projectIdentity">>;

function newRunReports(projectIdentity: PendingReport["projectIdentity"]) {
	return {
		projectIdentity,
		retired: false,
		confirmed: new Map<number, Slot>(),
		writes: new Map<number, Promise<RecordedResult>>(),
		uncertain: new Map<number, { message: string; retry: () => Promise<RecordedResult> }>(),
		latest: new Map<number, Fill>(),
		queued: new Map<number, number>(),
		consumedNotes: new Map<number, string>(),
		consumedSteps: new Map<number, string>(),
	};
}
// Requests and their correction ancestry outlive the screen that started them, within this tab and session.
const pendingRuns = new Map<
	string,
	{ project: string; owner: DeviceSession; reports: ReturnType<typeof newRunReports> }
>();
function runReports(
	project: string,
	run: string,
	owner: DeviceSession,
	projectIdentity: PendingReport["projectIdentity"],
) {
	for (const [key, pending] of pendingRuns)
		if (
			!sessionCurrent(pending.owner) ||
			(pending.project === project && pending.reports.projectIdentity !== projectIdentity)
		) {
			pending.reports.retired = true;
			pendingRuns.delete(key);
		}
	const key = JSON.stringify([project, projectIdentity, run]);
	const pending = pendingRuns.get(key);
	if (pending) return pending.reports;
	const reports = newRunReports(projectIdentity);
	pendingRuns.set(key, { project, owner, reports });
	return reports;
}

export function RunCockpit({ runRef }: { runRef: string }) {
	const { project, session } = useApp();
	const projectIdentity = session.projects.find((entry) => entry.key === project)?.identity;
	if (!projectIdentity)
		return <EmptyState>The current project is unavailable. Reload before recording a result.</EmptyState>;
	return (
		<ProjectRunCockpit
			key={JSON.stringify([projectIdentity, runRef])}
			runRef={runRef}
			projectIdentity={projectIdentity}
		/>
	);
}

function ProjectRunCockpit({
	runRef,
	projectIdentity,
}: {
	runRef: string;
	projectIdentity: PendingReport["projectIdentity"];
}) {
	const { project, session, setStatus } = useApp();
	const owner = useRef(deviceSession()).current;
	const [reports] = useState(() => runReports(project, runRef, owner, projectIdentity));
	const runRead = useQueryOp({ project, op: "get", input: { refs: [runRef] } });
	const parsedRun = Run.safeParse(runRead.data?.[0]);
	const run = parsedRun.success && parsedRun.data.ref === runRef ? parsedRun.data : null;
	const signoffInput = { on: runRef, kind: "signoff", state: "decided" } satisfies Api["inbox"]["input"];
	const signoffs = useQueryOp({ project, op: "inbox", input: signoffInput, enabled: run?.state === "closed" });
	const signoff = signoffs.data?.items.find((item) => item.decision?.effects.closed === runRef);
	const mayReopen = (item: typeof signoff) =>
		session.kind === "human" && !!item?.decision?.rule && item?.you === "counts";
	const now = useWorkExpiry(project, run?.workUntil ?? null);
	useEffect(() => {
		setStatus("Each result records its pinned version. p pass · f fail · b blocked · s skip.");
	}, [setStatus]);
	const slotInput: Api["find"]["input"] = { in: "slots", run: runRef, limit: 200 };
	const cacheKey = [...queryKey({ project, op: "find", input: slotInput }), "pages"];
	const {
		data: slotPages,
		error: slotsError,
		hasNextPage,
		isPending,
		isFetchingNextPage,
		isFetchNextPageError,
		fetchNextPage,
	} = useInfiniteQuery({
		queryKey: cacheKey,
		initialPageParam: "",
		queryFn: ({ pageParam, signal }) =>
			call("find", { ...slotInput, ...(pageParam ? { cursor: pageParam } : {}) }, { project, signal }),
		getNextPageParam: (page) => page.cursor ?? undefined,
	});
	function replaceSlot(slot: Pick<Slot, "id"> & Partial<Slot>): void {
		queryClient.setQueryData<InfiniteData<Api["find"]["reply"]>>(
			cacheKey,
			(value) =>
				value && {
					...value,
					pages: value.pages.map((page) => ({
						...page,
						items: page.items.map((row) => (row.id === slot.id ? { ...row, ...slot } : row)),
					})),
				},
		);
	}

	const parsedSlots = Slot.array().safeParse(slotPages?.pages.flatMap((page) => page.items));
	const storedSlots: Slot[] = parsedSlots.success
		? parsedSlots.data.map((slot) =>
				slot.work.kind === "held" && slot.work.until <= now ? { ...slot, work: { kind: "free" } } : slot,
			)
		: [];
	for (const slot of storedSlots) if (slot.fills.every((fill) => fill.result > 0)) reports.confirmed.set(slot.id, slot);
	const [local, setLocal] = useState<Map<number, LocalFill>>(new Map());
	const [cursor, setCursor] = useState<number | null>(null);
	const stepPrefix = deviceKey("run-step", `${project}:${runRef}:`, owner.actorId);
	const digitSequence = useRef({ slot: 0, at: 0 });
	const [steps, setSteps] = useState<Record<string, string>>(() => readNotes(stepPrefix));
	const [noting, setNoting] = useState<Slot | null>(null);
	// A note belongs to its slot and is kept on this device from the first key until the server has the result:
	// a reload, a failed request, or two failed requests in a row lose none of them.
	const notePrefix = deviceKey("run-note", `${project}:${runRef}:`, owner.actorId);
	const [notes, setNotes] = useState<Record<string, string>>(() => readNotes(notePrefix));
	const setNoteOf = (slotId: number, text: string): void => {
		if (!sessionCurrent(owner)) return;
		reports.consumedNotes.delete(slotId);
		storeNote(`${notePrefix}${slotId}`, text);
		setNotes((previous) => {
			const next = { ...previous };
			if (text) next[slotId] = text;
			else delete next[slotId];
			return next;
		});
	};
	// A note typed in another tab on this run shows here too.
	useEffect(() => {
		const changed = (event: StorageEvent): void => {
			if (event.key === null || event.key.startsWith(notePrefix)) setNotes(readNotes(notePrefix));
		};
		window.addEventListener("storage", changed);
		return () => window.removeEventListener("storage", changed);
	}, [notePrefix]);
	useEffect(() => {
		let mounted = true;
		const settled = () => {
			if (!mounted || !sessionCurrent(owner)) return;
			setNotes(readNotes(notePrefix));
			setSteps(readNotes(stepPrefix));
		};
		for (const request of reports.writes.values()) void request.then(settled, settled);
		return () => {
			mounted = false;
		};
	}, [reports, notePrefix, stepPrefix, owner]);
	const pendingFiles = useRef(new Map<number, PendingAttachment[]>());
	const consumedFiles = useRef(new Set<PendingAttachment>());
	const readingFiles = useRef(new Set<number>());
	const [, refreshFiles] = useState(0);
	async function addFiles(slotId: number, files: File[]) {
		if (!sessionCurrent(owner) || files.length === 0) return;
		if (readingFiles.current.has(slotId)) {
			setStatus("Wait for this slot's files to finish reading.");
			return;
		}
		readingFiles.current.add(slotId);
		refreshFiles((value) => value + 1);
		try {
			const existing = pendingFiles.current.get(slotId) ?? [];
			if (files.some((file) => file.size > ATTACHMENT_LIMITS.file))
				throw new Error("Each attachment must be at most 4 MiB.");
			if (existing.length + files.length > ATTACHMENT_LIMITS.perResult)
				throw new Error("A result may carry at most 20 attachments.");
			const total =
				existing.reduce((sum, file) => sum + attachmentBytes(file.data), 0) +
				files.reduce((sum, file) => sum + file.size, 0);
			if (total > ATTACHMENT_LIMITS.report) throw new Error("Attachments for a result must total at most 16 MiB.");
			const added: PendingAttachment[] = [];
			for (const file of files) {
				const bytes = new Uint8Array(await file.arrayBuffer());
				let binary = "";
				for (let offset = 0; offset < bytes.length; offset += 8192)
					binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
				added.push({
					...AttachmentInput.parse({ name: file.name || "screenshot.png", data: btoa(binary) }),
					key: randomId(),
				});
			}
			if (!sessionCurrent(owner)) return;
			pendingFiles.current.set(slotId, [...(pendingFiles.current.get(slotId) ?? []), ...added]);
			setStatus("Attachment added to this slot's next result. Keep this page open until you record it.");
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "The file could not be read.");
		} finally {
			readingFiles.current.delete(slotId);
			refreshFiles((value) => value + 1);
		}
	}
	const noteRef = useRef<HTMLInputElement>(null);
	const [last, setLast] = useState<LastResult | null>(null);
	const canCorrect = !!(last && (run?.state === "open" || mayReopen(signoff)));
	const withdrawn = useRef(new Set<Promise<RecordedResult>>());
	const method = session.kind === "agent" ? "agent" : "human";
	const isOwnFill = (fill: Fill) => fill.by === session.actor && fill.method === method;
	const ownFillOf = (slot: Slot) => slot.fills.find(isOwnFill);
	const slots: Slot[] = storedSlots.map((slot) => {
		const own = local.get(slot.id);
		return own && (own.pending || own.fill.result > (ownFillOf(slot)?.result ?? 0))
			? {
					...slot,
					state: own.fill.outcome === "pass" ? "satisfied" : own.fill.outcome === "fail" ? "failing" : "skipped",
					fills: [...slot.fills.filter((fill) => !isOwnFill(fill)), own.fill],
				}
			: slot;
	});
	const missing = (slot: Slot) =>
		(slot.state === "missing" || slot.state === "skipped") && !local.get(slot.id)?.pending;
	const unreported = (slot: Slot) => missing(slot) && !ownFillOf(slot);
	const held = (slot: Slot) => slot.work.kind === "held" && workHeldByOther(slot.work, session.actor, now);
	const available = (slot: Slot) => unreported(slot) && !held(slot);
	const first = slots.find(available) ?? (hasNextPage ? undefined : slots.find((slot) => !held(slot)));
	if (cursor === null && first) setCursor(first.id);
	const current = cursor === null ? first : slots.find((slot) => slot.id === cursor);
	const step = current ? (steps[current.id] ?? "") : "";
	function setStep(value: string | ((previous: string) => string)): void {
		if (!current || !sessionCurrent(owner)) return;
		const next = typeof value === "function" ? value(step) : value;
		reports.consumedSteps.delete(current.id);
		storeNote(`${stepPrefix}${current.id}`, next);
		setSteps((prior) => ({ ...prior, [current.id]: next }));
	}
	useEffect(() => {
		const interrupt = (event: KeyboardEvent) => {
			if (!/^\d$/.test(event.key)) digitSequence.current = { slot: 0, at: 0 };
		};
		window.addEventListener("keydown", interrupt, true);
		return () => window.removeEventListener("keydown", interrupt, true);
	}, []);
	function clearStep(slotId: number, sent: string): void {
		if (storedNote(`${stepPrefix}${slotId}`) !== sent) return;
		storeNote(`${stepPrefix}${slotId}`, "");
		setSteps((prior) => {
			const next = { ...prior };
			delete next[slotId];
			return next;
		});
	}
	const currentIndex = current ? slots.indexOf(current) : -1;
	const next = current
		? [...slots.slice(currentIndex + 1), ...slots.slice(0, currentIndex)].filter(available).slice(0, 5)
		: [];
	const documents = current ? [current, ...next] : [];
	const external = (slot: Slot) => !missing(slot) && slot.fills.length > 0 && !ownFillOf(slot);
	const ownFill = current && ownFillOf(current);
	const note = current ? (notes[current.id] ?? "") : "";
	const { body: currentBody } = usePinnedCase(current);
	const admittedMethod = !!(
		run?.require.some((obligation) => obligation.kind === "exercise" && obligation.methods.includes(method)) &&
		(!currentBody || currentBody.methods.includes(method))
	);
	const canRecord = !!(
		current &&
		session.can.includes("produce") &&
		(reports.uncertain.has(current.id) || (!external(current) && run?.state === "open" && admittedMethod))
	);
	const hasAvailable = slots.some(available);
	const allReported = slots.length > 0 && !slots.some(unreported) && !hasNextPage;
	useEffect(() => {
		if (current?.id) document.querySelector(`[data-slot="${current.id}"]`)?.scrollIntoView({ block: "nearest" });
	}, [current?.id]);
	useEffect(() => {
		if (!hasAvailable && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
	}, [hasAvailable, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
	const ownsWork = (slot: Slot) => slot.work.kind === "held" && slot.work.actor === session.actor;
	const canWork = session.can.includes("record") && run?.state === "open" && admittedMethod;
	async function work(action: Api["work"]["input"]["do"]) {
		if (!current || !canWork || !sessionCurrent(owner)) return;
		try {
			await call("work", { do: action, run: runRef, slot: current.id, projectIdentity }, { project, owner });
		} catch (error) {
			setStatus(error instanceof Error ? error.message : "Work request failed. Check the slot before retrying.");
		} finally {
			void invalidateProject(project);
		}
	}

	function move(delta: number): void {
		const start = current ? currentIndex : delta > 0 ? -1 : slots.length;
		for (let distance = 1; distance <= slots.length; distance++) {
			const candidate = slots[start + distance * delta];
			if (!candidate) return;
			if (!external(candidate)) {
				setCursor(candidate.id);
				setNoting(null);
				return;
			}
		}
	}
	function assertReportOwner(): void {
		if (!sessionCurrent(owner)) throw new Error("The session changed. Your note is kept.");
		if (reports.retired)
			throw new Error("This report belongs to an obsolete project. Read the current project before recording again.");
	}
	function record(
		outcome: RunOutcome,
		slot = current,
		text = slot && reports.consumedNotes.get(slot.id) !== notes[slot.id] ? (notes[slot.id] ?? "") : "",
		advance = true,
		visibleStep = false,
		restores?: Promise<RecordedResult>,
	): Promise<RecordedResult> | null {
		if (!slot || !sessionCurrent(owner) || reports.retired || !session.can.includes("produce")) return null;
		const recovery = reports.uncertain.get(slot.id);
		if (recovery) {
			const recoveringSlot = slot;
			const request = recovery.retry();
			void request.then(
				() => {
					if (!sessionCurrent(owner) || reports.retired) return;
					setNotes(readNotes(notePrefix));
					setSteps(readNotes(stepPrefix));
				},
				() => {},
			);
			void request.catch((error: unknown) => {
				if (sessionCurrent(owner) && !reports.retired)
					setStatus(
						reports.uncertain.get(recoveringSlot.id)?.message ??
							`${recoveringSlot.case} was not recorded: ${error instanceof Error ? error.message : "The request failed"}. Its note is kept.`,
					);
			});
			return request;
		}
		if (run?.state !== "open" && !restores) {
			setStatus("This run is closed. No result was recorded; your note is kept.");
			return null;
		}
		if (readingFiles.current.has(slot.id)) {
			setStatus("Wait for this slot's attachments to finish reading before recording.");
			return null;
		}
		const files = restores
			? []
			: (pendingFiles.current.get(slot.id) ?? []).filter((file) => !consumedFiles.current.has(file));

		const slotId = slot.id;
		slot = slots.find((item) => item.id === slotId) ?? slot;
		if (external(slot)) {
			setStatus(
				"This slot is already filled by another producer. Your note is kept. j moves to the next slot for you.",
			);
			return null;
		}
		for (const file of files) consumedFiles.current.add(file);
		const fill: Fill = {
			result: -Date.now(),
			by: session.actor,
			model: null,
			method,
			outcome,
			admitted: "exact",
			at: Date.now(),
			note: text || null,
			atStep: null,
			steps: null,
		};
		setLocal((value) => new Map(value).set(slot.id, { fill, pending: true, questions: [] }));
		void queryClient.cancelQueries({ queryKey: cacheKey });
		replaceSlot({
			id: slot.id,
			state: outcome === "pass" ? "satisfied" : outcome === "fail" ? "failing" : "skipped",
			fills: [...slot.fills.filter((fill) => !isOwnFill(fill)), fill],
		});
		const pinnedInput = { refs: [slot.case], version: slot.version };
		const marked = steps[slot.id] ?? "";
		// Undo records what was recorded before. A step marked since then is for the next failure: it is not
		// used here and it stays, as a note typed since then does.
		const failedStep =
			!restores && outcome === "fail" && (visibleStep || reports.consumedSteps.get(slot.id) !== marked)
				? Number(marked)
				: 0;
		if (text && text === notes[slot.id]) reports.consumedNotes.set(slot.id, text);
		if (!restores) reports.consumedSteps.set(slot.id, marked);
		const priorWrite = reports.writes.get(slot.id);
		const rollback = reports.confirmed.get(slot.id) ?? slot;
		reports.queued.set(slot.id, fill.result);
		let reopened = false;
		const request = (async () => {
			if (priorWrite) await priorWrite.catch(() => undefined);
			assertReportOwner();
			const pending = reports.uncertain.get(slot.id);
			if (pending) await pending.retry();
			const restoration = restores ? await restores : null;
			if (restoration) {
				const earlier = restoration.previous;
				outcome = earlier?.outcome === "error" ? "fail" : (earlier?.outcome ?? "skip");
				text = earlier?.note ?? "Withdrawn by the author";
			}
			assertReportOwner();
			const known = reports.confirmed.get(slot.id)?.fills.find((f) => f.by === session.actor && f.method === method);
			const recent = reports.latest.get(slot.id);
			const previous = known && (!recent || known.result > recent.result) ? known : (recent ?? null);
			if (restoration && previous?.result !== restoration.fill.result) throw new Error(changedResult);
			const cached = RunCase.safeParse(
				queryClient.getQueryData<Api["get"]["reply"]>(queryKey({ project, op: "get", input: pinnedInput }))?.[0],
			);
			const body =
				cached.success && cached.data.ref === slot.case && cached.data.version === slot.version
					? cached.data
					: RunCase.parse((await call("get", pinnedInput, { project, owner }))[0]);
			assertReportOwner();
			if (body.ref !== slot.case || body.version !== slot.version)
				throw new Error("The pinned case could not be read. Try again.");
			if (!body.methods.includes(method))
				throw new Error("This pinned case does not admit your method. Its slot needs another producer.");
			const restoredStep = restoration?.previous?.outcome === "fail" ? restoration.previous.atStep : null;
			const atStep = failedStep > 0 ? body.steps[failedStep - 1]?.id : (restoredStep ?? undefined);
			if (failedStep > 0 && !atStep) {
				clearStep(slot.id, marked);
				throw new Error(`The pinned case has no step ${failedStep}. The mark was cleared; your note is kept`);
			}
			const corrects = restoration ? restoration.fill.result : previous?.result;
			const attachments: AttachmentInput[] = files.map(({ key: _key, ...file }) => ({
				...file,
				...(atStep ? { at: atStep } : {}),
			}));
			if (restoration?.previous) {
				const result = restoration.previous.result;
				const listed = await call("attachment", { result }, { project, owner });
				if (listed.kind !== "list") throw new UnreadableReply();
				for (const item of listed.items) {
					const file = await call("attachment", { result, id: item.id }, { project, owner });
					if (file.kind !== "file") throw new UnreadableReply();
					attachments.push({ name: file.attachment.name, data: file.data, ...(item.at ? { at: item.at } : {}) });
				}
			}
			if (restoration) {
				const latestRun = Run.parse((await call("get", { refs: [runRef] }, { project, owner }))[0]);
				if (latestRun.state === "closed") {
					const approval = (await call("inbox", signoffInput, { project, owner })).items.find(
						(item) => item.decision?.effects.closed === runRef,
					);
					if (!mayReopen(approval) || !approval?.decision)
						throw new Error("Withdraw the sign-off in Queue > Settled before correcting this closed run.");
					const latestSlot = Slot.parse(
						(
							await call(
								"find",
								{ in: "slots", run: runRef, cursor: String(slot.rank - 1), limit: 1 },
								{ project, owner },
							)
						).items[0],
					);
					if (latestSlot.id !== slot.id || !latestSlot.fills.some((item) => item.result === restoration.fill.result))
						throw new Error(changedResult);
					assertReportOwner();
					setStatus("Withdrawing the automatic sign-off before correcting the result…");
					const [reply] = await call(
						"decide",
						{
							undo: approval.q,
							ifDecision: approval.decision.id,
							reason: "Correct the last cockpit result",
							projectIdentity: reports.projectIdentity,
						},
						{ project, owner },
					).catch(() => {
						throw new Error("The sign-off withdrawal was not confirmed. Check the sign-off in Queue before retrying.");
					});
					if (reply?.status !== "reopened")
						throw new Error(reply?.needs ?? "The sign-off was not withdrawn. Check Queue > Settled.");
					reopened = true;
					setStatus("Run reopened. Recording the correction…");
				}
			}
			const cmd = randomId();
			assertReportOwner();
			const input: PendingReport = {
				projectIdentity: reports.projectIdentity,
				run: runRef,
				cmd,
				results: [
					{
						test: { case: slot.case },
						outcome,
						...(text ? { note: text } : {}),
						...(attachments.length ? { attachments } : {}),
						...(atStep ? { steps: [{ step: atStep, outcome: "fail" }] } : {}),
						...(corrects !== undefined && corrects > 0 ? { corrects } : {}),
					},
				],
			};
			const complete = (receipt: ReportReceipt): RecordedResult => {
				assertReportOwner();
				reports.uncertain.delete(slot.id);
				if (receipt.rejected.length || receipt.declined?.length || !receipt.results[0])
					throw new Error(
						receipt.rejected[0]?.reason ?? receipt.declined?.[0]?.reason ?? "The result was not recorded.",
					);
				const saved = { ...fill, outcome, note: text || null, result: receipt.results[0], atStep: atStep ?? null };
				reports.latest.set(slot.id, saved);
				if (files.length) {
					for (const file of files) consumedFiles.current.delete(file);
					pendingFiles.current.set(
						slot.id,
						(pendingFiles.current.get(slot.id) ?? []).filter((file) => !files.includes(file)),
					);
					refreshFiles((value) => value + 1);
				}
				// The server has it: the device's copy of the note has done its work. A note typed for this slot while
				// the request was on its way is newer than what was recorded, and stays.
				if (storedNote(`${notePrefix}${slot.id}`) === text) setNoteOf(slot.id, "");
				if (!restores) clearStep(slot.id, marked);
				if (reports.queued.get(slot.id) === fill.result)
					setLocal((value) =>
						new Map(value).set(slot.id, { fill: saved, questions: receipt.questions, pending: false }),
					);
				setStatus(
					`${reopened ? "Run reopened. " : ""}${slot.case} ${outcome} recorded on pinned version ${slot.version}${receipt.questions[0] ? ` · ${receipt.questions[0].q}: ${receipt.questions[0].how}` : ""}.`,
				);
				void invalidateProject(project);
				return { fill: saved, previous };
			};
			let receipt: ReportReceipt;
			try {
				receipt = await call("report", input, { project, owner });
			} catch (error) {
				assertReportOwner();
				if (error instanceof ApiError && error.status !== null && error.code !== "internal") throw error;
				const reason = error instanceof Error ? error.message : "The reply could not be read.";
				const message = `${slot.case}'s outcome is unknown. ${reason}${/[.!?]$/.test(reason) ? "" : "."} Its note is kept. Press a result key on this slot to check the same request before recording another result.`;
				let checking: Promise<RecordedResult> | null = null;
				const retry = (): Promise<RecordedResult> => {
					if (checking) return checking;
					checking = (async () => {
						assertReportOwner();
						const fate = await call("command", { cmd }, { project, owner });
						assertReportOwner();
						if (fate.state !== "done")
							return complete(
								await call("report", input, { project, owner }).catch((error: unknown) => {
									if (error instanceof ApiError && error.status !== null && error.code !== "internal")
										reports.uncertain.delete(slot.id);
									throw error;
								}),
							);
						const parsed = REPLIES.report.safeParse(fate.reply);
						if (fate.op !== "report" || !parsed.success) throw new UnreadableReply();
						return complete(parsed.data);
					})().finally(() => {
						checking = null;
					});
					return checking;
				};
				reports.uncertain.set(slot.id, { message, retry });
				setStatus(`${slot.case}'s outcome is unknown. Checking the original request; your note is kept.`);
				return retry();
			}
			return complete(receipt);
		})();
		reports.writes.set(slot.id, request);
		void request.catch((error: unknown) => {
			if (!sessionCurrent(owner) || reports.retired) return;
			for (const file of files) consumedFiles.current.delete(file);
			if (reports.consumedNotes.get(slot.id) === text) reports.consumedNotes.delete(slot.id);
			if (reports.consumedSteps.get(slot.id) === marked) reports.consumedSteps.delete(slot.id);
			if (reports.writes.get(slot.id) !== request) return;
			const restored = reports.confirmed.get(slot.id) ?? rollback;
			replaceSlot(restored);
			setLocal((value) => {
				const next = new Map(value);
				next.delete(slot.id);
				return next;
			});
			setLast((value) => (value?.ready === request ? null : value));
			// The person may already be typing another note. Restore the slot without changing their selection or input.
			setStatus(
				reports.uncertain.get(slot.id)?.message ??
					`${reopened ? "Run reopened, but the correction was not recorded. " : ""}${slot.case} was not recorded: ${error instanceof Error ? error.message : "The request failed"}. Its note is kept. Return to the slot to retry.`,
			);
			void invalidateProject(project);
		});
		if (advance) {
			setCursor(next[0]?.id ?? slot.id);
			setNoting(null);
			noteRef.current?.blur();
		}
		if (!restores) setLast({ slot, outcome, ready: request });
		return request;
	}
	function startFail(): void {
		if (!current || !canRecord) return;
		if (reports.uncertain.has(current.id)) {
			record("fail");
			return;
		}
		setNoting(current);
		noteRef.current?.focus();
	}
	function undo(): void {
		if (!last || !canCorrect || withdrawn.current.has(last.ready)) return;
		const recovery = reports.uncertain.get(last.slot.id);
		if (recovery) {
			setStatus(recovery.message);
			return;
		}
		setCursor(last.slot.id);
		setNoting(null);
		noteRef.current?.blur();
		const correction = record("skip", last.slot, "Withdrawn by the author", false, false, last.ready);
		if (!correction) return;
		withdrawn.current.add(last.ready);
		void correction.then(
			() => setLast((value) => (value === last ? null : value)),
			() => withdrawn.current.delete(last.ready),
		);
	}
	const active = () => !noting;
	const bindings: Binding[] = [
		{
			key: "enter",
			label: "Record failure",
			allowInInput: true,
			hidden: !noting,
			applies: () => !!noting,
			handler: () => {
				if (noting) record("fail", noting, notes[noting.id] ?? "", true, true);
			},
		},
		{
			key: "escape",
			label: "Cancel note",
			hidden: !noting,
			applies: () => !!noting,
			handler: () => {
				setNoting(null);
				noteRef.current?.blur();
			},
		},
		...["escape", "backspace"].map((key) => ({
			key,
			label: "Clear step mark",
			handler: () => setStep(""),
			applies: () => active() && !!step,
			hidden: true,
		})),
		...(
			[
				["j", 1],
				["k", -1],
				["arrowdown", 1],
				["arrowup", -1],
			] as const
		).map(([key, delta]) => ({
			key,
			label: delta === 1 ? "Next slot" : "Previous slot",
			handler: () => move(delta),
			applies: active,
			hidden: key.startsWith("arrow"),
		})),
		...Array.from({ length: 10 }, (_, digit) => ({
			key: String(digit),
			label: `Mark step digit ${digit}`,
			handler: () => {
				if (!current) return;
				const previous = digitSequence.current;
				const append = previous.slot === current.id && performance.now() - previous.at < 600;
				setStep((value) => `${append ? value : ""}${digit}`.replace(/^0+/, ""));
				digitSequence.current = { slot: current.id, at: performance.now() };
			},
			applies: () => active() && canRecord,
			hidden: true,
		})),
		{ key: "u", label: "Correct last result", handler: undo, applies: () => active() && canCorrect },
		...outcomes.map(([key, outcome]) => ({
			key,
			label: outcome === "fail" ? "Fail and note" : outcomeName[outcome],
			hidden: !canRecord || !!noting,
			handler: () => {
				if (outcome === "fail") startFail();
				else record(outcome);
			},
			applies: () => active() && canRecord,
		})),
		...(
			[
				["t", "Claim slot", "take"],
				["r", "Release slot", "give-back"],
			] as const
		).map(([key, label, action]) => ({
			key,
			label,
			handler: () => {
				void work(action);
			},
			applies: () =>
				active() &&
				canWork &&
				!!current &&
				(action === "take" ? !held(current) && !ownsWork(current) : ownsWork(current)),
		})),
	];
	useBindings(bindings);
	const back = routeUrl({ project, screen: "runs" });
	return (
		<>
			<section className="pane run-pane" id="list">
				<div className="phead">
					<a
						className="dim"
						href={back}
						onClick={(event) => {
							event.preventDefault();
							navigate(back);
						}}
					>
						Runs
					</a>
					<span className="ref">{runRef}</span>
					<b className="run-title">{run?.name ?? "Run"}</b>
					<span className="dim">
						{slots.filter(missing).length}
						{hasNextPage ? "+" : ""} left in run ·{" "}
						{run && (run.workUntil === null || run.workUntil > now)
							? run.inProgress
							: storedSlots.filter((slot) => slot.work.kind === "held").length}{" "}
						in progress
					</span>
				</div>
				<div className="run-summary">
					<span className={`run-verdict v-${run?.verdict ?? "pending"}`}>
						{run?.reason ?? runRead.error?.message ?? "Reading the run…"}
					</span>
					<div className="dim">{run && tallyText(run.tally)}</div>
					<div className="dim">
						{run &&
							("self" in run.accepts
								? "Only this run's results count; proves nothing about a build."
								: "build" in run.accepts
									? `Accepts results for build ${run.accepts.build}${run.accepts.env ? ` in ${run.accepts.env}` : ""}.`
									: `Accepts results for ${run.location?.label ?? "commit"} (${run.accepts.commit.slice(0, 12)})${run.accepts.env ? ` in ${run.accepts.env}` : ""}.`)}
					</div>
				</div>
				<section className="run-strip" aria-label="Run progress">
					{slots.map((slot, index) => (
						<button
							type="button"
							key={slot.id}
							className={`run-dot ${slot.work.kind === "held" ? "in-progress" : ""} state-${slot.state} method-${slot.fills.at(-1)?.method ?? "none"} ${current?.id === slot.id ? "on" : ""}`}
							aria-label={`Slot ${index + 1}: ${slot.case}, ${slot.work.kind === "held" ? `in progress by ${slot.work.actor}` : slot.state}${slot.fills.at(-1) ? ` by ${slot.fills.at(-1)?.by}${slot.fills.at(-1)?.model ? ` · ${slot.fills.at(-1)?.model}` : ""}` : ""}`}
							onClick={() => {
								setCursor(slot.id);
								setNoting(null);
							}}
						/>
					))}
				</section>
				<div className="pane-scroll" role="listbox" aria-label="Run slots">
					{slots.map((slot, index) => (
						<div key={slot.id} data-slot={slot.id} data-working={slot.work.kind === "held" || undefined}>
							<ListRow
								selected={current?.id === slot.id}
								onClick={() => {
									setCursor(slot.id);
									setNoting(null);
								}}
							>
								<span className="run-number">{String(index + 1).padStart(2, "0")}</span>
								<span className="ref">{slot.case}</span>
								<span className="run-title">{slot.title}</span>
								<span className="dim mono">v{slot.version}</span>
								<span className="run-fill">
									{slot.work.kind === "held" && (
										<span className="run-working" title={`Until ${new Date(slot.work.until).toLocaleString()}`}>
											In progress · {slot.work.actor} · since {new Date(slot.work.since).toLocaleTimeString()}
										</span>
									)}
									{slot.fills.length ? (
										slot.fills.map((fill) => (
											<span
												key={fill.result}
												title={`${fill.outcome} by ${fill.by}${fill.model ? ` · ${fill.model}` : ""}, basis ${fill.admitted}`}
											>
												<ProducerGlyph kind={fill.method} />
												<span className={`outcome-${fill.outcome}`}>{fill.outcome}</span>
												<span className="fill-by">
													{fill.by}
													{fill.model && ` · ${fill.model}`}
												</span>
											</span>
										))
									) : (
										<span className="run-yours">
											{ownsWork(slot) || slot.assignee === session.actor ? "yours" : (slot.assignee ?? "Available")}
										</span>
									)}
								</span>
								{local.get(slot.id)?.questions.map((q) => (
									<a
										key={q.q}
										className="ref run-question"
										title={q.how === "new" ? q.title : `${q.how}: ${q.answer ?? q.title}`}
										href={refUrl({ project, ref: q.q })}
										onClick={(event) => {
											event.preventDefault();
											navigate(refUrl({ project, ref: q.q }));
										}}
									>
										{q.q}
									</a>
								))}
							</ListRow>
						</div>
					))}
					{!slots.length && (
						<EmptyState>
							{slotsError?.message ??
								(isPending ? "Reading pinned slots…" : "This run has no cases. Press n in Runs to plan another.")}
						</EmptyState>
					)}
					{hasNextPage && (
						<>
							<button
								className="run-more"
								type="button"
								disabled={isFetchingNextPage}
								onClick={() => void fetchNextPage()}
							>
								More slots
							</button>
							{isFetchNextPageError && <p role="alert">{slotsError?.message}</p>}
						</>
					)}
				</div>
				{next[0] && <UpNext slot={next[0]} />}
			</section>
			<section className="pane run-pane" id="detail">
				<div className="pane-scroll run-documents">
					{documents.map((slot) => (
						<RunDocument key={slot.id} slot={slot} active={current?.id === slot.id} step={step} />
					))}
					{!current && <EmptyState>Select a run slot to start.</EmptyState>}
				</div>
				<footer className="run-controls">
					{current && external(current) && (
						<div className="filled">
							{current.fills.map((fill) => (
								<span key={fill.result}>
									<ProducerGlyph kind={fill.method} /> Filled by{" "}
									{fill.method === "auto" ? "pipeline" : fill.method === "agent" ? "agent" : "person"} {fill.by}
									{fill.model && ` · ${fill.model}`} · {fill.outcome} · basis {fill.admitted}
								</span>
							))}
							<span>j skips to your next slot.</span>
						</div>
					)}
					{current && currentBody && !admittedMethod && (
						<p className="dim">
							This slot does not admit results from your method. Pipeline or agent evidence must fill it.
						</p>
					)}
					{allReported && run?.state === "open" && (
						<p className="dim">Nothing left for you to run. The server verdict is shown above.</p>
					)}
					{run?.state === "closed" && (
						<p className="dim">
							{canCorrect
								? "u reopens this run and corrects the result. "
								: "Run closed. To reopen, withdraw the sign-off in "}
							{signoff ? (
								<a
									href={refUrl({ project, ref: signoff.q })}
									onClick={(event) => {
										event.preventDefault();
										navigate(event.currentTarget.pathname);
									}}
								>
									Queue &gt; Settled
								</a>
							) : (
								"Queue > Settled. Reading the sign-off…"
							)}
						</p>
					)}
					<div className="outs">
						{outcomes.map(([key, outcome]) => (
							<button
								type="button"
								className={`out ${ownFill?.outcome === outcome || (noting && outcome === "fail") ? "on" : ""}`}
								key={key}
								disabled={!canRecord}
								onClick={() => (outcome === "fail" ? startFail() : record(outcome))}
							>
								<KeyCap>{key}</KeyCap>
								{outcomeName[outcome]}
							</button>
						))}
					</div>
					<input
						className={`run-note ${noting ? "failing" : ""}`}
						ref={noteRef}
						aria-label="Result note"
						onPaste={(event) => {
							const files = [...event.clipboardData.files];
							if (current && files.length) {
								event.preventDefault();
								void addFiles(current.id, files);
							}
						}}
						value={note}
						disabled={!canRecord && !noting && !note}
						placeholder={
							noting
								? "What did you see? Enter records the failure."
								: "Optional note. f focuses it; Enter records a failure."
						}
						onChange={(event) => {
							if (current) setNoteOf(current.id, event.target.value);
							if (!noting && current) setNoting(current);
						}}
						onKeyDown={(event) => {
							if (event.repeat && (event.key === "Enter" || event.key === "Escape")) {
								event.preventDefault();
								return;
							}
							if (event.key === "Enter" && noting) {
								event.preventDefault();
								record("fail", noting, event.currentTarget.value, true, true);
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setNoting(null);
								noteRef.current?.blur();
							}
						}}
					/>
					{current && (
						<div className="run-attachment-picker">
							<label>
								Attach a file
								<input
									type="file"
									multiple
									aria-label="Attach a file"
									disabled={!canRecord}
									onChange={(event) => {
										const files = [...(event.target.files ?? [])];
										event.target.value = "";
										void addFiles(current.id, files);
									}}
								/>
							</label>
							<span className="dim">
								Paste a screenshot into the note. 4 MiB per file, 16 MiB per result. Unrecorded files stay only on this
								page.
							</span>
							<ul>
								{(pendingFiles.current.get(current.id) ?? []).map((file) => (
									<li key={file.key}>
										{file.name}{" "}
										<button
											type="button"
											onClick={() => {
												pendingFiles.current.set(
													current.id,
													(pendingFiles.current.get(current.id) ?? []).filter((item) => item !== file),
												);
												refreshFiles((value) => value + 1);
											}}
										>
											Remove {file.name}
										</button>
									</li>
								))}
							</ul>
						</div>
					)}
					{run?.state === "open" && (
						<div className="run-control-hint">
							{step ? `Step ${step} marked. ` : ""}
							<KeyCap>2</KeyCap> <KeyCap>f</KeyCap> fails step 2.{" "}
							{ownFill && "Recording again corrects your earlier result."}
						</div>
					)}
					<div className="run-last" role="status">
						{last
							? `${last.slot.case} · ${outcomeName[last.outcome]} on pinned v${last.slot.version}`
							: "Each result records the pinned case version."}
						{canCorrect && (
							<button type="button" onClick={undo}>
								<KeyCap>u</KeyCap> correct
							</button>
						)}
					</div>
				</footer>
			</section>
		</>
	);
}

function usePinnedCase(slot: Slot | undefined) {
	const { project } = useApp();
	const read = useQueryOp({
		project,
		op: "get",
		input: { refs: [slot?.case ?? ""], version: slot?.version },
		enabled: !!slot,
	});
	const checked = RunCase.safeParse(read.data?.[0]);
	return {
		body:
			checked.success && checked.data.ref === slot?.case && checked.data.version === slot?.version
				? checked.data
				: null,
		error: read.error,
	};
}

function RunDocument({ slot, active, step }: { slot: Slot; active: boolean; step: string }) {
	const { body, error } = usePinnedCase(slot);
	return (
		<article
			hidden={!active}
			data-run-document={slot.case}
			data-active={active}
			data-ready={!!body}
			className="run-document"
		>
			<div className="run-document-meta">
				<span className="ref">{slot.case}</span>
				<span>v{slot.version}, pinned when the run started</span>
				{slot.head !== slot.version && <span className="dim">Current case is v{slot.head}</span>}
			</div>
			<h2>{body ? body.title : slot.title}</h2>
			{body ? (
				<>
					{body.pre && <p className="run-pre">{body.pre}</p>}
					<ol className="rsteps">
						{body.steps.map((entry, index) => (
							<li key={entry.id} className={Number(step) === index + 1 ? "mark" : ""} data-step={entry.id}>
								<span className="sn">{index + 1}</span>
								<div>
									{entry.action}
									{entry.source && (
										<div className="dim">
											From {entry.source.fragment} v{entry.source.version}
										</div>
									)}
									{entry.expected && <div className="rx">&gt; {entry.expected}</div>}
								</div>
							</li>
						))}
					</ol>
					{!body.steps.length && <p className="dim">This pinned case has no steps.</p>}
				</>
			) : (
				<p className="dim" role="status">
					{error?.message ?? "Reading the pinned case…"}
				</p>
			)}
			{slot.fills.map((fill) => (
				<div className="run-evidence" key={fill.result}>
					<ProducerGlyph kind={fill.method} /> {fill.outcome} by {fill.by}
					{fill.model && ` · ${fill.model}`} · basis {fill.admitted} · {age(fill.at)}
					{fill.note && <p>{fill.note}</p>}
					<ResultTrail result={fill.result} steps={fill.steps} />
					<ResultAttachments result={fill.result} />
				</div>
			))}
		</article>
	);
}
function UpNext({ slot }: { slot: Slot }) {
	const { body } = usePinnedCase(slot);
	return (
		<aside className="run-up-next" aria-label="Up next">
			<div className="sech">
				Up next <span className="ref">{slot.case}</span>
				<span className="dim">pinned v{slot.version}</span>
			</div>
			<b>{body ? body.title : slot.title}</b>
			{body && (
				<ol>
					{body.steps.slice(0, 2).map((step) => (
						<li key={step.id}>
							{step.action}
							{step.expected && <span className="rx"> &gt; {step.expected}</span>}
						</li>
					))}
				</ol>
			)}
		</aside>
	);
}
